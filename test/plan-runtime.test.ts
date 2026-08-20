import { describe, expect, it } from "vitest";
import { CandidateExecution } from "../src/candidate-execution.ts";
import type { PlanAction, PlanProposal } from "../src/plan-proposal.ts";
import { PlanRuntime } from "../src/plan-runtime.ts";
import { cause } from "../src/settlement.ts";

describe("PlanRuntime", () => {
	it("keeps execution failure and later Actor confirmation as independent facts", () => {
		const plan = new PlanRuntime();
		plan.apply(proposal([action("parent")]), 0);
		plan.takeReady(0);
		const execution = new CandidateExecution<string>("shared");
		plan.attachExecution("plan", "parent", "candidate", execution);
		execution.start(1);
		execution.fail(cause("execution", "tool_failed"), 2, 1);
		const actor = { id: "actor", sequence: 1, turnID: "turn" } as const;
		const relation = { kind: "exact", distance: 0 } as const;
		const opportunity = plan.claimMatch("plan", "parent", actor, relation)!;

		const settlement = plan.confirm(opportunity, actor, {
			status: "rejected",
			candidateID: "candidate",
			cause: cause("execution", "tool_failed"),
		});

		expect(settlement).toMatchObject({
			observation: "observed",
			match: { matched: true, adoption: { status: "rejected" } },
		});
		expect(settlement?.observation === "observed" && Object.isFrozen(settlement.match)).toBe(true);
		expect(plan.get("plan", "parent")).toMatchObject({
			execution: { status: "failed" },
			predictionState: { status: "settled", settlement },
		});
		expect(
			plan.confirm(
				opportunity,
				{ id: "actor-2", sequence: 2, turnID: "turn" },
				{
					status: "adopted",
					candidateID: "candidate",
				},
			),
		).toBeUndefined();
	});

	it("schedules at the expected horizon and retains the prediction until its latest horizon", () => {
		const plan = new PlanRuntime();
		plan.apply(proposal([action("future", { horizon: 0, latestHorizon: 2 })]), 4);
		plan.takeReady(4);
		const execution = new CandidateExecution<string>("shared");
		plan.attachExecution("plan", "future", "candidate", execution);
		execution.cancel(cause("admission", "scheduler_preempted"), 1, 0);

		expect(plan.get("plan", "future")).toMatchObject({
			earliestDecisionSeq: 5,
			expectedDecisionSeq: 5,
			latestDecisionSeq: 7,
			execution: { status: "cancelled" },
			predictionState: { status: "pending" },
		});
		expect(plan.due(6)).toEqual([]);
		expect(plan.due(7).map((node) => node.action.id)).toEqual(["future"]);
		const actor = { id: "actor", sequence: 7, turnID: "turn" } as const;
		const opportunity = plan.claimMatch("plan", "future", actor, { kind: "exact", distance: 0 })!;

		const settlement = plan.confirm(opportunity, actor, {
			status: "rejected",
			candidateID: "candidate",
			cause: cause("admission", "candidate_unavailable"),
		});
		expect(settlement).toMatchObject({ observation: "observed", match: { matched: true } });

		const clamped = new PlanRuntime();
		clamped.apply(proposal([action("clamped", { horizon: 2, latestHorizon: 0 })]), 4);
		expect(clamped.get("plan", "clamped")).toMatchObject({ expectedDecisionSeq: 7, latestDecisionSeq: 7 });
	});

	it("binds one canonical action identity to an opportunity", () => {
		const plan = new PlanRuntime();
		const input = { path: "keyed.ts" };
		plan.apply(proposal([action("keyed", { input })]), 0);
		input.path = "mutated.ts";
		const key = {
			key: "key",
			hash: "hash",
			tool: "read",
			input: { path: "keyed.ts" },
			resources: ["keyed.ts"],
			semanticsEpoch: "1",
			schemaHash: "schema",
			executionFingerprint: "executor",
		};
		expect(plan.bindActionKey("plan", "keyed", key)).toBe(true);
		expect(plan.bindActionKey("plan", "keyed", { ...key, hash: "other" })).toBe(false);
		expect(plan.get("plan", "keyed")?.actionKey).toBe(key);
		expect(plan.get("plan", "keyed")?.action.input).toEqual({ path: "keyed.ts" });
		expect(Object.isFrozen(plan.get("plan", "keyed")?.action.input)).toBe(true);
	});

	it("keeps an execution-blocked node matchable without making it launchable", () => {
		const plan = new PlanRuntime();
		plan.apply(proposal([action("bash")]), 0);
		const key = {
			key: "key",
			hash: "hash",
			tool: "bash",
			input: { command: "npm test" },
			resources: ["."],
			semanticsEpoch: "pi.bash.v2",
			schemaHash: "schema",
			executionFingerprint: "pi.bash.local.v2",
		};

		expect(plan.bindActionKey("plan", "bash", key)).toBe(true);
		const blocked = cause("execution", "isolation_unavailable");
		expect(plan.markExecutionBlocked("plan", "bash", blocked)).toBe(true);
		expect(plan.markExecutionBlocked("plan", "bash", blocked)).toBe(false);
		expect(plan.launchable()).toEqual([]);
		expect(plan.matchable(1)).toMatchObject([
			{ actionKey: key, execution: { status: "execution_blocked", cause: blocked } },
		]);
	});

	it("uses execution predicates for launch without exposing an unadopted Actor prefix", () => {
		const plan = new PlanRuntime();
		plan.apply(
			proposal([
				action("parent"),
				action("settled", { dependsOn: [{ actionID: "parent", condition: "execution_settled" }] }),
				action("succeeded", { dependsOn: [{ actionID: "parent", condition: "execution_succeeded" }] }),
				action("confirmed", { dependsOn: [{ actionID: "parent", condition: "actor_adopted" }] }),
			]),
			0,
		);

		expect(plan.takeReady(0).map((node) => node.action.id)).toEqual(["parent"]);
		const execution = new CandidateExecution<string>("shared");
		plan.attachExecution("plan", "parent", "candidate", execution);
		execution.start(0);
		execution.succeed("output", 1, 1);
		expect(plan.matchable(1).map((node) => node.action.id)).toEqual(["parent"]);
		expect(
			plan
				.matchable(2)
				.map((node) => node.action.id)
				.sort(),
		).toEqual(["parent"]);
		expect(
			plan
				.launchable()
				.map((node) => node.action.id)
				.sort(),
		).toEqual(["settled", "succeeded"]);
		const actor = { id: "actor", sequence: 1, turnID: "turn" } as const;
		const opportunity = plan.claimMatch("plan", "parent", actor, { kind: "exact", distance: 0 })!;

		plan.confirm(opportunity, actor, { status: "rejected", cause: cause("execution", "failed") });
		expect(plan.launchable().map((node) => node.action.id)).toEqual(["settled"]);
		expect(
			plan
				.drainBlocked()
				.map((node) => node.action.id)
				.sort(),
		).toEqual(["confirmed", "succeeded"]);
	});

	it("derives source-neutral deadlines and critical paths from the dependency graph", () => {
		const plan = new PlanRuntime();
		plan.apply(
			proposal([
				action("short", { expectedDurationMs: 10 }),
				action("critical", { expectedDurationMs: 20 }),
				action("child", {
					expectedDurationMs: 80,
					dependsOn: [{ actionID: "critical", condition: "execution_succeeded" }],
				}),
			]),
			4,
		);

		expect(plan.get("plan", "short")).toMatchObject({ expectedDecisionSeq: 5, criticalPathMs: 10 });
		expect(plan.get("plan", "critical")).toMatchObject({ expectedDecisionSeq: 5, criticalPathMs: 100 });
		expect(plan.get("plan", "child")).toMatchObject({
			earliestDecisionSeq: 6,
			expectedDecisionSeq: 6,
			criticalPathMs: 80,
		});
		expect(plan.takeReady(4).map((node) => node.action.id)).toEqual(["critical", "short"]);

		const actor = { id: "actor", sequence: 99, decisionSequence: 7, turnID: "turn" } as const;
		const opportunity = plan.claimMatch("plan", "critical", actor, { kind: "exact", distance: 0 })!;
		plan.confirm(opportunity, actor, { status: "adopted", candidateID: "candidate" });
		expect(plan.get("plan", "child")).toMatchObject({
			earliestDecisionSeq: 8,
			expectedDecisionSeq: 8,
			latestDecisionSeq: 8,
		});
	});

	it("keeps preparation work outside Actor prediction settlement", () => {
		const plan = new PlanRuntime();
		plan.apply(
			proposal([
				{ ...action("prepare"), type: "preparation_hint" },
				action("after", { dependsOn: [{ actionID: "prepare", condition: "execution_succeeded" }] }),
			]),
			0,
		);
		const [hint] = plan.takeReady(0);
		expect(hint).toMatchObject({ action: { type: "preparation_hint" } });
		expect("prediction" in hint!).toBe(false);
		expect(plan.pending().map((node) => node.action.id)).toEqual(["after"]);

		const execution = new CandidateExecution<void>("shared");
		plan.attachExecution("plan", "prepare", "hint", execution);
		execution.start(1);
		execution.succeed(undefined, 2, 1);

		expect(plan.get("plan", "prepare")).toMatchObject({ execution: { status: "succeeded" }, readiness: "settled" });
		expect(plan.get("plan", "after")).toMatchObject({
			earliestDecisionSeq: 1,
			expectedDecisionSeq: 1,
			latestDecisionSeq: 1,
		});
		expect(plan.matchable(1).map((node) => node.action.id)).toEqual(["after"]);
		expect(plan.launchable().map((node) => node.action.id)).toEqual(["after"]);
		expect(plan.unobserve("plan", "prepare", cause("control", "should_not_exist"))).toBeUndefined();

		const invalid = new PlanRuntime();
		expect(
			invalid.apply(
				proposal([
					{ ...action("hint"), type: "preparation_hint" },
					action("impossible", { dependsOn: [{ actionID: "hint", condition: "actor_adopted" }] }),
				]),
				0,
			),
		).toEqual({ accepted: false, reason: "invalid_dependency" });
		expect(invalid.apply(proposal([action("uncloneable", { input: { callback: () => undefined } })]), 0)).toEqual({
			accepted: false,
			reason: "invalid_action",
		});
	});

	it("keeps a claimed opportunity authoritative after its plan node is replaced", () => {
		const plan = new PlanRuntime();
		plan.apply(proposal([action("target", { input: { path: "old.ts" } })]), 0);
		const actor = { id: "actor", sequence: 1, turnID: "turn" } as const;
		const relation = { kind: "exact", distance: 0 } as const;
		const original = plan.claimMatch("plan", "target", actor, relation)!;
		const update = plan.apply(
			{
				proposalID: "plan",
				source: "source",
				revision: 2,
				upsert: [action("target", { input: { path: "new.ts" } })],
			},
			1,
		);

		expect(update).toMatchObject({ accepted: true, retired: [{ node: { action: { id: "target" } } }] });
		expect(original.settlement).toBeUndefined();
		expect(plan.opportunity("plan", "target")).not.toBe(original);
		expect(plan.confirm(original, actor, { status: "adopted", candidateID: "old-candidate" })).toMatchObject({
			observation: "observed",
			match: { matched: true, adoption: { status: "adopted" } },
		});
		expect(plan.opportunity("plan", "target")?.state).toEqual({ status: "pending" });
	});

	it("settles observed misses and unobserved control endings exactly once", () => {
		const plan = new PlanRuntime();
		plan.apply(proposal([action("miss"), action("aborted")]), 0);

		expect(plan.miss("plan", "miss", { id: "actor", sequence: 1, turnID: "turn" })).toMatchObject({
			observation: "observed",
			match: { matched: false },
		});
		expect(plan.unobserve("plan", "miss", cause("control", "late"))).toBeUndefined();
		expect(plan.unobserve("plan", "aborted", cause("control", "turn_aborted"))).toMatchObject({
			observation: "unobserved",
		});
	});

	it("lets only one concurrent Actor action claim an unsettled prediction", () => {
		const plan = new PlanRuntime();
		plan.apply(proposal([action("only")]), 0);
		const first = { id: "first", sequence: 1, turnID: "turn" };
		const second = { id: "first", sequence: 2, turnID: "other-turn" };
		const relation = { kind: "exact", distance: 0 } as const;

		expect(plan.claimMatch("plan", "only", first, relation)).toBeDefined();
		expect(plan.claimMatch("plan", "only", second, relation)).toBeUndefined();
		expect(plan.pending()).toHaveLength(0);
		expect(plan.unsettled()).toHaveLength(1);
		expect(plan.unobserve("plan", "only", cause("control", "shutdown"))).toBeUndefined();
		expect(plan.opportunity("plan", "only")?.state.status).toBe("matching");
		expect(
			plan.confirm(plan.opportunity("plan", "only")!, second, {
				status: "rejected",
				cause: cause("matching", "wrong_actor"),
			}),
		).toBeUndefined();
		expect(
			plan.confirm(plan.opportunity("plan", "only")!, first, {
				status: "rejected",
				cause: cause("freshness", "resource_changed"),
			}),
		).toMatchObject({ actorAction: first, match: { matched: true } });
	});
});

function proposal(actions: readonly PlanAction[]): PlanProposal {
	return { id: "plan", source: "source", revision: 1, actions };
}

function action(
	id: string,
	options: {
		readonly input?: unknown;
		readonly horizon?: number;
		readonly latestHorizon?: number;
		readonly dependsOn?: PlanAction["dependsOn"];
		readonly expectedDurationMs?: number;
	} = {},
): PlanAction {
	return {
		id,
		type: "tool_call",
		tool: "read",
		input: options.input ?? { path: `${id}.ts` },
		...(options.horizon !== undefined ? { horizon: options.horizon } : {}),
		...(options.latestHorizon !== undefined ? { latestHorizon: options.latestHorizon } : {}),
		...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
		...(options.expectedDurationMs !== undefined ? { expectedDurationMs: options.expectedDurationMs } : {}),
	};
}
