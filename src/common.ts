import { IDEMPOTENT_ACTION_TOOLS, SANDBOX_ACTION_TOOLS } from "./action-semantics.ts";

export * from "./action-semantics.ts";

export interface DrafterToolDefinition {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
}

export const DEFAULTS = {
	enabled: false,
	mode: "predict_action_single_step" as const,
	drafterEnabled: true,
	candidateLimit: 8,
	maxConcurrentActions: 8,
	/** @deprecated Use candidateLimit and maxConcurrentActions. */
	maxCandidates: 8,
	resourceCacheMaxEntries: 512,
	resourceCacheMaxBytes: 256 * 1024 * 1024,
	predictionTimeoutMs: 300_000,
	adaptiveDrafter: true,
	tools: {
		resourceCached: IDEMPOTENT_ACTION_TOOLS,
		sandbox: SANDBOX_ACTION_TOOLS,
	},
};

export function buildDrafterToolCallPrompt(candidateLimit = 1): string {
	const limit = clampCandidateLimit(candidateLimit);
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

export function clampCandidateLimit(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 1;
}

/** @deprecated Use clampCandidateLimit. */
export const clampMaxCandidates = clampCandidateLimit;

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
