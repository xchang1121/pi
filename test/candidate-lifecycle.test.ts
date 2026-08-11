import { describe, expect, it, vi } from "vitest";
import { CandidateAggregate, CandidateCatalog } from "../src/candidate-lifecycle.ts";

interface Lease {
	readonly id: string;
	state: "active" | "matched" | "hit" | "expired" | "invalidated";
}

describe("CandidateAggregate", () => {
	it("owns the running-to-ready transition and settles completion exactly once", async () => {
		const aggregate = new CandidateAggregate<string, Lease>("shared");

		expect(aggregate.run).toEqual({ status: "running" });
		expect(aggregate.reuse).toEqual({ kind: "shared" });
		expect(aggregate.markReady("first", 120, 20)).toBe(true);
		expect(aggregate.markReady("second", 130, 30)).toBe(false);
		expect(aggregate.run).toEqual({ status: "ready", completedAt: 120, executionMs: 20, output: "first" });
		expect(aggregate.settleReady()).toBe(true);
		expect(aggregate.settleReady()).toBe(false);
		await expect(aggregate.completion).resolves.toEqual({ ok: true, output: "first" });
		expect(aggregate.controller.signal.aborted).toBe(false);
	});

	it("closes a running candidate once, aborts its execution, and preserves the first failure", async () => {
		const controller = new AbortController();
		const abortListener = vi.fn();
		controller.signal.addEventListener("abort", abortListener);
		const aggregate = new CandidateAggregate<string, Lease>("shared", [], controller);
		const firstError = new Error("first");

		expect(
			aggregate.close({
				reason: "invalidated",
				error: firstError,
				completedAt: Number.POSITIVE_INFINITY,
				executionMs: -5,
			}),
		).toBe(true);
		expect(aggregate.close({ reason: "second", error: new Error("second") })).toBe(false);
		expect(aggregate.markReady("too late", 10, 10)).toBe(false);
		expect(aggregate.settleClosed()).toBe(true);
		expect(aggregate.settleClosed()).toBe(false);
		expect(aggregate.run).toEqual({ status: "closed", reason: "invalidated", completedAt: 0, executionMs: 0 });
		expect(controller.signal.aborted).toBe(true);
		expect(abortListener).toHaveBeenCalledTimes(1);
		await expect(aggregate.completion).resolves.toEqual({ ok: false, error: firstError });
	});

	it("can retire a ready result without rewriting the already-settled successful completion", async () => {
		const aggregate = new CandidateAggregate<{ value: number }, Lease>("shared");
		const output = { value: 42 };

		expect(aggregate.markReady(output, 50, 7)).toBe(true);
		expect(aggregate.settleReady()).toBe(true);
		expect(aggregate.close({ reason: "resource_stale" })).toBe(true);
		expect(aggregate.run).toEqual({
			status: "closed",
			reason: "resource_stale",
			completedAt: 50,
			executionMs: 7,
		});
		await expect(aggregate.completion).resolves.toEqual({ ok: true, output });
	});

	it("lets invalidation win when a ready result has not yet been published for consumption", async () => {
		const aggregate = new CandidateAggregate<string, Lease>("shared");
		const error = new Error("changed during finalization");

		expect(aggregate.markReady("unpublished", 20, 5)).toBe(true);
		expect(aggregate.close({ reason: "resource_stale", error })).toBe(true);
		expect(aggregate.settleReady()).toBe(false);
		expect(aggregate.settleClosed()).toBe(true);
		await expect(aggregate.completion).resolves.toEqual({ ok: false, error });
	});

	it("serializes exclusive claims and permits adoption only for the claiming consumer of a ready result", async () => {
		const aggregate = new CandidateAggregate<string, Lease>("exclusive");

		expect(aggregate.markAdopted()).toBe(false);
		expect(aggregate.claim("turn-a")).toBe(true);
		expect(aggregate.claim("turn-b")).toBe(false);
		expect(aggregate.releaseClaim("turn-b")).toBe(false);
		expect(aggregate.markAdopted()).toBe(false);
		expect(aggregate.reuse).toEqual({ kind: "exclusive", state: "claimed", claimTurnID: "turn-a" });
		expect(aggregate.markReady("result", 100, 12)).toBe(true);
		expect(aggregate.markAdopted()).toBe(false);
		expect(aggregate.settleReady()).toBe(true);
		expect(aggregate.releaseClaim("turn-a")).toBe(true);
		expect(aggregate.claim("turn-b")).toBe(true);
		expect(aggregate.markAdopted(15)).toBe(true);
		expect(aggregate.reuse).toEqual({ kind: "exclusive", state: "adopted" });
		expect(aggregate.run).toEqual({ status: "closed", reason: "adopted", completedAt: 100, executionMs: 15 });
		expect(aggregate.claim("turn-c")).toBe(false);
		expect(aggregate.releaseClaim("turn-b")).toBe(false);
		expect(aggregate.markAdopted()).toBe(false);
		await expect(aggregate.completion).resolves.toEqual({ ok: true, output: "result" });
	});

	it("keeps shared reuse claim-free while still rejecting claims after closure", () => {
		const aggregate = new CandidateAggregate<string, Lease>("shared");

		expect(aggregate.claim("turn-a")).toBe(true);
		expect(aggregate.claim("turn-b")).toBe(true);
		expect(aggregate.releaseClaim("turn-a")).toBe(false);
		expect(aggregate.reuse).toEqual({ kind: "shared" });
		expect(aggregate.close({ reason: "expired" })).toBe(true);
		expect(aggregate.claim("turn-c")).toBe(false);
	});

	it("copies the initial lease list and centralizes additions and pruning", () => {
		const initial: Lease[] = [{ id: "initial", state: "active" }];
		const aggregate = new CandidateAggregate<string, Lease>("shared", initial);
		initial.push({ id: "outside", state: "active" });
		aggregate.addLease({ id: "matched", state: "matched" });
		aggregate.addLease({ id: "expired", state: "expired" });

		expect(aggregate.leases.map((lease) => lease.id)).toEqual(["initial", "matched", "expired"]);
		aggregate.pruneLeases((lease) => lease.state === "active" || lease.state === "matched");
		expect(aggregate.leases.map((lease) => lease.id)).toEqual(["initial", "matched"]);
	});
});

describe("CandidateCatalog", () => {
	it("maintains identity ownership with independent session and turn indexes", () => {
		const catalog = new CandidateCatalog<string, object, { readonly id: string }>();
		const first = { id: "same-key" };
		const second = { id: "same-key" };
		const owner = { id: "owner" };

		catalog.register("session-a", "session-a:turn-1", first, owner);
		catalog.register("session-a", "session-a:turn-1", second, owner);
		expect(catalog.sessionValues("session-a")).toEqual([first, second]);
		expect(catalog.turnValues("session-a:turn-1")).toEqual([first, second]);
		expect(catalog.owner(first)).toBe(owner);
		expect(catalog.record(first)).toEqual({
			sessionID: "session-a",
			owner,
			turns: new Set(["session-a:turn-1"]),
		});
	});

	it("attaches and detaches turns idempotently without changing session ownership", () => {
		const catalog = new CandidateCatalog<string, object, string>();
		const candidate = {};
		catalog.register("session", "turn-a", candidate, "owner");

		expect(catalog.attachTurn(candidate, "turn-b")).toBe(true);
		expect(catalog.attachTurn(candidate, "turn-b")).toBe(true);
		expect(catalog.turnValues("turn-b")).toEqual([candidate]);
		expect(catalog.detachTurn(candidate, "turn-b")).toBe(true);
		expect(catalog.detachTurn(candidate, "turn-b")).toBe(false);
		expect(catalog.sessionValues("session")).toEqual([candidate]);
		expect(catalog.record(candidate)?.turns).toEqual(new Set(["turn-a"]));
	});

	it("returns defensive record snapshots and detaches every candidate from a finished turn", () => {
		const catalog = new CandidateCatalog<string, object, string>();
		const first = {};
		const second = {};
		catalog.register("session", "turn-a", first, "first-owner");
		catalog.register("session", "turn-b", second, "second-owner");
		catalog.attachTurn(second, "turn-a");
		const snapshot = catalog.record(first);
		(snapshot?.turns as Set<string>).clear();

		expect(catalog.turnValues("turn-a")).toEqual([first, second]);
		catalog.detachAllFromTurn("turn-a");
		expect(catalog.turnValues("turn-a")).toEqual([]);
		expect(catalog.record(first)?.turns).toEqual(new Set());
		expect(catalog.record(second)?.turns).toEqual(new Set(["turn-b"]));
		expect(catalog.sessionValues("session")).toEqual([first, second]);
	});

	it("retires a candidate atomically from every index and tolerates unknown identities", () => {
		const catalog = new CandidateCatalog<string, object, string>();
		const candidate = {};
		const unknown = {};
		catalog.register("session", "turn-a", candidate, "owner");
		catalog.attachTurn(candidate, "turn-b");

		expect(catalog.retire(candidate)).toBe(true);
		expect(catalog.retire(candidate)).toBe(false);
		expect(catalog.retire(unknown)).toBe(false);
		expect(catalog.attachTurn(unknown, "turn-c")).toBe(false);
		expect(catalog.detachTurn(unknown, "turn-c")).toBe(false);
		expect(catalog.owner(candidate)).toBeUndefined();
		expect(catalog.record(candidate)).toBeUndefined();
		expect(catalog.sessionValues("session")).toEqual([]);
		expect(catalog.turnValues("turn-a")).toEqual([]);
		expect(catalog.turnValues("turn-b")).toEqual([]);
		expect(catalog.allValues()).toEqual([]);
	});

	it("rejects duplicate registration of the same candidate identity", () => {
		const catalog = new CandidateCatalog<string, object, string>();
		const candidate = {};
		catalog.register("session", "turn-a", candidate, "owner");

		expect(() => catalog.register("session", "turn-b", candidate, "other-owner")).toThrow(
			"candidate is already registered",
		);
	});
});
