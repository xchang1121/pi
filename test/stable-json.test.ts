import { describe, expect, test } from "vitest";
import { stableStringify } from "../src/stable-json.ts";

describe("stableStringify", () => {
	test("preserves canonical object and integer-index key order", () => {
		const first = { zebra: 1, "10": "ten", alpha: { right: 2, left: 1 }, "2": "two", "01": "named" };
		const second = { "01": "named", "2": "two", alpha: { left: 1, right: 2 }, "10": "ten", zebra: 1 };

		expect(stableStringify(first)).toBe(stableStringify(second));
		expect(stableStringify(first)).toBe('{"2":"two","10":"ten","01":"named","alpha":{"left":1,"right":2},"zebra":1}');
	});

	test("matches JSON omission and array placeholder semantics", () => {
		const sparse = [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => undefined, Symbol("ignored")];
		sparse.length = 6;

		expect(stableStringify({ omitted: undefined, kept: sparse, negativeZero: -0 })).toBe(
			'{"kept":[null,null,null,null,null,null],"negativeZero":0}',
		);
	});

	test("ignores custom toJSON while retaining enumerable data", () => {
		expect(stableStringify({ value: 1, toJSON: () => ({ replaced: true }) })).toBe('{"value":1}');
		expect(() => stableStringify({ value: 1n })).toThrow(TypeError);
	});
});
