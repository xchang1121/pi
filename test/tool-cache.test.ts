import { describe, expect, it } from "vitest";
import { READ_RANGE_ACTION_KEY_PROJECTOR } from "../src/action-key-projection.ts";
import { buildPiActionKey } from "../src/common.ts";
import { ToolCache, type ToolCacheEntry } from "../src/tool-cache.ts";

interface Entry extends ToolCacheEntry {
	readonly id: string;
}

describe("ToolCache probation/protected lifecycle", () => {
	it("isolates scopes, preserves one exact job, and inserts speculation into probation", () => {
		const cache = new ToolCache<string, Entry>();
		const first = entry("first", "a.txt", 1, 20);
		const duplicate = entry("duplicate", "a.txt", 1, 20);
		const nestedScope = entry("nested", "a.txt", 1, 20);

		expect(cache.insert("session", first)).toBeUndefined();
		expect(cache.insert("session", duplicate)).toBe(first);
		expect(cache.insert("session:child", nestedScope)).toBeUndefined();

		expect(cache.values("session")).toEqual([first]);
		expect(cache.values("session:child")).toEqual([nestedScope]);
		expect(cache.stateOf("session", first)).toBe("probation");
		expect(cache.snapshot("session")).toEqual({
			probationEntries: 1,
			protectedEntries: 0,
			probationBytes: 1,
			protectedBytes: 0,
		});
	});

	it("ranks projected reads without mutating tier state or recency", () => {
		const cache = new ToolCache<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		const broad = entry("broad", "a.txt", 1, 200);
		const tight = entry("tight", "a.txt", 100, 110);
		const other = entry("other", "b.txt", 100, 110);
		const actor = key("a.txt", 120, 10);
		cache.insert("session", broad);
		cache.insert("session", tight);
		cache.insert("session", other);

		expect(cache.lookup("session", actor).map((item) => [item.entry.id, item.match.distance, item.state])).toEqual([
			["tight", 100, "probation"],
			["broad", 190, "probation"],
		]);
		expect(cache.values("session")).toEqual([broad, tight, other]);
	});

	it("atomically preserves one exact single-flight owner and its current tier", () => {
		const cache = new ToolCache<string, Entry>();
		const owner = entry("owner", "a.txt", 1, 20);
		const duplicate = entry("duplicate", "a.txt", 1, 20);
		const first = cache.insertOrGetCompatible("session", owner);
		cache.recordActorHit("session", owner);
		let projectedPredicateCalls = 0;
		const second = cache.insertOrGetCompatible("session", duplicate, () => {
			projectedPredicateCalls++;
			return false;
		});

		expect(first).toEqual({
			entry: owner,
			inserted: true,
			match: { kind: "exact", distance: 0 },
			state: "probation",
		});
		expect(second).toEqual({
			entry: owner,
			inserted: false,
			match: { kind: "exact", distance: 0 },
			state: "protected",
		});
		expect(projectedPredicateCalls).toBe(0);
		expect(cache.values("session")).toEqual([owner]);
	});

	it("coalesces projected insertion only in the source-to-request direction", () => {
		const broad = entry("broad", "a.txt", 1, 200);
		const narrow = entry("narrow", "a.txt", 100, 10);
		const broadFirst = new ToolCache<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		broadFirst.insertOrGetCompatible("session", broad);

		expect(
			broadFirst.insertOrGetCompatible("session", narrow, (_existing, match) => match.kind === "projected"),
		).toMatchObject({
			entry: broad,
			inserted: false,
			match: { kind: "projected", projector: "read.range" },
			state: "probation",
		});
		expect(broadFirst.values("session")).toEqual([broad]);

		const narrowFirst = new ToolCache<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		narrowFirst.insertOrGetCompatible("session", narrow);
		expect(narrowFirst.insertOrGetCompatible("session", broad, () => true)).toEqual({
			entry: broad,
			inserted: true,
			match: { kind: "exact", distance: 0 },
			state: "probation",
		});
		expect(narrowFirst.values("session")).toEqual([narrow, broad]);
	});

	it("keeps a projected request separate when lifecycle compatibility rejects every source", () => {
		const cache = new ToolCache<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		const broad = entry("broad", "a.txt", 1, 200);
		const tight = entry("tight", "a.txt", 80, 80);
		const requested = entry("requested", "a.txt", 100, 10);
		cache.insert("session", broad);
		cache.insert("session", tight);
		const visited: string[] = [];

		const result = cache.insertOrGetCompatible("session", requested, (existing) => {
			visited.push(existing.id);
			return false;
		});

		expect(visited).toEqual(["tight", "broad"]);
		expect(result).toEqual({
			entry: requested,
			inserted: true,
			match: { kind: "exact", distance: 0 },
			state: "probation",
		});
		expect(cache.values("session")).toEqual([broad, tight, requested]);
	});

	it("does not let prediction-only lookup refresh recency or protection", () => {
		const cache = new ToolCache<string, Entry>();
		const first = entry("first", "a.txt", 1, 20, 4);
		const second = entry("second", "b.txt", 1, 20, 4);
		const third = entry("third", "c.txt", 1, 20, 4);
		cache.insert("session", first);
		cache.insert("session", second);
		expect(cache.lookup("session", first.key)[0]?.entry).toBe(first);
		cache.insert("session", third);

		expect(cache.trim("session", { maxEntries: 2, maxBytes: 8 })).toEqual([first]);
		expect(cache.values("session")).toEqual([second, third]);
	});

	it("promotes only an authoritative actor hit and evicts probation first", () => {
		const cache = new ToolCache<string, Entry>();
		const first = entry("first", "a.txt", 1, 20, 4);
		const second = entry("second", "b.txt", 1, 20, 4);
		const third = entry("third", "c.txt", 1, 20, 4);
		const limits = { maxEntries: 2, maxBytes: 8 };
		cache.insert("session", first);
		cache.insert("session", second);
		expect(cache.recordActorHit("session", first, limits)).toEqual([]);
		cache.insert("session", third);

		expect(cache.trim("session", limits)).toEqual([second]);
		expect(cache.values("session")).toEqual([first, third]);
		expect(cache.stateOf("session", first)).toBe("protected");
		expect(cache.stateOf("session", third)).toBe("probation");
		expect(cache.snapshot("session")).toEqual({
			probationEntries: 1,
			protectedEntries: 1,
			probationBytes: 4,
			protectedBytes: 4,
		});
	});

	it("ignores hits for absent entries and exact-key impostors", () => {
		const cache = new ToolCache<string, Entry>();
		const stored = entry("stored", "a.txt", 1, 20);
		const impostor = entry("impostor", "a.txt", 1, 20);
		cache.insert("session", stored);

		expect(cache.recordActorHit("missing", stored)).toEqual([]);
		expect(cache.recordActorHit("session", impostor)).toEqual([]);
		expect(cache.stateOf("session", stored)).toBe("probation");
	});

	it("bounds protected entry occupancy by demoting the oldest protected entry", () => {
		const cache = new ToolCache<string, Entry>();
		const limits = { maxEntries: 4, maxBytes: 100, protectedFraction: 0.5 };
		const first = entry("first", "a.txt", 1, 20, 4);
		const second = entry("second", "b.txt", 1, 20, 4);
		const third = entry("third", "c.txt", 1, 20, 4);
		for (const item of [first, second, third]) cache.insert("session", item);
		cache.recordActorHit("session", first, limits);
		cache.recordActorHit("session", second, limits);

		expect(cache.recordActorHit("session", third, limits)).toEqual([first]);
		expect(cache.stateOf("session", first)).toBe("probation");
		expect(cache.stateOf("session", second)).toBe("protected");
		expect(cache.stateOf("session", third)).toBe("protected");
	});

	it("refreshes a repeated actor hit before protected demotion", () => {
		const cache = new ToolCache<string, Entry>();
		const limits = { maxEntries: 2, maxBytes: 100, protectedFraction: 0.5 };
		const first = entry("first", "a.txt", 1, 20);
		const second = entry("second", "b.txt", 1, 20);
		cache.insert("session", first);
		cache.insert("session", second);
		cache.recordActorHit("session", first);
		cache.recordActorHit("session", second);

		expect(cache.recordActorHit("session", first, limits)).toEqual([second]);
		expect(cache.stateOf("session", first)).toBe("protected");
		expect(cache.stateOf("session", second)).toBe("probation");
	});

	it("bounds protected bytes and makes a demoted oversized entry evictable", () => {
		const cache = new ToolCache<string, Entry>();
		const limits = { maxEntries: 4, maxBytes: 10, protectedFraction: 0.5 };
		const large = entry("large", "a.txt", 1, 20, 8);
		const small = entry("small", "b.txt", 1, 20, 2);
		cache.insert("session", large);
		cache.insert("session", small);

		expect(cache.recordActorHit("session", large, limits)).toEqual([large]);
		expect(cache.recordActorHit("session", small, limits)).toEqual([]);
		expect(cache.trim("session", { maxEntries: 1, maxBytes: 2 })).toEqual([large]);
		expect(cache.values("session")).toEqual([small]);
	});

	it.each([
		["zero", 0],
		["negative", -1],
	])("allows %s protected capacity to demote every hit", (_label, protectedFraction) => {
		const cache = new ToolCache<string, Entry>();
		const item = entry("item", "a.txt", 1, 20);
		cache.insert("session", item);

		expect(cache.recordActorHit("session", item, { maxEntries: 2, maxBytes: 10, protectedFraction })).toEqual([item]);
		expect(cache.stateOf("session", item)).toBe("probation");
	});

	it("uses the default fraction for NaN and clamps fractions above one", () => {
		const cache = new ToolCache<string, Entry>();
		const first = entry("first", "a.txt", 1, 20);
		const second = entry("second", "b.txt", 1, 20);
		cache.insert("session", first);
		cache.insert("session", second);

		expect(
			cache.recordActorHit("session", first, {
				maxEntries: 2,
				maxBytes: 10,
				protectedFraction: Number.NaN,
			}),
		).toEqual([]);
		expect(cache.recordActorHit("session", second, { maxEntries: 2, maxBytes: 10, protectedFraction: 2 })).toEqual(
			[],
		);
		expect(cache.snapshot("session").protectedEntries).toBe(2);
	});

	it("honors a non-evictable probation entry while trimming a protected entry", () => {
		const cache = new ToolCache<string, Entry>();
		const pinned = entry("pinned", "a.txt", 1, 20, 4);
		const protectedEntry = entry("protected", "b.txt", 1, 20, 4);
		cache.insert("session", pinned);
		cache.insert("session", protectedEntry);
		cache.recordActorHit("session", protectedEntry);

		expect(cache.trim("session", { maxEntries: 1, maxBytes: 4 }, (item) => item !== pinned)).toEqual([
			protectedEntry,
		]);
		expect(cache.values("session")).toEqual([pinned]);
	});

	it("normalizes malformed limits and byte estimates without corrupting eviction", () => {
		const cache = new ToolCache<string, Entry>();
		const negative = { ...entry("negative", "a.txt", 1, 20), estimatedBytes: -10 };
		const infinite = { ...entry("infinite", "b.txt", 1, 20), estimatedBytes: Number.POSITIVE_INFINITY };
		cache.insert("session", negative);
		cache.insert("session", infinite);

		expect(cache.snapshot("session").probationBytes).toBe(0);
		expect(cache.trim("session", { maxEntries: Number.NaN, maxBytes: Number.NaN })).toEqual([negative, infinite]);
		expect(cache.values("session")).toEqual([]);
	});

	it("removes projection indexes and empty scopes on delete and clear", () => {
		const cache = new ToolCache<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		const item = entry("item", "a.txt", 1, 200);
		cache.insert("session", item);
		expect(cache.delete("session", item)).toBe(true);
		expect(cache.lookup("session", key("a.txt", 20, 10))).toEqual([]);
		expect(cache.scopes()).toEqual([]);

		cache.insert("one", item);
		cache.insert("two", entry("two", "b.txt", 1, 20));
		expect(cache.clearScope("one")).toEqual([item]);
		expect(cache.snapshot("one")).toEqual({
			probationEntries: 0,
			protectedEntries: 0,
			probationBytes: 0,
			protectedBytes: 0,
		});
		expect(cache.scopes()).toEqual(["two"]);
	});
});

function entry(id: string, path: string, offset: number, limit: number, estimatedBytes = 1): Entry {
	return { id, key: key(path, offset, limit), estimatedBytes };
}

function key(path: string, offset: number, limit: number) {
	const action = buildPiActionKey("read", { path, offset, limit }, "/workspace");
	if (!action) throw new Error("Expected a read action key");
	return action;
}
