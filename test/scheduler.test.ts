import { describe, expect, it } from "vitest";
import { type PredictionForecast, SpeculationScheduler } from "../src/scheduler.ts";

describe("SpeculationScheduler", () => {
	it("owns forecast evaluation and admits the highest-value demand", () => {
		const scheduler = new SpeculationScheduler<object>();
		const low = {};
		const high = {};
		expect(scheduler.admit(low, [forecast({ probability: 0.1, expectedDurationMs: 10 })], 1).admitted).toBe(true);
		const admitted = scheduler.admit(high, [forecast({ probability: 0.9, expectedDurationMs: 100 })], 1);
		expect(admitted).toMatchObject({ admitted: true, preempted: [low] });
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([high]);
	});

	it("does not inflate one candidate merely because multiple sources attach", () => {
		const scheduler = new SpeculationScheduler<object>();
		const one = scheduler.evaluate([forecast({ probability: 0.6, expectedDurationMs: 100 })]);
		const duplicate = scheduler.evaluate([
			forecast({ probability: 0.6, expectedDurationMs: 100 }),
			forecast({ probability: 0.5, expectedDurationMs: 100 }),
		]);
		expect(duplicate).toEqual(one);
	});

	it("learns Actor cadence and service time for launch timing", () => {
		const scheduler = new SpeculationScheduler<object>();
		scheduler.observeActorStep(100);
		scheduler.observeService("read", 80);
		expect(scheduler.launchDelay(forecast({ expectedDurationMs: 40 }), 3, 10)).toBe(250);
	});

	it("preempts only enough work for an authoritative action", () => {
		const scheduler = new SpeculationScheduler<object>();
		const first = {};
		const second = {};
		scheduler.admit(first, [forecast({ probability: 0.2 })], 2);
		scheduler.admit(second, [forecast({ probability: 0.8 })], 2);
		expect(scheduler.preemptForAuthoritative({ class: "filesystem", units: 1 }, 2)).toEqual([first]);
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([second]);
	});

	it("does not preempt a candidate already joined by an Actor", () => {
		const scheduler = new SpeculationScheduler<object>();
		const joined = {};
		const idle = {};
		scheduler.admit(joined, [forecast({ probability: 0.1 })], 2);
		scheduler.admit(idle, [forecast({ probability: 0.8 })], 2);

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
		probability: 1,
		expectedDurationMs: 50,
		...overrides,
	};
}
