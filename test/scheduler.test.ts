import { describe, expect, it } from "vitest";
import { type PredictionForecast, SpeculationScheduler } from "../src/scheduler.ts";

describe("SpeculationScheduler", () => {
	it("does not evict foreground work during ordinary admission", () => {
		const scheduler = new SpeculationScheduler<object>();
		const first = {};
		const second = {};
		expect(scheduler.admit(first, [forecast()], 1).admitted).toBe(true);
		expect(scheduler.admit(second, [forecast({ expectedDurationMs: 500 })], 1)).toMatchObject({
			admitted: false,
			reason: "budget_exhausted",
		});
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([first]);
	});

	it("merges duplicate K(a) forecasts without source-count inflation", () => {
		const scheduler = new SpeculationScheduler<object>();
		const one = scheduler.evaluate([
			forecast({ expectedDurationMs: 100, decisionBatchesUntilCall: 3, criticalPathMs: 120 }),
		]);
		const duplicate = scheduler.evaluate([
			forecast({ expectedDurationMs: 100, decisionBatchesUntilCall: 3, criticalPathMs: 120 }),
			forecast({ expectedDurationMs: 80, decisionBatchesUntilCall: 4, criticalPathMs: 100 }),
		]);
		expect(duplicate).toEqual(one);
	});

	it("separates the current Actor decision from later tool cycles", () => {
		const scheduler = new SpeculationScheduler<object>();
		scheduler.observeActorTiming(40, 80);
		scheduler.observeActorTiming(50, 100);
		scheduler.observeActorTiming(60, 120);
		scheduler.observeActorTiming(70, 200);
		for (const duration of [20, 40, 60, 100]) scheduler.observeService("read", duration);
		expect(
			scheduler.launchDelay(
				forecast({
					decisionBatchesUntilCall: 3,
					actorPhase: { kind: "decision", elapsedMs: 20 },
					expectedDurationMs: 40,
				}),
				10,
			),
		).toBe(110);
		expect(
			scheduler.launchDelay(
				forecast({ decisionBatchesUntilCall: 3, actorPhase: { kind: "cycle", elapsedMs: 20 } }),
				10,
			),
		).toBe(150);
		expect(scheduler.launchDelay(forecast({ decisionBatchesUntilCall: 3 }), 10)).toBe(170);
		expect(
			scheduler.launchDelay(forecast({ decisionBatchesUntilCall: 3, dependenciesResolved: true }), 10),
		).toBe(0);
		expect(scheduler.launchDelay(forecast({ decisionBatchesUntilCall: 1 }))).toBe(0);
	});

	it("prioritizes explicit expected latency benefit without requiring it from every source", () => {
		const scheduler = new SpeculationScheduler<object>();
		const unlikelyLong = {};
		const likelyShort = {};
		scheduler.admit(unlikelyLong, [forecast({ expectedDurationMs: 500, expectedLatencyBenefitMs: 10 })], 2);
		scheduler.admit(likelyShort, [forecast({ expectedDurationMs: 50, expectedLatencyBenefitMs: 40 })], 2);

		expect(scheduler.preemptFor({ class: "filesystem", units: 1 }, 2)).toEqual([unlikelyLong]);
		expect(scheduler.evaluate([forecast({ expectedDurationMs: 50 })])).toMatchObject({
			criticalPathMs: 50,
			priorityMs: 50,
		});
	});

	it("caps expected benefit by observed Actor runway without inventing cold-start timing", () => {
		const scheduler = new SpeculationScheduler<object>();
		const long = forecast({
			expectedDurationMs: 1_000,
			expectedLatencyBenefitMs: 240,
			actorPhase: { kind: "decision", elapsedMs: 0 },
		});
		expect(scheduler.evaluate([long]).priorityMs).toBe(240);

		scheduler.observeActorTiming(20);
		scheduler.observeService("read", 10);
		const short = forecast({
			expectedDurationMs: 80,
			expectedLatencyBenefitMs: 40,
			actorPhase: { kind: "decision", elapsedMs: 0 },
		});
		expect(scheduler.evaluate([long]).priorityMs).toBeCloseTo(4.8);
		expect(scheduler.evaluate([short]).priorityMs).toBe(10);
		expect(scheduler.evaluate([{ ...short, actorPhase: { kind: "cycle", elapsedMs: 500 } }]).priorityMs).toBe(10);
		const { actorPhase: _, ...withoutPhase } = long;
		expect(scheduler.evaluate([withoutPhase]).priorityMs).toBe(240);
	});

	it("promotes shared work on foreground evidence and lets background work yield", () => {
		const scheduler = new SpeculationScheduler<object>();
		expect(scheduler.evaluate([forecast({ background: true }), forecast({ background: true })]).background).toBe(
			true,
		);
		expect(scheduler.evaluate([forecast({ background: true }), forecast()]).background).toBe(false);

		const foreground = {};
		const background = {};
		scheduler.admit(foreground, [forecast({ expectedLatencyBenefitMs: 1 })], 2);
		scheduler.admit(background, [forecast({ background: true, expectedLatencyBenefitMs: 1_000 })], 2);
		expect(scheduler.preemptFor({ class: "filesystem", units: 1 }, 2, (job) => job === background)).toEqual([background]);
	});

	it("preempts the latest and least critical work for an authoritative action", () => {
		const scheduler = new SpeculationScheduler<object>();
		const nearCritical = {};
		const farNoncritical = {};
		scheduler.admit(nearCritical, [forecast({ decisionBatchesUntilCall: 1, criticalPathMs: 500 })], 2);
		scheduler.admit(farNoncritical, [forecast({ decisionBatchesUntilCall: 4, criticalPathMs: 10 })], 2);
		expect(scheduler.preemptFor({ class: "filesystem", units: 1 }, 2)).toEqual([farNoncritical]);
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([nearCritical]);
	});

	it("does not preempt a candidate already joined by an Actor", () => {
		const scheduler = new SpeculationScheduler<object>();
		const joined = {};
		const idle = {};
		scheduler.admit(joined, [forecast({ decisionBatchesUntilCall: 5 })], 2);
		scheduler.admit(idle, [forecast({ decisionBatchesUntilCall: 1 })], 2);

		expect(
			scheduler.preemptFor({ class: "filesystem", units: 1 }, 2, (candidate) => candidate !== joined),
		).toEqual([idle]);
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([joined]);
	});

	it("accepts world effects only when backend evidence matches the Actor execution world", () => {
		const scheduler = new SpeculationScheduler<object>();
		expect(
			scheduler.assessCompatibility(
				{ status: "compatible", backend: "native", executionFingerprint: "world-a" },
				"world-a",
			),
		).toEqual({ compatible: true });
		expect(
			scheduler.assessCompatibility(
				{ status: "compatible", backend: "native", executionFingerprint: "world-a" },
				"world-b",
			),
		).toEqual({ compatible: false, code: "execution_fingerprint_changed" });
		expect(
			scheduler.assessCompatibility(
				{ status: "indeterminate", backend: "native", code: "attestation_missing" },
				"world-a",
			),
		).toEqual({ compatible: false, code: "backend_indeterminate", detail: "attestation_missing" });
	});
});

function forecast(overrides: Partial<PredictionForecast> = {}): PredictionForecast {
	return {
		tool: "read",
		execution: "resource_snapshot",
		expectedDurationMs: 50,
		decisionBatchesUntilCall: 1,
		...overrides,
	};
}
