import { describe, expect, it, vi } from "vitest";
import { CandidateAggregate } from "../src/candidate-lifecycle.ts";

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
