import { describe, expect, it } from "vitest";
import { READ_RANGE_ACTION_KEY_PROJECTOR } from "../src/action-key-projection.ts";
import { BranchStore, JobTable, ResultCache } from "../src/candidate-stores.ts";
import type { ActionKey } from "../src/common.ts";
import { actionKeyCovers, buildPiActionKey } from "../src/common.ts";

interface Entry {
	readonly id: string;
	readonly key: ReturnType<typeof key>;
	readonly estimatedBytes: number;
}

describe("JobTable", () => {
	it("preserves one exact single-flight owner without assigning cache lifecycle state", () => {
		const table = new JobTable<string, Entry>();
		const owner = entry("owner", "a.ts");
		const duplicate = entry("duplicate", "a.ts");

		expect(table.insertOrGetCompatible("session", owner)).toEqual({
			entry: owner,
			match: { kind: "exact", distance: 0 },
			inserted: true,
		});
		expect(table.insertOrGetCompatible("session", duplicate)).toEqual({
			entry: owner,
			match: { kind: "exact", distance: 0 },
			inserted: false,
		});
		expect(table.values("session")).toEqual([owner]);
	});

	it("coalesces only a directionally covered projected job when explicitly approved", () => {
		const table = new JobTable<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		const broad = entry("broad", "a.ts", 1, 200);
		const narrow = entry("narrow", "a.ts", 100, 10);
		const wider = entry("wider", "a.ts", 1, 400);
		table.insertOrGetCompatible("session", broad);

		const covered = (existing: Entry, requested: Entry) =>
			actionKeyCovers(existing.key, requested.key, [READ_RANGE_ACTION_KEY_PROJECTOR]);
		expect(table.insertOrGetCompatible("session", narrow, (existing) => covered(existing, narrow))).toMatchObject({
			entry: broad,
			inserted: false,
			match: { kind: "projected", projector: "read.range" },
		});
		expect(table.insertOrGetCompatible("session", wider, (existing) => covered(existing, wider))).toMatchObject({
			entry: wider,
			inserted: true,
		});
		expect(table.values("session")).toEqual([broad, wider]);
	});

	it("ranks the tightest compatible in-flight job and isolates sessions", () => {
		const table = new JobTable<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		const broad = entry("broad", "a.ts", 1, 200);
		const tight = entry("tight", "a.ts", 80, 60);
		const otherSession = entry("other", "a.ts", 100, 10);
		table.insertOrGetCompatible("one", broad);
		table.insertOrGetCompatible("one", tight);
		table.insertOrGetCompatible("two", otherSession);

		expect(table.lookup("one", key("a.ts", 100, 10)).map((item) => item.entry.id)).toEqual(["tight", "broad"]);
		expect(table.lookup("two", key("a.ts", 100, 10)).map((item) => item.entry.id)).toEqual(["other"]);
		expect(table.scopes()).toEqual(["one", "two"]);
	});

	it("uses object identity for deletion and clears every index for a scope", () => {
		const table = new JobTable<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		const stored = entry("stored", "a.ts", 1, 200);
		const impostor = entry("impostor", "a.ts", 1, 200);
		table.insertOrGetCompatible("session", stored);

		expect(table.delete("session", impostor)).toBe(false);
		expect(table.getExact("session", stored.key)).toBe(stored);
		expect(table.clearScope("session")).toEqual([stored]);
		expect(table.lookup("session", key("a.ts", 100, 10))).toEqual([]);
		expect(table.allValues()).toEqual([]);
	});
});

describe("separated result and branch stores", () => {
	it("makes a result cacheable only after its job-table owner is explicitly removed", () => {
		const jobs = new JobTable<string, Entry>();
		const results = new ResultCache<string, Entry>();
		const candidate = entry("candidate", "a.ts");
		jobs.insertOrGetCompatible("session", candidate);

		expect(results.values("session")).toEqual([]);
		expect(results.snapshot("session")).toEqual({
			probationEntries: 0,
			protectedEntries: 0,
			probationBytes: 0,
			protectedBytes: 0,
		});
		expect(jobs.delete("session", candidate)).toBe(true);
		expect(results.insert("session", candidate)).toBeUndefined();
		expect(jobs.values("session")).toEqual([]);
		expect(results.values("session")).toEqual([candidate]);
		expect(results.stateOf("session", candidate)).toBe("probation");
	});

	it("tracks probation and protection independently when one entry identity is stored in two scopes", () => {
		const results = new ResultCache<string, Entry>();
		const sharedObject = entry("shared", "a.ts");
		results.insert("one", sharedObject);
		results.insert("two", sharedObject);
		results.recordActorHit("one", sharedObject);

		expect(results.stateOf("one", sharedObject)).toBe("protected");
		expect(results.stateOf("two", sharedObject)).toBe("probation");
		expect(results.snapshot("one")).toMatchObject({ probationEntries: 0, protectedEntries: 1 });
		expect(results.snapshot("two")).toMatchObject({ probationEntries: 1, protectedEntries: 0 });
	});

	it("keeps result-cache eviction completely independent from running jobs and branches", () => {
		const jobs = new JobTable<string, Entry>();
		const results = new ResultCache<string, Entry>();
		const branches = new BranchStore<string, Entry>();
		const job = entry("job", "job.ts");
		const result = entry("result", "result.ts");
		const branch = entry("branch", "branch.ts");
		jobs.insertOrGetCompatible("session", job);
		results.insert("session", result);
		branches.insert("session", branch);

		expect(results.trim("session", { maxEntries: 0, maxBytes: 0 })).toEqual([result]);
		expect(jobs.values("session")).toEqual([job]);
		expect(branches.values("session")).toEqual([branch]);
	});

	it("preserves the first exact branch and never gives it probation/protected state", () => {
		const branches = new BranchStore<string, Entry>();
		const first = entry("first", "a.ts");
		const duplicate = entry("duplicate", "a.ts");

		expect(branches.insert("session", first)).toBeUndefined();
		expect(branches.insert("session", duplicate)).toBe(first);
		expect(branches.values("session")).toEqual([first]);
		expect(branches.snapshot("session")).toEqual({ entries: 1, bytes: first.estimatedBytes });
	});

	it("bounds branches by both count and bytes while respecting a non-evictable adoption target", () => {
		const branches = new BranchStore<string, Entry>();
		const first = entry("first", "a.ts", 1, 20, 4);
		const second = entry("second", "b.ts", 1, 20, 8);
		const newest = entry("newest", "c.ts", 1, 20, 16);
		branches.insert("session", first);
		branches.insert("session", second);
		branches.insert("session", newest);

		expect(branches.trim("session", { maxEntries: 2, maxBytes: 20 }, (item) => item !== newest)).toEqual([
			first,
			second,
		]);
		expect(branches.values("session")).toEqual([newest]);
		expect(branches.snapshot("session")).toEqual({ entries: 1, bytes: 16 });
	});

	it("allows the same action key in each layer so transitions cannot overwrite another layer implicitly", () => {
		const jobs = new JobTable<string, Entry>();
		const results = new ResultCache<string, Entry>();
		const branches = new BranchStore<string, Entry>();
		const job = entry("job", "a.ts");
		const result = entry("result", "a.ts");
		const branch = entry("branch", "a.ts");
		jobs.insertOrGetCompatible("session", job);
		results.insert("session", result);
		branches.insert("session", branch);

		expect(jobs.getExact("session", job.key)).toBe(job);
		expect(results.getExact("session", result.key)).toBe(result);
		expect(branches.getExact("session", branch.key)).toBe(branch);
		expect(jobs.delete("session", job)).toBe(true);
		expect(results.getExact("session", result.key)).toBe(result);
		expect(branches.getExact("session", branch.key)).toBe(branch);
	});

	it("clears branch scopes without disturbing another session", () => {
		const branches = new BranchStore<string, Entry>();
		const one = entry("one", "a.ts");
		const two = entry("two", "b.ts");
		branches.insert("one", one);
		branches.insert("two", two);

		expect(branches.clearScope("one")).toEqual([one]);
		expect(branches.values("one")).toEqual([]);
		expect(branches.values("two")).toEqual([two]);
		expect(branches.allValues()).toEqual([two]);
	});
});

function entry(id: string, path: string, offset = 1, limit = 20, estimatedBytes = 1): Entry {
	return { id, key: key(path, offset, limit), estimatedBytes };
}

function key(path: string, offset = 1, limit = 20) {
	const action = buildPiActionKey("read", { path, offset, limit }, "", "resource_cached");
	if (!action) throw new Error("read action key should be supported");
	return action satisfies ActionKey;
}
