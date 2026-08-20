import type { ActionReuseKind, LocalIsolationMechanism, SpeculativeExecution } from "./action-semantics.ts";
import type { ResourceValidation } from "./settlement.ts";

/** A runtime sandbox can handle every tool; local worlds expose narrower substitutes. */
export type ExecutionWorldMode = SpeculativeExecution;

/** One resolved execution capability. Absence of a route means speculation is blocked. */
export interface SpeculativeExecutionRoute {
	readonly isolation: SpeculativeExecution;
	readonly reuse: ActionReuseKind;
	readonly backend: string;
	readonly fingerprint: string;
	/** Opaque in-memory backend state; never enters K(a), persistence, or diagnostics. */
	readonly context?: unknown;
}

/** Opaque context is intentionally excluded; backend and fingerprint own route identity. */
export function sameSpeculativeExecutionRoute(
	left: SpeculativeExecutionRoute,
	right: SpeculativeExecutionRoute,
): boolean {
	return (
		left.isolation === right.isolation &&
		left.reuse === right.reuse &&
		left.backend === right.backend &&
		left.fingerprint === right.fingerprint
	);
}

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
	/** Optional freshness proof owned by the backend that captured the branch. */
	readonly validate?: () => Promise<ResourceValidation>;
	/** Subscribe to invalidation; the branch owns and releases the subscription. */
	readonly watch?: (onInvalidated: (changedPath?: string) => void) => void;
	readonly commit: () => Promise<Output>;
	/** Idempotently release every branch-local handle. Must be safe before or after commit. */
	readonly dispose: () => void | Promise<void>;
}

export interface ExecutionWorldPreparation {
	readonly cwd: string;
	readonly modes: readonly ExecutionWorldMode[];
	readonly signal?: AbortSignal;
}

/** Source-independent lifecycle for isolating, sealing, and committing speculative effects. */
export interface ExecutionWorld<Context extends { readonly mode: ExecutionWorldMode }, Output> {
	readonly id: string;
	readonly supports: (mode: ExecutionWorldMode) => boolean;
	/** Stable identity of the concrete isolation backend used for route-local reuse. */
	readonly fingerprint?: (mode: ExecutionWorldMode) => string | Promise<string>;
	readonly prepare?: (input: ExecutionWorldPreparation) => Promise<void>;
	readonly fork: (context: Context) => Promise<WorldBranch<Output>>;
	/** Abort and drain backend-owned forks and branch cleanup before resolving. */
	readonly dispose?: () => Promise<void>;
}

/** Resolve one tool through the uniform isolation priority shared by every prediction source. */
export async function resolveSpeculativeExecutionRoute<Context extends { readonly mode: ExecutionWorldMode }, Output>(
	localIsolation: LocalIsolationMechanism,
	worlds: readonly ExecutionWorld<Context, Output>[],
): Promise<SpeculativeExecutionRoute | undefined> {
	const runtimeRoute = await firstWorldRoute(
		worlds,
		"runtime_sandbox",
		localIsolation === "resource_snapshot" ? "shared_result" : "exclusive_branch",
	);
	if (runtimeRoute) return runtimeRoute;
	if (localIsolation === "none") return undefined;
	return firstWorldRoute(
		worlds,
		localIsolation,
		localIsolation === "resource_snapshot" ? "shared_result" : "exclusive_branch",
	);
}

async function firstWorldRoute<Context extends { readonly mode: ExecutionWorldMode }, Output>(
	worlds: readonly ExecutionWorld<Context, Output>[],
	mode: ExecutionWorldMode,
	reuse: ActionReuseKind,
): Promise<SpeculativeExecutionRoute | undefined> {
	for (const world of worlds) {
		try {
			if (world.supports(mode)) return await executionWorldRoute(world, mode, reuse);
		} catch {
			// A broken capability is unavailable; a later world or local fallback may still be safe.
		}
	}
	return undefined;
}

async function executionWorldRoute<Context extends { readonly mode: ExecutionWorldMode }, Output>(
	world: ExecutionWorld<Context, Output>,
	mode: ExecutionWorldMode,
	reuse: ActionReuseKind,
): Promise<SpeculativeExecutionRoute> {
	const fingerprint = (await world.fingerprint?.(mode)) ?? `${world.id}:${mode}`;
	return Object.freeze({
		isolation: mode,
		reuse,
		backend: world.id,
		fingerprint,
		context: world,
	});
}
