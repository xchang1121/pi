import { IDEMPOTENT_ACTION_TOOLS, SANDBOX_ACTION_TOOLS } from "./action-semantics.ts";

export interface DrafterToolDefinition {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
}

export const DEFAULTS = {
	enabled: false,
	drafterEnabled: true,
	drafterMaxDepth: 0,
	candidateLimit: 8,
	maxConcurrentActions: 8,
	resourceCacheMaxEntries: 512,
	resourceCacheMaxBytes: 256 * 1024 * 1024,
	predictionTimeoutMs: 300_000,
	tools: {
		resourceCached: IDEMPOTENT_ACTION_TOOLS,
		sandbox: SANDBOX_ACTION_TOOLS,
	},
};

export function buildSingleToolCallPrompt(): string {
	return `Continue the conversation as the assistant by making exactly one tool call now.

Rules:
- Emit tool calls only. Do not answer with prose, markdown, JSON text, XML-like markup, DSML, or code fences.
- Make exactly one tool call. Do not emit parallel or sequential tool calls.
- Use the provider tool-call channel only.
- Use the available tools exactly as provided.
- Fill arguments according to the real tool schema. Do not invent argument names.
- Prefer the narrowest concrete action that advances the current user request.
`;
}

export function clampCandidateLimit(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 1;
}

export function clampDrafterDepth(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.min(4, Math.floor(value)))
		: DEFAULTS.drafterMaxDepth;
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
