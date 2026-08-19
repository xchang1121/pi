import { describe, expect, it } from "vitest";
import { measureSpeculativeTask } from "../src/task-timing.ts";

describe("single-run serialized counterfactual timing", () => {
	it("equals actual E2E when Actor phases and tools are already serial", () => {
		expect(
			measureSpeculativeTask({
				startedAt: 0,
				completedAt: 300,
				actorPhases: [interval(0, 100), interval(200, 300)],
				authoritativeTools: [interval(100, 200)],
			}),
		).toMatchObject({
			endToEndMs: 300,
			nonToolMs: 200,
			toolExecutionMs: 100,
			serializedMs: 300,
			hiddenLatencyMs: 0,
		});
	});

	it("adds a tool's full service time when it overlaps Actor generation", () => {
		expect(
			measureSpeculativeTask({
				startedAt: 0,
				completedAt: 100,
				actorPhases: [interval(0, 100)],
				authoritativeTools: [interval(10, 60)],
			}),
		).toMatchObject({
			endToEndMs: 100,
			nonToolMs: 100,
			toolExecutionMs: 50,
			serializedMs: 150,
			hiddenLatencyMs: 50,
		});
	});

	it("serializes overlapping tools independently and retains uncovered orchestration", () => {
		expect(
			measureSpeculativeTask({
				startedAt: 0,
				completedAt: 200,
				actorPhases: [interval(10, 90)],
				authoritativeTools: [interval(40, 120), interval(70, 150)],
			}),
		).toMatchObject({
			endToEndMs: 200,
			actorPhaseMs: 80,
			orchestrationMs: 60,
			nonToolMs: 140,
			toolExecutionMs: 160,
			serializedMs: 300,
			hiddenLatencyMs: 100,
			authoritativeToolCount: 2,
		});
	});

	it("counts a previously cached adopted result as avoided current-task tool service", () => {
		expect(
			measureSpeculativeTask({
				startedAt: 100,
				completedAt: 200,
				actorPhases: [interval(100, 200)],
				authoritativeTools: [interval(20, 70)],
			}),
		).toMatchObject({ endToEndMs: 100, serializedMs: 150, hiddenLatencyMs: 50 });
	});

	it("clips and unions Actor phases at the measured task boundary", () => {
		expect(
			measureSpeculativeTask({
				startedAt: 100,
				completedAt: 200,
				actorPhases: [interval(50, 160), interval(140, 250)],
				authoritativeTools: [],
			}),
		).toMatchObject({ endToEndMs: 100, actorPhaseMs: 100, nonToolMs: 100, hiddenLatencyMs: 0 });
	});
});

function interval(startedAt: number, completedAt: number) {
	return { startedAt, completedAt };
}
