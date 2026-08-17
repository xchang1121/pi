import { describe, expect, it } from "vitest";
import type { PlanAction, PlanActionDependency } from "../src/plan-proposal.ts";
import { PlanState } from "../src/plan-state.ts";

describe("PlanState updates", () => {
	it("materializes deltas transactionally and retires only removed nodes", () => {
		const state = new PlanState();
		state.apply(proposal([action("a"), action("b")], 0, 2), 4);

		const result = state.apply(
			{
				proposalID: "plan",
				source: "test",
				revision: 1,
				upsert: [action("c", { dependsOn: [{ actionID: "a", condition: "succeeded" }] })],
				remove: ["b", "unknown"],
				draftTokens: 3,
			},
			5,
		);

		expect(result).toMatchObject({ accepted: true, removed: ["b"] });
		if (!result.accepted) throw new Error("delta rejected");
		expect(result.plan).toMatchObject({ revision: 1, draftTokens: 5 });
		expect(result.plan.actions.map((item) => item.id)).toEqual(["a", "c"]);
		expect(result.retired.map(id)).toEqual(["b"]);
		expect(Object.isFrozen(result.plan)).toBe(true);
		expect(Object.isFrozen(result.plan.actions)).toBe(true);
	});

	it.each([
		["identity", { id: " ", source: "test", revision: 0, actions: [] }, "invalid_identity"],
		["revision", { id: "plan", source: "test", revision: 0.5, actions: [] }, "invalid_revision"],
		[
			"duplicate action",
			{ id: "plan", source: "test", revision: 0, actions: [action("a"), action("a")] },
			"duplicate_action",
		],
		[
			"invalid action",
			{ id: "plan", source: "test", revision: 0, actions: [{ ...action("a"), tool: "" }] },
			"invalid_action",
		],
	])("rejects invalid %s without creating plan state", (_label, update, reason) => {
		const state = new PlanState();
		expect(state.apply(update, 0)).toEqual({ accepted: false, reason });
		expect(state.plan("plan")).toBeUndefined();
		expect(state.values()).toEqual([]);
	});

	it("enforces revision ownership without mutating the accepted plan", () => {
		const state = new PlanState();
		state.apply(proposal([action("a")], 4), 0);

		expect(state.apply({ proposalID: "plan", source: "test", revision: 4, upsert: [action("b")] }, 0)).toEqual({
			accepted: false,
			reason: "stale_revision",
		});
		expect(state.apply({ ...proposal([], 5), source: "intruder" }, 0)).toEqual({
			accepted: false,
			reason: "source_mismatch",
		});
		expect(state.apply({ proposalID: "missing", source: "test", revision: 1, upsert: [action("b")] }, 0)).toEqual({
			accepted: false,
			reason: "proposal_missing",
		});
		expect(state.plan("plan")?.actions.map((item) => item.id)).toEqual(["a"]);
	});

	it("reserves monotonic continuation revisions without source-owned counters", () => {
		const state = new PlanState();
		state.apply(proposal([action("a")]), 0);

		expect(state.reserveRevision("plan")).toBe(1);
		expect(state.reserveRevision("plan")).toBe(2);
		expect(state.apply({ proposalID: "plan", source: "test", revision: 2, upsert: [action("b")] }, 0)).toMatchObject({
			accepted: true,
		});
		expect(state.reserveRevision("plan")).toBe(3);
		expect(state.reserveRevision("missing")).toBeUndefined();
	});

	it("retires only fully terminal plans with no live candidate support", () => {
		const state = new PlanState();
		state.apply(proposal([action("kept"), action("done")]), 0);
		state.takeReady(0);
		state.markSucceeded("plan", "kept");
		state.markSucceeded("plan", "done");

		expect(state.retireTerminalPlans((node) => node.action.id === "kept")).toEqual([]);
		expect(state.values()).toHaveLength(2);
		expect(state.retireTerminalPlans()).toMatchObject([
			{ action: { id: "kept" }, state: "succeeded" },
			{ action: { id: "done" }, state: "succeeded" },
		]);
		expect(state.values()).toEqual([]);
	});

	it.each([
		["missing parent", [action("child", { dependsOn: [{ actionID: "missing" }] })]],
		["self edge", [action("self", { dependsOn: [{ actionID: "self" }] })]],
		["cycle", [action("a", { dependsOn: [{ actionID: "b" }] }), action("b", { dependsOn: [{ actionID: "a" }] })]],
	])("rejects an invalid DAG (%s) transactionally", (_label, actions) => {
		const state = new PlanState();
		state.apply(proposal([action("safe")]), 0);

		expect(state.apply(proposal(actions, 1), 0)).toEqual({ accepted: false, reason: "invalid_dependency" });
		expect(state.plan("plan")?.revision).toBe(0);
		expect(state.plan("plan")?.actions.map((item) => item.id)).toEqual(["safe"]);
	});

	it("rejects removal of a live dependency without changing lifecycle state", () => {
		const state = new PlanState();
		state.apply(
			proposal([action("parent"), action("child", { dependsOn: [{ actionID: "parent", condition: "succeeded" }] })]),
			0,
		);
		state.takeReady(0);
		state.markRunning("plan", "parent");

		expect(state.apply({ proposalID: "plan", source: "test", revision: 1, remove: ["parent"] }, 2)).toEqual({
			accepted: false,
			reason: "invalid_dependency",
		});
		expect(state.get("plan", "parent")?.state).toBe("running");
		expect(state.plan("plan")?.revision).toBe(0);
	});

	it("keeps active execution on metadata refinement and exposes one current revision", () => {
		const state = new PlanState();
		const parent = action("parent");
		state.apply(proposal([parent, action("untouched", { horizon: 4 })]), 0);
		state.takeReady(0);
		state.markRunning("plan", "parent");

		const result = state.apply(
			{
				proposalID: "plan",
				source: "test",
				revision: 1,
				upsert: [{ ...parent, empiricalProbability: 0.9, feedback: { revision: 1 } }],
			},
			20,
		);

		expect(result).toMatchObject({ accepted: true, retired: [] });
		expect(state.get("plan", "parent")).toMatchObject({ state: "running", anchorActionSeq: 0, revision: 1 });
		expect(state.get("plan", "untouched")).toMatchObject({ revision: 1, launchActionSeq: 4 });
	});

	it("replaces failed work atomically and revives descendants without a transient block", () => {
		const state = new PlanState();
		const parent = action("parent", { input: { path: "old" } });
		const child = action("child", { dependsOn: [{ actionID: "parent", condition: "succeeded" }] });
		state.apply(proposal([parent, child]), 0);
		state.takeReady(0);
		state.markFailed("plan", "parent");
		expect(state.drainBlocked().map(id)).toEqual(["child"]);

		const result = state.apply(
			{
				proposalID: "plan",
				source: "test",
				revision: 1,
				upsert: [{ ...parent, input: { path: "replacement" } }],
			},
			0,
		);

		expect(result).toMatchObject({ accepted: true });
		if (!result.accepted) throw new Error("replacement rejected");
		expect(result.retired).toMatchObject([{ action: { id: "parent" }, state: "failed", revision: 0 }]);
		expect(state.get("plan", "parent")?.state).toBe("deferred");
		expect(state.get("plan", "child")?.state).toBe("deferred");
		expect(state.drainBlocked()).toEqual([]);
		expect(state.takeReady(0).map(id)).toEqual(["parent"]);
	});
});

describe("PlanState scheduling", () => {
	it("lets a source-neutral deadline policy claim launchable nodes without bypassing dependencies", () => {
		const state = new PlanState();
		const parent = action("parent", { horizon: 3 });
		const deep = action("deep", { horizon: 5 });
		const child = action("child", { dependsOn: [{ actionID: "parent", condition: "succeeded" }] });
		state.apply(proposal([parent, deep, child]), 0);

		expect(state.launchable().map(id)).toEqual(["parent", "deep"]);
		expect(state.takeReady(0, (node) => node.action.id === "deep").map(id)).toEqual(["deep"]);
		expect(state.takeReady(0, () => true).map(id)).toEqual(["parent"]);
		state.markSucceeded("plan", "parent");
		expect(state.takeReady(0, () => true).map(id)).toEqual(["child"]);
	});

	it("releases horizons and ordered descendants just in time", () => {
		const state = new PlanState();
		const parent = action("parent", { horizon: 2 });
		const child = action("child", { dependsOn: [{ actionID: "parent", condition: "succeeded" }] });
		state.apply(proposal([parent, child]), 4);

		expect(state.get("plan", "parent")).toMatchObject({ expectedActionSeq: 7, launchActionSeq: 6 });
		expect(state.get("plan", "child")).toMatchObject({ expectedActionSeq: 8, launchActionSeq: 7 });
		expect(state.takeReady(5)).toEqual([]);
		expect(state.takeReady(6).map(id)).toEqual(["parent"]);
		state.markSucceeded("plan", "parent");
		expect(state.takeReady(6)).toEqual([]);
		expect(state.takeReady(7).map(id)).toEqual(["child"]);
	});

	it("promotes actor-requested future work but preserves dependency barriers", () => {
		const state = new PlanState();
		const parent = action("parent", { horizon: 8 });
		const child = action("child", { dependsOn: [{ actionID: "parent", condition: "adopted" }] });
		state.apply(proposal([parent, child]), 0);

		expect(state.promote("plan", "child")).toEqual({ status: "waiting" });
		expect(state.promote("plan", "parent")).toMatchObject({ status: "claimed", node: { launchActionSeq: 8 } });
		expect(state.promote("plan", "parent")).toEqual({ status: "active" });
	});

	it("uses declared dependency conditions independently of tool execution mode", () => {
		const state = new PlanState();
		const parent = bash('npm test && MODE="$TARGET" ./custom-script --flag');
		const afterSuccess = action("after-success", {
			dependsOn: [{ actionID: "parent", condition: "succeeded" }],
		});
		const afterCompletion = action("after-completion", {
			dependsOn: [{ actionID: "parent", condition: "completed" }],
		});
		state.apply(proposal([parent, afterSuccess, afterCompletion]), 0);

		expect(state.takeReady(0).map(id)).toEqual(["parent"]);
		state.markRunning("plan", "parent");
		state.markSucceeded("plan", "parent");
		expect(state.takeReady(1).map(id)).toEqual(["after-completion", "after-success"]);
	});

	it("releases completed dependencies and blocks succeeded dependencies after failure", () => {
		const state = new PlanState();
		const parent = bash("any-command-the-shell-accepts");
		state.apply(
			proposal([
				parent,
				action("succeeded", { dependsOn: [{ actionID: "parent", condition: "succeeded" }] }),
				action("completed", { dependsOn: [{ actionID: "parent", condition: "completed" }] }),
			]),
			0,
		);

		state.takeReady(0);
		state.markFailed("plan", "parent");
		expect(state.drainBlocked().map(id)).toEqual(["succeeded"]);
		expect(state.takeReady(1).map(id)).toEqual(["completed"]);
	});

	it("keeps non-sandbox completion semantics and cascades impossible dependencies", () => {
		const state = new PlanState();
		state.apply(
			proposal([
				action("root"),
				action("completed", { dependsOn: [{ actionID: "root", condition: "completed" }] }),
				action("middle", { dependsOn: [{ actionID: "root", condition: "succeeded" }] }),
				action("leaf", { dependsOn: [{ actionID: "middle", condition: "completed" }] }),
			]),
			0,
		);

		state.takeReady(0);
		state.markFailed("plan", "root");
		expect(state.drainBlocked().map(id).sort()).toEqual(["leaf", "middle"]);
		expect(state.takeReady(1).map(id)).toEqual(["completed"]);
	});

	it("rebases descendants when adoption happens earlier than the predicted horizon", () => {
		const state = new PlanState();
		state.apply(
			proposal([
				action("parent", { horizon: 8 }),
				action("child", { dependsOn: [{ actionID: "parent", condition: "adopted" }] }),
			]),
			0,
		);
		expect(state.get("plan", "child")).toMatchObject({ expectedActionSeq: 10, launchActionSeq: 9 });

		state.markAdopted("plan", "parent", 2);

		expect(state.get("plan", "child")).toMatchObject({ expectedActionSeq: 3, launchActionSeq: 2 });
		expect(state.takeReady(2).map(id)).toEqual(["child"]);
	});

	it("releases preparation hints immediately without delaying future actions", () => {
		const state = new PlanState();
		state.apply(
			proposal([{ ...action("warm", { horizon: 99 }), type: "preparation_hint" }, action("later", { horizon: 2 })]),
			4,
		);

		expect(state.takeReady(4).map(id)).toEqual(["warm"]);
		expect(state.takeReady(5)).toEqual([]);
		expect(state.takeReady(6).map(id)).toEqual(["later"]);
	});
});

function proposal(actions: readonly PlanAction[], revision = 0, draftTokens?: number) {
	return { id: "plan", source: "test", revision, actions, ...(draftTokens !== undefined ? { draftTokens } : {}) };
}

function action(
	idValue: string,
	options: {
		readonly tool?: string;
		readonly input?: unknown;
		readonly horizon?: number;
		readonly dependsOn?: readonly PlanActionDependency[];
	} = {},
): PlanAction {
	return {
		id: idValue,
		type: "tool_call",
		tool: options.tool ?? "read",
		input: options.input ?? { path: `${idValue}.txt` },
		...(options.horizon !== undefined ? { horizon: options.horizon } : {}),
		...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
	};
}

function bash(command: string): PlanAction {
	return action("parent", { tool: "bash", input: { command } });
}

function id(node: { readonly action: PlanAction }): string {
	return node.action.id;
}
