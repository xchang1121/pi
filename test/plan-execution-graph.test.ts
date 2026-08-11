import { describe, expect, it } from "vitest";
import { PlanExecutionGraph } from "../src/plan-execution-graph.ts";
import type { MaterializedPlan, PlanAction } from "../src/plan-proposal.ts";

describe("PlanExecutionGraph", () => {
	it("releases horizon-zero work immediately and future work just in time", () => {
		const graph = new PlanExecutionGraph();
		const actions = [action("now", 0), action("later", 2)];
		graph.upsert(plan(actions), actions, 10);

		expect(graph.takeReady(10).map(id)).toEqual(["now"]);
		expect(graph.takeReady(11)).toEqual([]);
		expect(graph.takeReady(12).map(id)).toEqual(["later"]);
		expect(graph.get("plan", "later")).toMatchObject({
			expectedActionSeq: 13,
			launchActionSeq: 12,
			state: "launching",
		});
	});

	it("spaces a dependent action after its parent even when both omit a horizon", () => {
		const graph = new PlanExecutionGraph();
		const parent = action("parent");
		const child = action("child", undefined, [{ actionID: "parent", condition: "succeeded" }]);
		graph.upsert(plan([parent, child]), [parent, child], 0);

		expect(graph.get("plan", "parent")).toMatchObject({ expectedActionSeq: 1, launchActionSeq: 0 });
		expect(graph.get("plan", "child")).toMatchObject({ expectedActionSeq: 2, launchActionSeq: 1 });
		expect(graph.takeReady(0).map(id)).toEqual(["parent"]);
		graph.markRunning("plan", "parent");
		graph.markSucceeded("plan", "parent");
		expect(graph.takeReady(0)).toEqual([]);
		expect(graph.takeReady(1).map(id)).toEqual(["child"]);
	});

	it("does not release a future dependent merely because its parent finished early", () => {
		const graph = new PlanExecutionGraph();
		const parent = action("parent", 2);
		const child = action("child", 0, [{ actionID: "parent", condition: "succeeded" }]);
		graph.upsert(plan([parent, child]), [parent, child], 4);

		expect(graph.takeReady(6).map(id)).toEqual(["parent"]);
		graph.markSucceeded("plan", "parent");
		expect(graph.takeReady(6)).toEqual([]);
		expect(graph.takeReady(7).map(id)).toEqual(["child"]);
	});

	it("promotes an actor-requested future node without waiting for its learned horizon", () => {
		const graph = new PlanExecutionGraph();
		const future = action("future", 8);
		graph.upsert(plan([future]), [future], 0);

		expect(graph.promote("plan", "future")).toMatchObject({
			status: "claimed",
			node: { action: { id: "future" }, launchActionSeq: 8 },
		});
		expect(graph.promote("plan", "future")).toEqual({ status: "active" });
	});

	it("waits for an adopted dependency even after speculative success", () => {
		const graph = new PlanExecutionGraph();
		const parent = action("parent");
		const child = action("child", undefined, [{ actionID: "parent", condition: "adopted" }]);
		graph.upsert(plan([parent, child]), [parent, child], 0);

		graph.takeReady(0);
		graph.markSucceeded("plan", "parent");
		expect(graph.promote("plan", "child")).toEqual({ status: "waiting" });
		graph.markAdopted("plan", "parent");
		expect(graph.promote("plan", "child").status).toBe("claimed");
	});

	it("raises every sandbox dependency to an adoption barrier", () => {
		const graph = new PlanExecutionGraph((candidate) => (candidate.tool === "bash" ? "sandbox" : "resource_cached"));
		const parent: PlanAction = {
			id: "parent",
			type: "tool_call",
			tool: "bash",
			input: { command: 'npm test && echo "$CI"' },
		};
		const afterSuccess = action("after-success", undefined, [{ actionID: "parent", condition: "succeeded" }]);
		const afterCompletion = action("after-completion", undefined, [{ actionID: "parent", condition: "completed" }]);
		graph.upsert(plan([parent, afterSuccess, afterCompletion]), [parent, afterSuccess, afterCompletion], 0);

		expect(graph.takeReady(0).map(id)).toEqual(["parent"]);
		graph.markRunning("plan", "parent");
		graph.markSucceeded("plan", "parent");
		expect(graph.takeReady(1)).toEqual([]);
		expect(graph.promote("plan", "after-success")).toEqual({ status: "waiting" });
		expect(graph.promote("plan", "after-completion")).toEqual({ status: "waiting" });

		graph.markAdopted("plan", "parent", 1);
		expect(graph.takeReady(1).map(id)).toEqual(["after-completion", "after-success"]);
	});

	it("blocks sandbox descendants after failure even when the source requested completed", () => {
		const graph = new PlanExecutionGraph((candidate) => (candidate.tool === "bash" ? "sandbox" : "resource_cached"));
		const parent: PlanAction = {
			id: "parent",
			type: "tool_call",
			tool: "bash",
			input: { command: "arbitrary-command" },
		};
		const child = action("child", undefined, [{ actionID: "parent", condition: "completed" }]);
		graph.upsert(plan([parent, child]), [parent, child], 0);

		graph.takeReady(0);
		graph.markFailed("plan", "parent");

		expect(graph.drainBlocked().map(id)).toEqual(["child"]);
		expect(graph.takeReady(1)).toEqual([]);
	});

	it("exposes adoption eligibility without bypassing dependency conditions", () => {
		const graph = new PlanExecutionGraph();
		const parent = action("parent");
		const child = action("child", undefined, [{ actionID: "parent", condition: "adopted" }]);
		graph.upsert(plan([parent, child]), [parent, child], 0);

		expect(graph.canAdopt("plan", "parent")).toBe(true);
		expect(graph.canAdopt("plan", "child")).toBe(false);
		graph.markAdopted("plan", "parent", 1);
		expect(graph.canAdopt("plan", "parent")).toBe(false);
		expect(graph.canAdopt("plan", "child")).toBe(true);
	});

	it("rebases descendants when the actor adopts a parent earlier than predicted", () => {
		const graph = new PlanExecutionGraph();
		const parent = action("parent", 8);
		const child = action("child", 0, [{ actionID: "parent", condition: "adopted" }]);
		graph.upsert(plan([parent, child]), [parent, child], 0);
		expect(graph.get("plan", "child")).toMatchObject({ expectedActionSeq: 10, launchActionSeq: 9 });

		graph.markAdopted("plan", "parent", 2);

		expect(graph.get("plan", "child")).toMatchObject({ expectedActionSeq: 3, launchActionSeq: 2 });
		expect(graph.takeReady(2).map(id)).toEqual(["child"]);
	});

	it("releases preparation hints immediately regardless of their supplied horizon", () => {
		const graph = new PlanExecutionGraph();
		const hint: PlanAction = {
			id: "warm",
			type: "preparation_hint",
			tool: "read",
			input: { path: "later.txt" },
			horizon: 99,
		};
		graph.upsert(plan([hint]), [hint], 4);

		expect(graph.get("plan", "warm")).toMatchObject({ expectedActionSeq: 5, launchActionSeq: 4 });
		expect(graph.takeReady(4).map(id)).toEqual(["warm"]);
	});

	it("blocks succeeded/adopted descendants after failure but satisfies completed edges", () => {
		const graph = new PlanExecutionGraph();
		const parent = action("parent");
		const succeeded = action("succeeded", undefined, [{ actionID: "parent", condition: "succeeded" }]);
		const adopted = action("adopted", undefined, [{ actionID: "parent", condition: "adopted" }]);
		const completed = action("completed", undefined, [{ actionID: "parent", condition: "completed" }]);
		graph.upsert(plan([parent, succeeded, adopted, completed]), [parent, succeeded, adopted, completed], 0);

		graph.takeReady(0);
		graph.markFailed("plan", "parent");
		expect(graph.drainBlocked().map(id).sort()).toEqual(["adopted", "succeeded"]);
		expect(graph.takeReady(1).map(id)).toEqual(["completed"]);
	});

	it("cascades an impossible dependency through the remaining DAG", () => {
		const graph = new PlanExecutionGraph();
		const root = action("root");
		const middle = action("middle", undefined, [{ actionID: "root", condition: "succeeded" }]);
		const leaf = action("leaf", undefined, [{ actionID: "middle", condition: "completed" }]);
		graph.upsert(plan([root, middle, leaf]), [root, middle, leaf], 0);

		graph.takeReady(0);
		graph.markFailed("plan", "root");
		expect(graph.drainBlocked().map(id).sort()).toEqual(["leaf", "middle"]);
		expect(graph.drainBlocked()).toEqual([]);
	});

	it("refreshes a deferred revision anchor without relaunching active work", () => {
		const graph = new PlanExecutionGraph();
		const future = action("future", 3);
		graph.upsert(plan([future]), [future], 0);
		graph.upsert(plan([future], 1), [future], 5);
		expect(graph.get("plan", "future")).toMatchObject({ revision: 1, launchActionSeq: 8 });

		expect(graph.promote("plan", "future").status).toBe("claimed");
		graph.upsert(plan([future], 2), [future], 20);
		expect(graph.get("plan", "future")).toMatchObject({ revision: 2, launchActionSeq: 8, state: "launching" });
	});

	it("removes only named nodes and keeps other proposal state", () => {
		const graph = new PlanExecutionGraph();
		const first = action("first");
		const second = action("second", 1);
		graph.upsert(plan([first, second]), [first, second], 0);

		expect(graph.remove("plan", ["first", "missing"]).map(id)).toEqual(["first"]);
		expect(graph.get("plan", "first")).toBeUndefined();
		expect(graph.get("plan", "second")).toBeDefined();
	});

	it("returns deterministic immutable snapshots", () => {
		const graph = new PlanExecutionGraph();
		const z = action("z");
		const a = action("a");
		graph.upsert(plan([z, a]), [z, a], 0);

		const ready = graph.takeReady(0);
		expect(ready.map(id)).toEqual(["a", "z"]);
		expect(Object.isFrozen(ready[0])).toBe(true);
	});
});

function action(idValue: string, horizon?: number, dependsOn?: PlanAction["dependsOn"]): PlanAction {
	return {
		id: idValue,
		type: "tool_call",
		tool: "read",
		input: { path: `${idValue}.txt` },
		...(horizon !== undefined ? { horizon } : {}),
		...(dependsOn ? { dependsOn } : {}),
	};
}

function plan(actions: readonly PlanAction[], revision = 0): MaterializedPlan {
	return { id: "plan", source: "test", revision, actions, draftTokens: 0 };
}

function id(node: { readonly action: PlanAction }): string {
	return node.action.id;
}
