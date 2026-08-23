import { expect, it } from "vitest";
import { type PredictionForecast, SpeculationScheduler } from "../src/scheduler.ts";

it("keeps an action-specific duration above the tool-wide estimate", () => {
	const scheduler = new SpeculationScheduler<object>();
	for (const duration of [40, 50, 60, 70]) scheduler.observeActorTiming(duration, duration * 2);
	for (const duration of [20, 40, 60, 100]) scheduler.observeService("read", duration);
	const forecast: PredictionForecast = {
		tool: "read",
		execution: "resource_snapshot",
		expectedDurationMs: 500,
		decisionBatchesUntilCall: 3,
		actorPhase: { kind: "decision", elapsedMs: 20 },
	};

	expect(scheduler.evaluate([forecast]).expectedDurationMs).toBe(500);
	expect(scheduler.launchDelay(forecast, 10)).toBe(0);
});
