import type { SandboxActionMode } from "./action-semantics.ts";

/** Sandbox modes that require an isolated execution world. */
export type ExecutionWorldMode = Exclude<SandboxActionMode, "none">;

export type WorldBranchState = "sealed" | "committing" | "committed" | "failed";

export interface WorldExecutionMetrics {
	/** Time spent materializing an isolated world before the tool could start. */
	readonly setupMs?: number;
	/** Time spent sealing observable persistent effects after the tool completed. */
	readonly captureMs?: number;
}

export interface WorldCommitMetrics {
	readonly durationMs: number;
	readonly validationMs: number;
	readonly bytesValidated: number;
	readonly resourcesValidated: number;
	readonly resourcesCommitted: number;
}

/** Backend-issued evidence; policy decides whether it matches the Actor world. */
export type WorldCompatibilityEvidence =
	| {
			readonly status: "compatible";
			readonly backend: string;
			readonly executionFingerprint: string;
	  }
	| {
			readonly status: "incompatible" | "indeterminate";
			readonly backend: string;
			readonly code: string;
			readonly detail?: string;
	  };

/** Immutable execution state from which a later speculative action may derive. */
export interface WorldCheckpoint {
	readonly backend: string;
	readonly id: string;
	readonly lineage: string;
	readonly depth: number;
}

/**
 * A sealed speculative execution.
 *
 * The tool output and promotable persistent effects are captured together. Ephemeral process,
 * environment, and network state never crosses the branch boundary. Commit is lossless,
 * conflict-checked, and at most once; callers may safely join the same in-progress commit.
 */
export interface WorldBranch<Output> {
	readonly output: Output;
	readonly backend: string;
	readonly checkpoint?: WorldCheckpoint;
	readonly resources: readonly string[];
	/** Captured persistent-effect bytes, excluding the serialized tool output. */
	readonly capturedBytes: number;
	readonly executionMetrics: WorldExecutionMetrics;
	readonly compatibility: WorldCompatibilityEvidence;
	readonly state: WorldBranchState;
	readonly commitMetrics?: WorldCommitMetrics;
	readonly commit: () => Promise<Output>;
}

export interface ExecutionWorldPreparation {
	readonly cwd: string;
	readonly modes: readonly ExecutionWorldMode[];
	readonly signal?: AbortSignal;
}

/** Source-independent lifecycle for isolating, sealing, and committing speculative effects. */
export interface ExecutionWorld<Context extends { readonly mode: ExecutionWorldMode }, Output> {
	readonly supports: (mode: ExecutionWorldMode) => boolean;
	/** Stable identity of the concrete isolation backend used by K(a). */
	readonly fingerprint?: (mode: ExecutionWorldMode) => string | Promise<string>;
	readonly prepare?: (input: ExecutionWorldPreparation) => Promise<void>;
	readonly fork: (context: Context) => Promise<WorldBranch<Output>>;
	readonly dispose?: () => Promise<void>;
}
