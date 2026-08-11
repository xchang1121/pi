import { describe, expect, it } from "vitest";
import { type PlanAction, PlanLedger, proposalAsDelta } from "../src/plan-proposal.ts";

const action = (id: string, dependsOn?: readonly string[]): PlanAction => ({
	id,
	type: "tool_call",
	tool: "read",
	input: { path: `${id}.ts` },
	...(dependsOn ? { dependsOn: dependsOn.map((actionID) => ({ actionID, condition: "succeeded" as const })) } : {}),
});

describe("PlanLedger", () => {
	it("materializes a source-neutral proposal with stable action identities", () => {
		const ledger = new PlanLedger();
		const result = ledger.apply({
			id: "proposal-1",
			source: "learned-sequence-v2",
			revision: 0,
			actions: [action("parent"), action("child", ["parent"])],
			draftTokens: 17,
		});

		expect(result).toMatchObject({ accepted: true, removed: [] });
		if (!result.accepted) throw new Error("proposal rejected");
		expect(result.plan).toMatchObject({
			id: "proposal-1",
			source: "learned-sequence-v2",
			revision: 0,
			draftTokens: 17,
		});
		expect(result.plan.actions.map((item) => item.id)).toEqual(["parent", "child"]);
	});

	it("applies monotonic deltas transactionally", () => {
		const ledger = new PlanLedger();
		ledger.apply({ id: "p", source: "s", revision: 0, actions: [action("a")], draftTokens: 2 });

		const result = ledger.apply({
			proposalID: "p",
			source: "s",
			revision: 1,
			upsert: [action("b", ["a"])],
			draftTokens: 3,
		});

		expect(result).toMatchObject({ accepted: true, removed: [] });
		if (!result.accepted) throw new Error("delta rejected");
		expect(result.upserted.map((item) => item.id)).toEqual(["b"]);
		expect(result.plan.actions.map((item) => item.id)).toEqual(["a", "b"]);
		expect(result.plan.draftTokens).toBe(5);
	});

	it("supports replacement and reports actions removed by the producer", () => {
		const ledger = new PlanLedger();
		ledger.apply({ id: "p", source: "s", revision: 0, actions: [action("a"), action("b", ["a"])] });

		const result = ledger.apply({ id: "p", source: "s", revision: 1, actions: [action("c")] });

		expect(result).toMatchObject({ accepted: true, removed: ["a", "b"] });
		expect(ledger.get("p")?.actions.map((item) => item.id)).toEqual(["c"]);
	});

	it("supports explicit removal when no surviving action depends on it", () => {
		const ledger = new PlanLedger();
		ledger.apply({ id: "p", source: "s", revision: 0, actions: [action("a"), action("b")] });

		const result = ledger.apply({ proposalID: "p", source: "s", revision: 1, remove: ["a", "unknown"] });

		expect(result).toMatchObject({ accepted: true, removed: ["a"] });
		expect(ledger.get("p")?.actions.map((item) => item.id)).toEqual(["b"]);
	});

	it.each([
		["empty proposal", { id: " ", source: "s", revision: 0, actions: [] }, "invalid_identity"],
		["empty source", { id: "p", source: "", revision: 0, actions: [] }, "invalid_identity"],
		["fractional revision", { id: "p", source: "s", revision: 0.5, actions: [] }, "invalid_revision"],
		[
			"duplicate action",
			{ id: "p", source: "s", revision: 0, actions: [action("a"), action("a")] },
			"duplicate_action",
		],
		["empty tool", { id: "p", source: "s", revision: 0, actions: [{ ...action("a"), tool: "" }] }, "invalid_action"],
	])("rejects %s", (_label, proposal, reason) => {
		const ledger = new PlanLedger();
		expect(ledger.apply(proposal)).toEqual({ accepted: false, reason });
		expect(ledger.values()).toEqual([]);
	});

	it("rejects stale revisions and cross-source takeover", () => {
		const ledger = new PlanLedger();
		ledger.apply({ id: "p", source: "owner", revision: 4, actions: [action("a")] });

		expect(ledger.apply({ proposalID: "p", source: "owner", revision: 4, upsert: [action("b")] })).toEqual({
			accepted: false,
			reason: "stale_revision",
		});
		expect(ledger.apply({ id: "p", source: "intruder", revision: 5, actions: [] })).toEqual({
			accepted: false,
			reason: "source_mismatch",
		});
		expect(ledger.get("p")?.actions.map((item) => item.id)).toEqual(["a"]);
	});

	it("rejects a delta for a proposal that does not exist", () => {
		const ledger = new PlanLedger();
		expect(ledger.apply({ proposalID: "missing", source: "s", revision: 1, upsert: [action("a")] })).toEqual({
			accepted: false,
			reason: "proposal_missing",
		});
	});

	it.each([
		["missing parent", [action("child", ["missing"])]],
		["self edge", [action("self", ["self"])]],
		["two-node cycle", [action("a", ["b"]), action("b", ["a"])]],
	])("rejects %s without partially mutating the plan", (_label, actions) => {
		const ledger = new PlanLedger();
		ledger.apply({ id: "p", source: "s", revision: 0, actions: [action("safe")] });

		expect(ledger.apply({ id: "p", source: "s", revision: 1, actions })).toEqual({
			accepted: false,
			reason: "invalid_dependency",
		});
		expect(ledger.get("p")?.revision).toBe(0);
		expect(ledger.get("p")?.actions.map((item) => item.id)).toEqual(["safe"]);
	});

	it("rejects removal of a still-required parent transactionally", () => {
		const ledger = new PlanLedger();
		ledger.apply({ id: "p", source: "s", revision: 0, actions: [action("a"), action("b", ["a"])] });

		expect(ledger.apply({ proposalID: "p", source: "s", revision: 1, remove: ["a"] })).toEqual({
			accepted: false,
			reason: "invalid_dependency",
		});
		expect(ledger.get("p")?.actions.map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("returns frozen snapshots and does not expose its action map", () => {
		const ledger = new PlanLedger();
		const result = ledger.apply({ id: "p", source: "s", revision: 0, actions: [action("a")] });
		if (!result.accepted) throw new Error("proposal rejected");

		expect(Object.isFrozen(result.plan)).toBe(true);
		expect(Object.isFrozen(result.plan.actions)).toBe(true);
		expect(Object.isFrozen(result.plan.actions[0])).toBe(true);
		expect(ledger.delete("p")).toBe(true);
		expect(ledger.get("p")).toBeUndefined();
	});

	it("converts a proposal into an equivalent wire delta", () => {
		const proposal = { id: "p", source: "s", revision: 3, actions: [action("a")], draftTokens: 9 };

		expect(proposalAsDelta(proposal)).toEqual({
			proposalID: "p",
			source: "s",
			revision: 3,
			upsert: proposal.actions,
			draftTokens: 9,
		});
	});
});
