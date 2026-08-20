import { describe, expect, it } from "vitest";
import { type SuiteBenchmarkRun, summarizeSuite } from "../bench/suite-report.ts";

describe("ablation suite report", () => {
	it("pools only completed patch candidates and exposes every screening failure", () => {
		const report = summarizeSuite([
			run("task-a", 1, {
				actualEndToEndMs: 100,
				serializedCounterfactualMs: 120,
				actorActions: 10,
				speculativeHits: 2,
			}),
			run("task-b", 1, {
				actualEndToEndMs: 300,
				serializedCounterfactualMs: 330,
				actorActions: 30,
				speculativeHits: 3,
			}),
			run("task-b", 2, {
				patchCandidate: false,
				timedOut: true,
				patchClean: false,
				changedFiles: [],
				coveredGoldFiles: [],
			}),
		]);

		expect(report).toMatchObject({
			runs: 3,
			patchCandidates: 2,
			allRunsScreenedIn: false,
			implementationCommits: ["commit"],
			pooled: {
				runs: 2,
				actualEndToEndMs: 400,
				serializedCounterfactualMs: 450,
				accelerationRatio: 1.125,
				actorActions: 40,
				speculativeHits: 5,
				hitRate: 0.125,
			},
			byInstance: {
				"task-a": { runs: 1, accelerationRatio: 1.2, hitRate: 0.2 },
				"task-b": { runs: 1, accelerationRatio: 1.1, hitRate: 0.1 },
			},
		});
		expect(report.invalidRuns).toEqual([
			{
				instance: "task-b",
				repeat: 2,
				output: "task-b-2.json",
				reasons: ["timed_out", "patch_not_clean", "no_changed_files", "no_gold_file_overlap"],
			},
		]);
	});
});

function run(instance: string, repeat: number, overrides: Partial<SuiteBenchmarkRun["summary"]>): SuiteBenchmarkRun {
	return {
		instance,
		repeat,
		output: `${instance}-${repeat}.json`,
		implementationCommit: "commit",
		summary: {
			actualEndToEndMs: 1,
			serializedCounterfactualMs: 1,
			hiddenLatencyMs: 0,
			executionAheadMs: 0,
			actorActions: 1,
			speculativeHits: 0,
			actorCost: 0,
			drafterCost: 0,
			patchCandidate: true,
			timedOut: false,
			turnLimitReached: false,
			patchClean: true,
			changedFiles: ["src/file.ts"],
			coveredGoldFiles: ["src/file.ts"],
			...overrides,
		},
	};
}
