import path from "node:path";

export type SpeculativeExecution = "live_readonly" | "sandbox";
export type CandidateLifetime = "turn" | "resource";

export interface ActionKey {
	readonly key: string;
	readonly hash: string;
	readonly tool: string;
	readonly resources: readonly string[];
	readonly execution: SpeculativeExecution;
}

export interface ReadActionRange {
	readonly path: string;
	readonly offset: number;
	readonly limit: number;
	readonly end: number;
}

export interface DrafterToolDefinition {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
}

export const IDEMPOTENT_ACTION_TOOLS = ["read", "grep", "find"] as const;
export const SANDBOX_ACTION_TOOLS = ["bash", "write", "edit"] as const;
export const KEYABLE_TOOLS = [...IDEMPOTENT_ACTION_TOOLS, ...SANDBOX_ACTION_TOOLS] as const;

export const DEFAULTS = {
	enabled: false,
	mode: "predict_action_single_step" as const,
	maxCandidates: 8,
	resourceCacheMaxEntries: 512,
	predictionTimeoutMs: 300_000,
	tools: {
		liveReadonly: ["read", "grep", "find"] as readonly string[],
		sandbox: ["write", "edit"] as readonly string[],
	},
};

export const READ_DEFAULT_OFFSET = 1;
export const READ_DEFAULT_LIMIT = 2000;
export const GREP_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_LIMIT = 1000;

export function buildDrafterToolCallPrompt(
	_definitions: readonly DrafterToolDefinition[],
	_candidateToolNames: readonly string[] = KEYABLE_TOOLS,
	maxCandidates = 1,
): string {
	const limit = clampMaxCandidates(maxCandidates);
	return `Dispatch tool calls only.

Rules:
- Emit tool calls only. Do not answer with prose, markdown, JSON text, XML-like markup, DSML, or code fences.
- Call 1 to ${limit} likely next tool call(s), ordered from most likely to least likely.
- Use the provider tool-call channel only.
- Use the available tools exactly as provided.
- Fill arguments according to the real tool schema. Do not invent argument names.
- Prefer the narrowest concrete action that advances the current user request.
- Do not include duplicate calls with the same tool and same arguments.
`;
}

export function clampMaxCandidates(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 1;
}

export function buildActionKey(input: {
	readonly tool: string;
	readonly execution: SpeculativeExecution;
	readonly resources: readonly string[];
	readonly input: Record<string, unknown>;
}): ActionKey {
	const key = stableStringify({ tool: input.tool, input: input.input });
	return {
		key,
		hash: fastHash(key),
		tool: input.tool,
		resources: input.resources,
		execution: input.execution,
	};
}

/** Build a conservative action key for Pi's built-in read, grep, and find tools. */
export function buildPiActionKey(tool: string, input: unknown, cwd: string): ActionKey | undefined {
	const record = asRecord(input);
	if (!record) return undefined;

	if (tool === "read") {
		if (typeof record.path !== "string") return undefined;
		const resource = normalizeWorkspacePath(record.path, cwd);
		if (resource === undefined) return undefined;
		return buildActionKey({
			tool,
			execution: "live_readonly",
			resources: [resource],
			input: {
				path: resource,
				offset: normalizeReadOffset(record.offset),
				limit: normalizeReadLimit(record.limit),
			},
		});
	}

	if (tool === "grep") {
		if (typeof record.pattern !== "string") return undefined;
		const root = normalizeRelativeRoot(record.path, cwd);
		if (root === undefined) return undefined;
		return buildActionKey({
			tool,
			execution: "live_readonly",
			resources: [root],
			input: {
				pattern: record.pattern,
				path: root,
				glob: typeof record.glob === "string" ? record.glob : undefined,
				ignoreCase: record.ignoreCase === true,
				literal: record.literal === true,
				context: normalizeNonNegativeInteger(record.context, 0),
				limit: normalizePositiveInteger(record.limit, GREP_DEFAULT_LIMIT),
			},
		});
	}

	if (tool === "find") {
		if (typeof record.pattern !== "string") return undefined;
		const root = normalizeRelativeRoot(record.path, cwd);
		if (root === undefined) return undefined;
		return buildActionKey({
			tool,
			execution: "live_readonly",
			resources: [root],
			input: {
				pattern: record.pattern,
				path: root,
				limit: normalizePositiveInteger(record.limit, FIND_DEFAULT_LIMIT),
			},
		});
	}

	if (tool === "bash") {
		if (typeof record.command !== "string") return undefined;
		const normalizedCwd = slash(path.resolve(cwd));
		return buildActionKey({
			tool,
			execution: "sandbox",
			resources: [normalizedCwd],
			input: {
				command: record.command,
				cwd: normalizedCwd,
				timeout: finiteOrUndefined(record.timeout),
			},
		});
	}

	if (tool === "write") {
		if (typeof record.path !== "string" || typeof record.content !== "string") return undefined;
		const resource = normalizeWorkspacePath(record.path, cwd);
		if (resource === undefined || resource === ".") return undefined;
		return buildActionKey({
			tool,
			execution: "sandbox",
			resources: [resource],
			input: { path: resource, content: record.content },
		});
	}

	if (tool === "edit") {
		if (typeof record.path !== "string" || !Array.isArray(record.edits) || record.edits.length === 0) {
			return undefined;
		}
		const edits: Array<{ readonly oldText: string; readonly newText: string }> = [];
		for (const value of record.edits) {
			const edit = asRecord(value);
			if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") return undefined;
			edits.push({ oldText: edit.oldText, newText: edit.newText });
		}
		const resource = normalizeWorkspacePath(record.path, cwd);
		if (resource === undefined || resource === ".") return undefined;
		return buildActionKey({
			tool,
			execution: "sandbox",
			resources: [resource],
			input: { path: resource, edits },
		});
	}

	return undefined;
}

export function actionKeyMatches(speculative: ActionKey, actor: ActionKey): boolean {
	return speculative.key === actor.key || actionKeyContains(speculative, actor);
}

export function actionKeyContains(speculative: ActionKey, actor: ActionKey): boolean {
	if (speculative.tool !== actor.tool) return false;
	if (speculative.execution !== actor.execution) return false;
	if (!sameResources(speculative.resources, actor.resources)) return false;
	if (speculative.tool !== "read") return false;
	const speculativeRange = readActionRange(speculative);
	const actorRange = readActionRange(actor);
	if (!speculativeRange || !actorRange) return false;
	if (speculativeRange.path !== actorRange.path) return false;
	return speculativeRange.offset <= actorRange.offset && speculativeRange.end >= actorRange.end;
}

export function readActionRange(action: ActionKey): ReadActionRange | undefined {
	if (action.tool !== "read") return undefined;
	const payload = actionKeyPayload(action);
	if (!payload || payload.tool !== "read") return undefined;
	const input = asRecord(payload.input);
	if (!input || typeof input.path !== "string") return undefined;
	const offset = normalizeReadOffset(input.offset);
	const limit = normalizeReadLimit(input.limit);
	return { path: input.path, offset, limit, end: offset + limit - 1 };
}

export function normalizeRelativeRoot(value: unknown, cwd: string): string | undefined {
	if (value !== undefined && typeof value !== "string") return undefined;
	return normalizeWorkspacePath(value ?? ".", cwd);
}

export function inferredExecution(tool: string): SpeculativeExecution | undefined {
	if ((IDEMPOTENT_ACTION_TOOLS as readonly string[]).includes(tool)) return "live_readonly";
	if ((SANDBOX_ACTION_TOOLS as readonly string[]).includes(tool)) return "sandbox";
	return undefined;
}

export function isIdempotentAction(tool: string): boolean {
	return (IDEMPOTENT_ACTION_TOOLS as readonly string[]).includes(tool);
}

export function isAdoptableSandboxAction(tool: string): boolean {
	return tool === "write" || tool === "edit";
}

export function isObservableSandboxAction(tool: string): boolean {
	return tool === "bash";
}

export function actionLifetime(tool: string): CandidateLifetime {
	return isIdempotentAction(tool) ? "resource" : "turn";
}

export function normalizeReadOffset(value: unknown): number {
	return normalizePositiveInteger(value, READ_DEFAULT_OFFSET);
}

export function normalizeReadLimit(value: unknown): number {
	const limit = finiteOrUndefined(value);
	return limit === undefined ? READ_DEFAULT_LIMIT : Math.max(0, Math.floor(limit));
}

export function finiteOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function slash(value: string): string {
	return value.replaceAll("\\", "/");
}

export function contains(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function usageTokenCount(
	usage:
		| {
				readonly input?: number;
				readonly output?: number;
				readonly cacheRead?: number;
				readonly cacheWrite?: number;
				readonly totalTokens?: number;
		  }
		| undefined,
): number {
	if (!usage) return 0;
	if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
	return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
		.reduce((sum, value) => sum + value, 0);
}

function normalizeWorkspacePath(value: string, cwd: string): string | undefined {
	const root = path.resolve(cwd);
	const absolute = path.resolve(root, value);
	if (!contains(root, absolute)) return undefined;
	return slash(path.relative(root, absolute) || ".");
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	const number = finiteOrUndefined(value);
	return number !== undefined && number > 0 ? Math.floor(number) : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
	const number = finiteOrUndefined(value);
	return number !== undefined && number >= 0 ? Math.floor(number) : fallback;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(stable(value));
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stable(item)]),
	);
}

function fastHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function actionKeyPayload(action: ActionKey): { readonly tool?: unknown; readonly input?: unknown } | undefined {
	try {
		return JSON.parse(action.key) as { readonly tool?: unknown; readonly input?: unknown };
	} catch {
		return undefined;
	}
}

function sameResources(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((item, index) => item === right[index]);
}
