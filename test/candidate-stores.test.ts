import { describe, expect, it } from "vitest";
import { READ_RANGE_ACTION_KEY_PROJECTOR } from "../src/action-key-projection.ts";
import { ActionStore, ResultCache } from "../src/candidate-stores.ts";
import type { ActionKey } from "../src/common.ts";
import { actionKeyCovers, buildPiActionKey } from "../src/common.ts";

interface Entry {
	readonly id: string;
	readonly key: ReturnType<typeof key>;
	readonly estimatedBytes: number;
}

describe("ActionStore", () => {
	it("keeps one exact owner and directionally reuses the tightest compatible projection", () => {
		const store = new ActionStore<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		const broad = entry("broad", "a.ts", 1, 200);
		const tight = entry("tight", "a.ts", 80, 60);
		const requested = entry("requested", "a.ts", 100, 10);
		store.insertOrGetCompatible("one", broad);
		store.insertOrGetCompatible("one", tight);

		const compatible = store.insertOrGetCompatible("one", requested, (existing) =>
			actionKeyCovers(existing.key, requested.key, [READ_RANGE_ACTION_KEY_PROJECTOR]),
		);
		expect(compatible).toMatchObject({
			entry: tight,
			inserted: false,
			match: { kind: "projected", projector: "read.range" },
		});
		expect(store.insertOrGetCompatible("one", entry("duplicate", "a.ts", 80, 60))).toMatchObject({
			entry: tight,
			inserted: false,
			match: { kind: "exact" },
		});
		expect(store.lookup("one", requested.key).map((item) => item.entry.id)).toEqual(["tight", "broad"]);
		expect(store.lookup("two", requested.key)).toEqual([]);
	});

	it("deletes by identity and enforces count and byte bounds without evicting a protected target", () => {
		const store = new ActionStore<string, Entry>();
		const first = entry("first", "a.ts", 1, 20, 4);
		const second = entry("second", "b.ts", 1, 20, 8);
		const newest = entry("newest", "c.ts", 1, 20, 16);
		store.insert("session", first);
		store.insert("session", second);
		store.insert("session", newest);

		expect(store.delete("session", entry("impostor", "a.ts", 1, 20, 4))).toBe(false);
		expect(store.trim("session", { maxEntries: 2, maxBytes: 20 }, (item) => item !== newest)).toEqual([
			first,
			second,
		]);
		expect(store.values("session")).toEqual([newest]);
		expect(store.snapshot("session")).toEqual({ entries: 1, bytes: 16 });
	});
});

describe("ResultCache", () => {
	it("keeps probation/protected state scoped and evicts probation before actor-validated results", () => {
		const cache = new ResultCache<string, Entry>();
		const shared = entry("shared", "a.ts", 1, 20, 8);
		const probation = entry("probation", "b.ts", 1, 20, 8);
		cache.insert("one", shared);
		cache.insert("two", shared);
		cache.insert("one", probation);
		cache.recordActorHit("one", shared);

		expect(cache.stateOf("one", shared)).toBe("protected");
		expect(cache.stateOf("two", shared)).toBe("probation");
		expect(cache.trim("one", { maxEntries: 1, maxBytes: 8 })).toEqual([probation]);
		expect(cache.values("one")).toEqual([shared]);
		expect(cache.snapshot("one")).toEqual({
			probationEntries: 0,
			protectedEntries: 1,
			probationBytes: 0,
			protectedBytes: 8,
		});
	});

	it("keeps in-flight, reusable, and exclusive entries independent at the same action key", () => {
		const jobs = new ActionStore<string, Entry>();
		const results = new ResultCache<string, Entry>();
		const branches = new ActionStore<string, Entry>();
		const job = entry("job", "a.ts");
		const result = entry("result", "a.ts");
		const branch = entry("branch", "a.ts");
		jobs.insert("session", job);
		results.insert("session", result);
		branches.insert("session", branch);

		expect(jobs.delete("session", job)).toBe(true);
		expect(results.getExact("session", result.key)).toBe(result);
		expect(branches.getExact("session", branch.key)).toBe(branch);
		expect(results.trim("session", { maxEntries: 0, maxBytes: 0 })).toEqual([result]);
		expect(branches.values("session")).toEqual([branch]);
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
