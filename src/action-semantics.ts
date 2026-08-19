import path from "node:path";

export type SpeculativeExecution = "resource_cached" | "sandbox";
export type ActionReuseKind = "shared_result" | "exclusive_branch";
export type ResourceVersionPolicy = "resources" | "workspace" | "actor_time";
export type ResourceDependencyScope = "content" | "tree_entries" | "tree_query" | "tree_content";
export type SandboxActionMode = "none" | "workspace_snapshot" | "file_mutation";

export interface ReadActionRange {
	readonly path: string;
	readonly offset: number;
	readonly limit: number;
	readonly end: number;
}

export interface ActionKey {
	readonly key: string;
	readonly hash: string;
	readonly tool: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly resources: readonly string[];
	readonly execution: SpeculativeExecution;
	/** Version of the canonicalization and execution contract, independent of the input schema. */
	readonly semanticsEpoch: string;
	/** Stable hash of the validated input schema used by both producer and consumer. */
	readonly schemaHash: string;
	/** Opaque digest of the concrete executor, shell, cwd, and visible environment. */
	readonly executionFingerprint: string;
	/** In-memory execution descriptor. It is deliberately excluded from diagnostics and persisted keys. */
	readonly executionContext?: unknown;
}

export interface ProjectedActionKey {
	readonly action: ActionKey;
	/** Information discarded by the projection; lower is a more specific match. */
	readonly distance: number;
}

/** A partial projection π that can map one canonical K(a) into another. */
export interface ActionKeyProjector {
	readonly id: string;
	/** Coarse cache partition; every pair accepted by project must return the same value. */
	readonly partition: (action: ActionKey) => string | undefined;
	readonly project: (speculative: ActionKey, actor: ActionKey) => ProjectedActionKey | undefined;
	/** Whether the speculative request itself covers the actor request before output coverage is known. */
	readonly canShareInFlight?: (speculative: ActionKey, actor: ActionKey) => boolean;
}

export interface ExactActionKeyMatch {
	readonly kind: "exact";
	readonly distance: 0;
}

export interface ProjectedActionKeyMatch {
	readonly kind: "projected";
	readonly distance: number;
	readonly projector: string;
}

export type ActionKeyMatch = ExactActionKeyMatch | ProjectedActionKeyMatch;

export type ActionKeyMismatchReason =
	| "different_tool"
	| "different_execution"
	| "different_semantics"
	| "different_schema"
	| "different_executor"
	| "different_core"
	| "projection_not_applicable";

export interface CanonicalAction {
	readonly input: Readonly<Record<string, unknown>>;
	readonly resources: readonly string[];
}

export interface ActionSemanticsDefinition {
	readonly tool: string;
	readonly epoch: string;
	readonly execution: SpeculativeExecution;
	readonly reuse: ActionReuseKind;
	readonly resourceVersion: ResourceVersionPolicy;
	/** Filesystem evidence required to prove that a completed action is still current. */
	readonly resourceScope?: ResourceDependencyScope;
	readonly sandboxMode: SandboxActionMode;
	readonly canonicalize: (input: unknown, cwd: string) => CanonicalAction | undefined;
	readonly projectors?: readonly ActionKeyProjector[];
}

/** Immutable source of truth for K(a), reuse, projection, versioning, and sandbox policy. */
export class ActionSemanticsRegistry {
	private readonly definitionsByTool = new Map<string, ActionSemanticsDefinition>();
	private readonly projectorsByID = new Map<string, ActionKeyProjector>();

	constructor(definitions: readonly ActionSemanticsDefinition[]) {
		for (const source of definitions) {
			const tool = source.tool.trim();
			const epoch = source.epoch.trim();
			if (!tool) throw new Error("action semantics tool must not be empty");
			if (!epoch) throw new Error(`action semantics epoch must not be empty for ${tool}`);
			if (this.definitionsByTool.has(tool)) throw new Error(`duplicate action semantics for ${tool}`);
			assertDefinitionCoherence({ ...source, tool, epoch });
			const definition: ActionSemanticsDefinition = Object.freeze({
				...source,
				tool,
				epoch,
				projectors: Object.freeze([...(source.projectors ?? [])]),
			});
			this.definitionsByTool.set(tool, definition);
			for (const projector of definition.projectors ?? []) {
				const existing = this.projectorsByID.get(projector.id);
				if (existing && existing !== projector) {
					throw new Error(`conflicting action projector ${projector.id}`);
				}
				this.projectorsByID.set(projector.id, projector);
			}
		}
	}

	definition(tool: string): ActionSemanticsDefinition | undefined {
		return this.definitionsByTool.get(tool);
	}

	toolNames(execution?: SpeculativeExecution): readonly string[] {
		return [...this.definitionsByTool.values()]
			.filter((definition) => execution === undefined || definition.execution === execution)
			.map((definition) => definition.tool);
	}

	execution(tool: string): SpeculativeExecution | undefined {
		return this.definition(tool)?.execution;
	}

	reuse(tool: string): ActionReuseKind | undefined {
		return this.definition(tool)?.reuse;
	}

	resourceVersionPolicy(tool: string): ResourceVersionPolicy | undefined {
		return this.definition(tool)?.resourceVersion;
	}

	resourceScope(tool: string): ResourceDependencyScope | undefined {
		return this.definition(tool)?.resourceScope;
	}

	sandboxMode(tool: string): SandboxActionMode | undefined {
		return this.definition(tool)?.sandboxMode;
	}

	requiresRuntimeResourceVersion(tool: string): boolean {
		const policy = this.resourceVersionPolicy(tool);
		return policy === "resources" || policy === "workspace";
	}

	watchesResourceVersion(tool: string): boolean {
		return this.resourceVersionPolicy(tool) === "resources";
	}

	projectors(): readonly ActionKeyProjector[] {
		return [...this.projectorsByID.values()];
	}

	supportsProjector(id: string): boolean {
		return this.projectorsByID.has(id);
	}

	buildKey(
		tool: string,
		input: unknown,
		cwd: string,
		schemaHash = "",
		execution?: { readonly fingerprint: string; readonly context?: unknown },
	): ActionKey | undefined {
		const definition = this.definition(tool);
		if (!definition) return undefined;
		let canonical: CanonicalAction | undefined;
		try {
			canonical = definition.canonicalize(input, cwd);
		} catch {
			return undefined;
		}
		if (!canonical || !canonical.resources.every((resource) => typeof resource === "string")) return undefined;
		return buildActionKey({
			tool,
			execution: definition.execution,
			resources: canonical.resources,
			input: canonical.input,
			schemaHash,
			semanticsEpoch: definition.epoch,
			executionFingerprint: execution?.fingerprint,
			executionContext: execution?.context,
		});
	}
}

export const READ_DEFAULT_OFFSET = 1;
export const READ_DEFAULT_LIMIT = 2000;
export const GREP_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_LIMIT = 1000;

/** π_read narrows a cached read action to the actor's requested interval. */
export const READ_RANGE_ACTION_KEY_PROJECTOR: ActionKeyProjector = {
	id: "read.range",
	partition: readProjectionPartition,
	project: (speculative, actor) => {
		const speculativeRange = readActionRange(speculative);
		const actorRange = readActionRange(actor);
		if (!speculativeRange || !actorRange) return undefined;
		if (readProjectionPartition(speculative) !== readProjectionPartition(actor)) return undefined;
		if (
			speculativeRange.limit === 0 ||
			speculativeRange.offset > actorRange.offset ||
			actorRange.offset > speculativeRange.end + 1
		) {
			return undefined;
		}
		return {
			action: actor,
			distance: actorRange.offset - speculativeRange.offset + Math.abs(speculativeRange.end - actorRange.end),
		};
	},
	canShareInFlight: readRangesShareInFlight,
};

export const PI_ACTION_SEMANTICS = new ActionSemanticsRegistry([
	{
		tool: "read",
		epoch: "pi.read.v2",
		execution: "resource_cached",
		reuse: "shared_result",
		resourceVersion: "resources",
		resourceScope: "content",
		sandboxMode: "none",
		canonicalize: canonicalRead,
		projectors: [READ_RANGE_ACTION_KEY_PROJECTOR],
	},
	{
		tool: "grep",
		epoch: "pi.grep.v2",
		execution: "resource_cached",
		reuse: "shared_result",
		resourceVersion: "resources",
		resourceScope: "tree_content",
		sandboxMode: "none",
		canonicalize: canonicalGrep,
	},
	{
		tool: "find",
		epoch: "pi.find.v2",
		execution: "resource_cached",
		reuse: "shared_result",
		resourceVersion: "resources",
		resourceScope: "tree_query",
		sandboxMode: "none",
		canonicalize: canonicalFind,
	},
	{
		tool: "bash",
		epoch: "pi.bash.v1",
		execution: "sandbox",
		reuse: "exclusive_branch",
		resourceVersion: "workspace",
		resourceScope: "tree_content",
		sandboxMode: "workspace_snapshot",
		canonicalize: canonicalBash,
	},
	{
		tool: "write",
		epoch: "pi.write.v1",
		execution: "sandbox",
		reuse: "exclusive_branch",
		resourceVersion: "actor_time",
		sandboxMode: "file_mutation",
		canonicalize: canonicalWrite,
	},
	{
		tool: "edit",
		epoch: "pi.edit.v1",
		execution: "sandbox",
		reuse: "exclusive_branch",
		resourceVersion: "actor_time",
		sandboxMode: "file_mutation",
		canonicalize: canonicalEdit,
	},
]);

export const IDEMPOTENT_ACTION_TOOLS = Object.freeze(PI_ACTION_SEMANTICS.toolNames("resource_cached"));
export const SANDBOX_ACTION_TOOLS = Object.freeze(PI_ACTION_SEMANTICS.toolNames("sandbox"));
export const KEYABLE_TOOLS = Object.freeze(PI_ACTION_SEMANTICS.toolNames());

export function buildActionKey(input: {
	readonly tool: string;
	readonly execution: SpeculativeExecution;
	readonly resources: readonly string[];
	readonly input: Readonly<Record<string, unknown>>;
	readonly schemaHash?: string;
	readonly semanticsEpoch?: string;
	readonly executionFingerprint?: string;
	readonly executionContext?: unknown;
}): ActionKey {
	const schemaHash = input.schemaHash ?? "";
	const semanticsEpoch = input.semanticsEpoch ?? "";
	const executionFingerprint = input.executionFingerprint ?? "";
	const canonicalInput = freezeCanonicalValue(structuredClone(input.input));
	const key = stableStringify({
		tool: input.tool,
		execution: input.execution,
		semanticsEpoch,
		schemaHash,
		executionFingerprint,
		input: canonicalInput,
	});
	return Object.freeze({
		key,
		hash: fastHash(key),
		tool: input.tool,
		input: canonicalInput,
		resources: Object.freeze([...input.resources]),
		execution: input.execution,
		semanticsEpoch,
		schemaHash,
		executionFingerprint,
		...(input.executionContext !== undefined ? { executionContext: input.executionContext } : {}),
	});
}

function freezeCanonicalValue<Value>(value: Value, seen = new WeakSet<object>()): Value {
	if (!value || typeof value !== "object" || Object.isFrozen(value) || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) freezeCanonicalValue(child, seen);
	return Object.freeze(value);
}

/** Build K(a) from the default Pi action semantics registry. */
export function buildPiActionKey(tool: string, input: unknown, cwd: string, schemaHash = ""): ActionKey | undefined {
	return PI_ACTION_SEMANTICS.buildKey(tool, input, cwd, schemaHash);
}

export function actionKeyMatches(
	speculative: ActionKey,
	actor: ActionKey,
	projectors: readonly ActionKeyProjector[] = [],
): boolean {
	return actionKeyMatch(speculative, actor, projectors) !== undefined;
}

export function actionKeyProjects(
	speculative: ActionKey,
	actor: ActionKey,
	projectors: readonly ActionKeyProjector[],
): boolean {
	return actionKeyMatch(speculative, actor, projectors)?.kind === "projected";
}

/** K(a_s) covers K(a) without relying on completed-output coverage. */
export function actionKeyCovers(
	speculative: ActionKey,
	actor: ActionKey,
	projectors: readonly ActionKeyProjector[] = [],
): boolean {
	const match = actionKeyMatch(speculative, actor, projectors);
	if (!match) return false;
	if (match.kind === "exact") return true;
	const projector = projectors.find((candidate) => candidate.id === match.projector);
	if (!projector?.canShareInFlight) return false;
	try {
		return projector.canShareInFlight(speculative, actor);
	} catch {
		return false;
	}
}

/** K(a_s) can satisfy K(a) exactly, or when some π maps K(a_s) to K(a). */
export function actionKeyMatch(
	speculative: ActionKey,
	actor: ActionKey,
	projectors: readonly ActionKeyProjector[] = [],
): ActionKeyMatch | undefined {
	if (speculative.key === actor.key) return { kind: "exact", distance: 0 };
	let best: ActionKeyMatch | undefined;
	for (const projector of projectors) {
		let projected: ProjectedActionKey | undefined;
		try {
			projected = projector.project(speculative, actor);
		} catch {
			continue;
		}
		if (!projected || projected.action.key !== actor.key) continue;
		if (!Number.isFinite(projected.distance) || projected.distance < 0) continue;
		if (best && best.distance <= projected.distance) continue;
		best = { kind: "projected", projector: projector.id, distance: projected.distance };
	}
	return best;
}

/** Explain why K(a_s) cannot satisfy K(a) without exposing either action's input. */
export function actionKeyMismatchReason(
	speculative: ActionKey,
	actor: ActionKey,
	projectors: readonly ActionKeyProjector[] = [],
): ActionKeyMismatchReason | undefined {
	if (actionKeyMatch(speculative, actor, projectors)) return undefined;
	if (speculative.tool !== actor.tool) return "different_tool";
	if (speculative.execution !== actor.execution) return "different_execution";
	if (speculative.semanticsEpoch !== actor.semanticsEpoch) return "different_semantics";
	if (speculative.schemaHash !== actor.schemaHash) return "different_schema";
	if (speculative.executionFingerprint !== actor.executionFingerprint) return "different_executor";

	const speculativePartitions = new Set(actionKeyProjectionPartitions(speculative, projectors));
	if (actionKeyProjectionPartitions(actor, projectors).some((partition) => speculativePartitions.has(partition))) {
		return "projection_not_applicable";
	}
	return "different_core";
}

/** Projection partitions used only as an indexed lookup optimization. */
export function actionKeyProjectionPartitions(
	action: ActionKey,
	projectors: readonly ActionKeyProjector[],
): readonly string[] {
	const partitions = new Set<string>();
	for (const projector of projectors) {
		let partition: string | undefined;
		try {
			partition = projector.partition(action);
		} catch {
			continue;
		}
		if (partition !== undefined) partitions.add(JSON.stringify([projector.id, partition]));
	}
	return [...partitions];
}

export function readActionRange(action: ActionKey): ReadActionRange | undefined {
	if (action.tool !== "read") return undefined;
	const input = asRecord(action.input);
	if (!input || typeof input.path !== "string") return undefined;
	const offset = normalizeReadOffset(input.offset);
	const limit = normalizeReadLimit(input.limit);
	return { path: input.path, offset, limit, end: offset + limit - 1 };
}

export function readRangesShareInFlight(speculative: ActionKey, actor: ActionKey): boolean {
	const speculativeRange = readActionRange(speculative);
	const actorRange = readActionRange(actor);
	return (
		!!speculativeRange &&
		!!actorRange &&
		!(actor.input.limit === undefined && speculative.input.limit !== undefined) &&
		readProjectionPartition(speculative) === readProjectionPartition(actor) &&
		speculativeRange.offset <= actorRange.offset &&
		speculativeRange.end >= actorRange.end
	);
}

export function normalizeRelativeRoot(value: unknown, cwd: string): string | undefined {
	if (value !== undefined && typeof value !== "string") return undefined;
	return normalizeWorkspacePath(value ?? ".", cwd);
}

export function inferredExecution(tool: string): SpeculativeExecution | undefined {
	return PI_ACTION_SEMANTICS.execution(tool);
}

export function isIdempotentAction(tool: string): boolean {
	return PI_ACTION_SEMANTICS.reuse(tool) === "shared_result";
}

export function isAdoptableSandboxAction(tool: string): boolean {
	return PI_ACTION_SEMANTICS.sandboxMode(tool) === "file_mutation";
}

export function isObservableSandboxAction(tool: string): boolean {
	return PI_ACTION_SEMANTICS.sandboxMode(tool) === "workspace_snapshot";
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

function canonicalRead(input: unknown, cwd: string): CanonicalAction | undefined {
	const record = asRecord(input);
	if (!record || typeof record.path !== "string") return undefined;
	if (!validOptionalInteger(record.offset, 1) || !validOptionalInteger(record.limit, 0)) {
		return undefined;
	}
	const resource = normalizeWorkspacePath(record.path, cwd);
	if (resource === undefined) return undefined;
	return {
		resources: [resource],
		input: {
			path: resource,
			offset: normalizeReadOffset(record.offset),
			...(record.limit !== undefined ? { limit: normalizeReadLimit(record.limit) } : {}),
		},
	};
}

function canonicalGrep(input: unknown, cwd: string): CanonicalAction | undefined {
	const record = asRecord(input);
	if (!record || typeof record.pattern !== "string") return undefined;
	if (!validOptionalInteger(record.context, 0) || !validOptionalInteger(record.limit, 1)) return undefined;
	const root = normalizeRelativeRoot(record.path, cwd);
	if (root === undefined) return undefined;
	return {
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
	};
}

function canonicalFind(input: unknown, cwd: string): CanonicalAction | undefined {
	const record = asRecord(input);
	if (!record || typeof record.pattern !== "string") return undefined;
	if (!validOptionalInteger(record.limit, 1)) return undefined;
	const root = normalizeRelativeRoot(record.path, cwd);
	if (root === undefined) return undefined;
	return {
		resources: [root],
		input: {
			pattern: record.pattern,
			path: root,
			limit: normalizePositiveInteger(record.limit, FIND_DEFAULT_LIMIT),
		},
	};
}

function canonicalBash(input: unknown, cwd: string): CanonicalAction | undefined {
	const record = asRecord(input);
	if (!record || typeof record.command !== "string") return undefined;
	const normalizedCwd = slash(path.resolve(cwd));
	return {
		resources: [normalizedCwd],
		input: {
			command: record.command,
			cwd: normalizedCwd,
			timeout: finiteOrUndefined(record.timeout),
		},
	};
}

function canonicalWrite(input: unknown, cwd: string): CanonicalAction | undefined {
	const record = asRecord(input);
	if (!record || typeof record.path !== "string" || typeof record.content !== "string") return undefined;
	const resource = normalizeWorkspacePath(record.path, cwd);
	if (resource === undefined || resource === ".") return undefined;
	return { resources: [resource], input: { path: resource, content: record.content } };
}

function canonicalEdit(input: unknown, cwd: string): CanonicalAction | undefined {
	const record = asRecord(input);
	if (!record || typeof record.path !== "string" || !Array.isArray(record.edits) || record.edits.length === 0) {
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
	return { resources: [resource], input: { path: resource, edits } };
}

function readProjectionPartition(action: ActionKey): string | undefined {
	const range = readActionRange(action);
	if (!range) return undefined;
	return JSON.stringify([
		action.execution,
		action.semanticsEpoch,
		action.schemaHash,
		action.executionFingerprint,
		action.resources,
		range.path,
	]);
}

function assertDefinitionCoherence(definition: ActionSemanticsDefinition): void {
	if (definition.execution === "resource_cached") {
		if (definition.reuse !== "shared_result") {
			throw new Error(`resource-cached action ${definition.tool} must use shared_result reuse`);
		}
		if (
			definition.resourceVersion !== "resources" ||
			definition.resourceScope === undefined ||
			definition.sandboxMode !== "none"
		) {
			throw new Error(`resource-cached action ${definition.tool} has incoherent version or sandbox policy`);
		}
		return;
	}
	if (definition.reuse !== "exclusive_branch") {
		throw new Error(`sandbox action ${definition.tool} must use exclusive_branch reuse`);
	}
	if (
		(definition.resourceVersion === "workspace" &&
			(definition.resourceScope !== "tree_content" || definition.sandboxMode !== "workspace_snapshot")) ||
		(definition.resourceVersion === "actor_time" &&
			(definition.resourceScope !== undefined || definition.sandboxMode !== "file_mutation")) ||
		definition.resourceVersion === "resources"
	) {
		throw new Error(`sandbox action ${definition.tool} has incoherent version or sandbox policy`);
	}
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

function validOptionalInteger(value: unknown, minimum: number): boolean {
	return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);
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
