import { describe, expect, test } from "vitest";
import {
	expectedUtility,
	resourceProfile,
	type SpeculativeSchedulingMetadata,
	speculativeLaunchDelay,
	speculativeResourceBudget,
	ToolSpeculationScheduler,
} from "../src/tool-speculation-scheduler.ts";

describe("ToolSpeculationScheduler", () => {
	test("ranks expected latency benefit per resource unit", () => {
		expect(expectedUtility(metadata({ benefit: 80, units: 2 }))).toBe(40);
	});

	test("subtracts measured lifecycle overhead and rejects non-positive net utility", () => {
		expect(expectedUtility({ ...metadata({ benefit: 80, units: 2 }), overheadCostMs: 20 })).toBe(30);
		const scheduler = new ToolSpeculationScheduler<object>();
		expect(scheduler.admit({}, { ...metadata({ benefit: 10 }), overheadCostMs: 10 }, 1)).toEqual({
			admitted: false,
			reason: "insufficient_expected_benefit",
		});
	});

	test("retains a bounded actor lead estimate for scheduling diagnostics", () => {
		const scheduler = new ToolSpeculationScheduler<object>();
		scheduler.admit(
			{},
			{
				expectedDurationMs: 100,
				expectedLeadMs: 150,
				expectedBenefitMs: 80,
				resource: { class: "process", units: 1 },
			},
			1,
		);

		expect(scheduler.snapshot()[0]?.metadata.expectedLeadMs).toBe(100);
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

	test("enforces source-neutral per-plan width inside the scheduler", () => {
		const scheduler = new ToolSpeculationScheduler<object>();
		const first = {};
		const second = {};
		const otherPlan = {};
		scheduler.admit(first, metadata({ benefit: 20 }), 3, { id: "turn-a", limit: 1 });

		expect(scheduler.admit(second, metadata({ benefit: 80 }), 3, { id: "turn-a", limit: 1 })).toEqual({
			admitted: true,
			preempted: [first],
			utility: 80,
		});
		expect(scheduler.admit({}, metadata({ benefit: 10 }), 3, { id: "turn-a", limit: 1 })).toEqual({
			admitted: false,
			reason: "group_exhausted",
		});
		expect(scheduler.admit(otherPlan, metadata({ benefit: 30 }), 3, { id: "turn-b", limit: 1 }).admitted).toBe(true);
		expect(scheduler.snapshot().map((entry) => entry.job)).toEqual([otherPlan, second]);
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

	test("classifies execution resources by world semantics rather than a reserved tool name", () => {
		expect(resourceProfile("resource_cached", "none")).toEqual({ class: "filesystem", units: 1 });
		expect(resourceProfile("sandbox", "workspace_snapshot")).toEqual({ class: "process", units: 1 });
		expect(resourceProfile("sandbox", "file_mutation")).toEqual({ class: "workspace", units: 1 });
		expect(resourceProfile("sandbox", "none")).toEqual({ class: "global", units: 1 });
	});

	test("starts the next action immediately and schedules deeper actions by their latency deadline", () => {
		expect(speculativeLaunchDelay({ stepsUntilCall: 1, averageStepMs: 1_000, expectedDurationMs: 10 })).toBe(0);
		expect(speculativeLaunchDelay({ stepsUntilCall: 3, averageStepMs: 1_000, expectedDurationMs: 3_000 })).toBe(0);
		expect(speculativeLaunchDelay({ stepsUntilCall: 3, averageStepMs: 1_000, expectedDurationMs: 400 })).toBe(2_560);
	});

	test("preserves resource and plan bounds under deterministic mixed churn", () => {
		const scheduler = new ToolSpeculationScheduler<object>();
		const budget = {
			total: 6,
			classes: { filesystem: 3, workspace: 2, process: 2, global: 1 },
		};
		const classes = ["filesystem", "workspace", "process", "global"] as const;
		let randomState = 0x5eed1234;
		const random = () => {
			randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
			return randomState / 2 ** 32;
		};

		for (let step = 0; step < 1_000; step++) {
			const running = scheduler.snapshot();
			if (running.length > 0 && random() < 0.35) {
				scheduler.complete(running[Math.floor(random() * running.length)]!.job);
			} else {
				const resourceClass = classes[Math.floor(random() * classes.length)]!;
				const units = 1 + Math.floor(random() * 3);
				scheduler.admit(
					{},
					{
						expectedDurationMs: 100,
						expectedBenefitMs: 1 + Math.floor(random() * 100),
						resource: { class: resourceClass, units },
					},
					budget,
					{ id: `plan-${Math.floor(random() * 3)}`, limit: 2 },
				);
			}

			const snapshot = scheduler.snapshot();
			expect(snapshot.reduce((total, entry) => total + entry.metadata.resource.units, 0)).toBeLessThanOrEqual(
				budget.total,
			);
			for (const resourceClass of classes) {
				const used = snapshot.reduce(
					(total, entry) =>
						total +
						(entry.metadata.resource.class === resourceClass || entry.metadata.resource.class === "global"
							? entry.metadata.resource.units
							: 0),
					0,
				);
				expect(used).toBeLessThanOrEqual(budget.classes[resourceClass]);
			}
			for (const plan of ["plan-0", "plan-1", "plan-2"]) {
				expect(snapshot.filter((entry) => entry.group === plan).length).toBeLessThanOrEqual(2);
			}
		}
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
