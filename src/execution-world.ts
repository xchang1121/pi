import type { SandboxActionMode } from "./action-semantics.ts";

/** Sandbox modes that require an isolated execution world. */
export type ExecutionWorldMode = Exclude<SandboxActionMode, "none">;

export type WorldBranchState = "ready" | "adopting" | "adopted" | "failed";

export interface WorldExecutionMetrics {
	/** Time spent materializing an isolated world before the tool could start. */
	readonly setupMs?: number;
	/** Time spent sealing observable persistent effects after the tool completed. */
	readonly captureMs?: number;
}

export interface WorldAdoptionMetrics {
	readonly durationMs: number;
	readonly validationMs: number;
	readonly bytesValidated: number;
	readonly resourcesValidated: number;
	readonly resourcesAdopted: number;
}

/**
 * A sealed speculative execution.
 *
 * The tool output and promotable persistent effects are captured together. Ephemeral process,
 * environment, and network state never crosses the branch boundary. Adoption is lossless,
 * conflict-checked, and at most once; callers may safely join the same in-progress adoption.
 */
export interface WorldBranch<Output> {
	readonly output: Output;
	readonly backend: string;
	readonly resources: readonly string[];
	/** Captured persistent-effect bytes, excluding the serialized tool output. */
	readonly capturedBytes: number;
	readonly executionMetrics: WorldExecutionMetrics;
	readonly state: WorldBranchState;
	readonly adoptionMetrics?: WorldAdoptionMetrics;
	readonly adopt: () => Promise<Output>;
}

export interface ExecutionWorldPreparation {
	readonly cwd: string;
	readonly modes: readonly ExecutionWorldMode[];
	readonly signal?: AbortSignal;
}

/** Source-independent lifecycle for isolating, sealing, and adopting speculative effects. */
export interface ExecutionWorld<Context extends { readonly mode: ExecutionWorldMode }, Output> {
	readonly supports: (mode: ExecutionWorldMode) => boolean;
	readonly prepare?: (input: ExecutionWorldPreparation) => Promise<void>;
	readonly fork: (context: Context) => Promise<WorldBranch<Output>>;
	readonly dispose?: () => Promise<void>;
}
