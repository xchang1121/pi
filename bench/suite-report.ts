export interface SuiteBenchmarkSummary {
	readonly actualEndToEndMs: number;
	readonly serializedCounterfactualMs: number;
	readonly hiddenLatencyMs: number;
	readonly executionAheadMs: number;
	readonly actorActions: number;
	readonly speculativeHits: number;
	readonly actorCost: number;
	readonly drafterCost: number;
	readonly patchCandidate: boolean;
	readonly timedOut: boolean;
	readonly turnLimitReached: boolean;
	readonly agentError?: string;
	readonly patchClean: boolean;
	readonly changedFiles: readonly string[];
	readonly coveredGoldFiles: readonly string[];
}

export interface SuiteBenchmarkRun {
	readonly instance: string;
	readonly repeat: number;
	readonly output: string;
	readonly implementationCommit: string;
	readonly summary: SuiteBenchmarkSummary;
}

export function summarizeSuite(runs: readonly SuiteBenchmarkRun[]) {
	const accepted = runs.filter((run) => run.summary.patchCandidate);
	return {
		runs: runs.length,
		patchCandidates: accepted.length,
		allRunsScreenedIn: runs.length > 0 && accepted.length === runs.length,
		implementationCommits: [...new Set(runs.map((run) => run.implementationCommit))],
		invalidRuns: runs
			.filter((run) => !run.summary.patchCandidate)
			.map((run) => ({
				instance: run.instance,
				repeat: run.repeat,
				output: run.output,
				reasons: screeningFailures(run.summary),
			})),
		pooled: accepted.length ? pooled(accepted) : undefined,
		byInstance: Object.fromEntries(
			[...new Set(runs.map((run) => run.instance))].map((instance) => {
				const values = accepted.filter((run) => run.instance === instance);
				return [instance, values.length ? pooled(values) : null];
			}),
		),
	};
}

function pooled(runs: readonly SuiteBenchmarkRun[]) {
	const actualEndToEndMs = sum(runs, "actualEndToEndMs");
	const serializedCounterfactualMs = sum(runs, "serializedCounterfactualMs");
	const actorActions = sum(runs, "actorActions");
	const speculativeHits = sum(runs, "speculativeHits");
	return {
		runs: runs.length,
		actualEndToEndMs,
		serializedCounterfactualMs,
		accelerationRatio: actualEndToEndMs > 0 ? serializedCounterfactualMs / actualEndToEndMs : 1,
		hiddenLatencyMs: sum(runs, "hiddenLatencyMs"),
		executionAheadMs: sum(runs, "executionAheadMs"),
		actorActions,
		speculativeHits,
		hitRate: actorActions > 0 ? speculativeHits / actorActions : 0,
		actorCost: sum(runs, "actorCost"),
		drafterCost: sum(runs, "drafterCost"),
	};
}

function sum(runs: readonly SuiteBenchmarkRun[], key: NumericSummaryKey): number {
	return runs.reduce((total, run) => total + run.summary[key], 0);
}

type NumericSummaryKey = {
	[Key in keyof SuiteBenchmarkSummary]-?: SuiteBenchmarkSummary[Key] extends number ? Key : never;
}[keyof SuiteBenchmarkSummary];

function screeningFailures(summary: SuiteBenchmarkSummary): string[] {
	const reasons = [
		summary.timedOut ? "timed_out" : undefined,
		summary.turnLimitReached ? "turn_limit_reached" : undefined,
		summary.agentError ? "agent_error" : undefined,
		!summary.patchClean ? "patch_not_clean" : undefined,
		!summary.changedFiles.length ? "no_changed_files" : undefined,
		!summary.coveredGoldFiles.length ? "no_gold_file_overlap" : undefined,
	].filter((reason): reason is string => reason !== undefined);
	return reasons.length ? reasons : ["patch_candidate_false"];
}
