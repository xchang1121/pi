import { describe, expect, it } from "vitest";
import { READ_RANGE_ACTION_KEY_PROJECTOR } from "../src/action-key-projection.ts";
import { buildPiActionKey } from "../src/common.ts";
import { ToolCache, type ToolCacheEntry } from "../src/tool-cache.ts";

interface Entry extends ToolCacheEntry {
	readonly id: string;
}

describe("ToolCache", () => {
	it("isolates scopes without relying on string prefixes and preserves one exact job", () => {
		const cache = new ToolCache<string, Entry>();
		const first = entry("first", "a.txt", 1, 20);
		const duplicate = entry("duplicate", "a.txt", 1, 20);
		const nestedScope = entry("nested", "a.txt", 1, 20);

		expect(cache.insert("session", first)).toBeUndefined();
		expect(cache.insert("session", duplicate)).toBe(first);
		expect(cache.insert("session:child", nestedScope)).toBeUndefined();

		expect(cache.values("session")).toEqual([first]);
		expect(cache.values("session:child")).toEqual([nestedScope]);
	});

	it("ranks projected reads by the least discarded information", () => {
		const cache = new ToolCache<string, Entry>([READ_RANGE_ACTION_KEY_PROJECTOR]);
		const broad = entry("broad", "a.txt", 1, 200);
		const tight = entry("tight", "a.txt", 100, 110);
		const other = entry("other", "b.txt", 100, 110);
		const actor = key("a.txt", 120, 10);
		cache.insert("session", broad);
		cache.insert("session", tight);
		cache.insert("session", other);

		expect(cache.matching("session", actor).map((item) => item.id)).toEqual(["tight", "broad"]);
	});

	it("trims by entry and byte limits in access order", () => {
		const cache = new ToolCache<string, Entry>();
		const first = entry("first", "a.txt", 1, 20, 4);
		const second = entry("second", "b.txt", 1, 20, 4);
		const third = entry("third", "c.txt", 1, 20, 4);
		cache.insert("session", first);
		cache.insert("session", second);
		cache.touch("session", first);
		cache.insert("session", third);

		expect(cache.trim("session", { maxEntries: 2, maxBytes: 8 })).toEqual([second]);
		expect(cache.values("session").map((item) => item.id)).toEqual(["first", "third"]);
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
