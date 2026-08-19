import { describe, expect, it } from "vitest";
import { type PredictionForecast, SpeculationScheduler } from "../src/scheduler.ts";

describe("SpeculationScheduler", () => {
	it("never lets one speculative forecast evict another", () => {
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
		const one = scheduler.evaluate([forecast({ expectedDurationMs: 100, stepsUntilCall: 3, criticalPathMs: 120 })]);
		const duplicate = scheduler.evaluate([
			forecast({ expectedDurationMs: 100, stepsUntilCall: 3, criticalPathMs: 120 }),
			forecast({ expectedDurationMs: 80, stepsUntilCall: 4, criticalPathMs: 100 }),
		]);
		expect(duplicate).toEqual(one);
	});

	it("uses conservative observed quantiles to schedule future actions", () => {
		const scheduler = new SpeculationScheduler<object>();
		for (const duration of [80, 100, 120, 200]) scheduler.observeActorStep(duration);
		for (const duration of [20, 40, 60, 100]) scheduler.observeService("read", duration);
		expect(
			scheduler.launchDelay(forecast({ stepsUntilCall: 3, sourceLatencyMs: 20, expectedDurationMs: 40 }), 10),
		).toBe(150);
		expect(scheduler.launchDelay(forecast({ stepsUntilCall: 1, sourceLatencyMs: 1_000 }))).toBe(0);
	});

	it("prioritizes explicit expected latency benefit without requiring it from every source", () => {
		const scheduler = new SpeculationScheduler<object>();
		const unlikelyLong = {};
		const likelyShort = {};
		scheduler.admit(unlikelyLong, [forecast({ expectedDurationMs: 500, expectedLatencyBenefitMs: 10 })], 2);
		scheduler.admit(likelyShort, [forecast({ expectedDurationMs: 50, expectedLatencyBenefitMs: 40 })], 2);

		expect(scheduler.preemptForAuthoritative({ class: "filesystem", units: 1 }, 2)).toEqual([unlikelyLong]);
		expect(scheduler.evaluate([forecast({ expectedDurationMs: 50 })])).toMatchObject({
			criticalPathMs: 50,
			priorityMs: 50,
		});
	});

	it("preempts the latest and least critical work for an authoritative action", () => {
		const scheduler = new SpeculationScheduler<object>();
		const nearCritical = {};
		const farNoncritical = {};
		scheduler.admit(nearCritical, [forecast({ stepsUntilCall: 1, criticalPathMs: 500 })], 2);
		scheduler.admit(farNoncritical, [forecast({ stepsUntilCall: 4, criticalPathMs: 10 })], 2);
		expect(scheduler.preemptForAuthoritative({ class: "filesystem", units: 1 }, 2)).toEqual([farNoncritical]);
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([nearCritical]);
	});

	it("does not preempt a candidate already joined by an Actor", () => {
		const scheduler = new SpeculationScheduler<object>();
		const joined = {};
		const idle = {};
		scheduler.admit(joined, [forecast({ stepsUntilCall: 5 })], 2);
		scheduler.admit(idle, [forecast({ stepsUntilCall: 1 })], 2);

		expect(
			scheduler.preemptForAuthoritative({ class: "filesystem", units: 1 }, 2, (candidate) => candidate !== joined),
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
		execution: "resource_cached",
		sandboxMode: "none",
		expectedDurationMs: 50,
		stepsUntilCall: 1,
		...overrides,
	};
}
