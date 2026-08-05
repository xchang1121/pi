import { describe, expect, test } from "vitest";
import {
	expectedUtility,
	type SpeculativeSchedulingMetadata,
	speculativeResourceBudget,
	ToolSpeculationScheduler,
} from "../src/tool-speculation-scheduler.ts";

describe("ToolSpeculationScheduler", () => {
	test("ranks expected latency benefit per resource unit", () => {
		expect(expectedUtility(metadata({ benefit: 80, units: 2 }))).toBe(40);
	});

	test("preempts lower-utility speculative work when the budget is full", () => {
		const scheduler = new ToolSpeculationScheduler<object>();
		const low = {};
		const high = {};

		expect(scheduler.admit(low, metadata({ benefit: 10 }), 1).admitted).toBe(true);
		expect(scheduler.admit(high, metadata({ benefit: 90 }), 1)).toEqual({
			admitted: true,
			preempted: [low],
			utility: 90,
		});
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([high]);
	});

	test("suppresses lower-utility work instead of displacing a better job", () => {
		const scheduler = new ToolSpeculationScheduler<object>();
		scheduler.admit({}, metadata({ benefit: 90 }), 1);

		expect(scheduler.admit({}, metadata({ benefit: 10 }), 1)).toEqual({
			admitted: false,
			reason: "budget_exhausted",
		});
	});

	test("authoritative work reclaims conflicting speculative capacity and promotion protects a hit", () => {
		const scheduler = new ToolSpeculationScheduler<object>();
		const filesystem = {};
		const process = {};
		scheduler.admit(filesystem, metadata({ benefit: 20, resource: "filesystem" }), 2);
		scheduler.admit(process, metadata({ benefit: 30, resource: "process" }), 2);

		expect(scheduler.promote(process)).toBe(true);
		expect(scheduler.preemptForAuthoritative({ class: "filesystem", units: 1 })).toEqual([filesystem]);
		expect(scheduler.snapshot()).toHaveLength(0);
	});

	test("enforces independent process capacity without displacing unrelated filesystem work", () => {
		const scheduler = new ToolSpeculationScheduler<object>();
		const filesystem = {};
		const lowProcess = {};
		const highProcess = {};
		const budget = {
			total: 4,
			classes: { filesystem: 4, workspace: 2, process: 1, global: 4 },
		};
		scheduler.admit(filesystem, metadata({ benefit: 50, resource: "filesystem" }), budget);
		scheduler.admit(lowProcess, metadata({ benefit: 10, resource: "process" }), budget);

		expect(scheduler.admit(highProcess, metadata({ benefit: 90, resource: "process" }), budget)).toEqual({
			admitted: true,
			preempted: [lowProcess],
			utility: 90,
		});
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([filesystem, highProcess]);
	});

	test("uses the configured concurrency limit without hidden per-resource ratios", () => {
		expect(speculativeResourceBudget(8)).toEqual({
			total: 8,
			classes: { filesystem: 8, workspace: 8, process: 8, global: 8 },
		});
	});
});

function metadata(
	input: { readonly benefit: number; readonly units?: number; readonly resource?: "filesystem" | "process" } = {
		benefit: 1,
	},
): SpeculativeSchedulingMetadata {
	return {
		expectedDurationMs: 100,
		expectedBenefitMs: input.benefit,
		resource: { class: input.resource ?? "filesystem", units: input.units ?? 1 },
	};
}
