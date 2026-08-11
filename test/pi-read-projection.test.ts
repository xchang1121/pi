import type { SettleToolCallResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { READ_RANGE_COVERAGE_DETAILS_KEY, type ReadRangeCoverage } from "../src/action-key-projection.ts";
import { actionKeyMatch, buildPiActionKey } from "../src/common.ts";
import { PI_READ_RANGE_PROJECTION_RULE } from "../src/pi-read-projection.ts";

const cwd = "/workspace";

function readKey(path: string, offset?: number, limit?: number) {
	const action = buildPiActionKey("read", { path, offset, limit }, cwd);
	if (!action) throw new Error("Expected a read action key");
	return action;
}

function coverage(
	lines: readonly string[],
	options: {
		readonly startLine?: number;
		readonly totalLines?: number;
		readonly maxLines?: number;
		readonly maxBytes?: number;
	} = {},
): ReadRangeCoverage {
	const startLine = options.startLine ?? 1;
	const totalLines = options.totalLines ?? startLine + lines.length - 1;
	return {
		kind: "text",
		startLine,
		endLineExclusive: startLine + lines.length,
		totalLines,
		lines,
		maxLines: options.maxLines ?? 2000,
		maxBytes: options.maxBytes ?? 50 * 1024,
		complete: startLine + lines.length === totalLines + 1,
	};
}

function settlement(snapshot?: unknown, text = "speculative output", isError = false): SettleToolCallResult {
	return {
		result: {
			content: [{ type: "text", text }],
			details: snapshot === undefined ? undefined : { [READ_RANGE_COVERAGE_DETAILS_KEY]: snapshot },
		},
		isError,
	};
}

async function project(
	speculative: ReturnType<typeof readKey>,
	actor: ReturnType<typeof readKey>,
	output: SettleToolCallResult,
) {
	const keyMatch = actionKeyMatch(speculative, actor, [PI_READ_RANGE_PROJECTION_RULE]);
	if (keyMatch?.kind !== "projected") throw new Error("Expected a projected read-key match");
	const realizedCoverage = PI_READ_RANGE_PROJECTION_RULE.captureCoverage(speculative, output);
	if (realizedCoverage === undefined) return undefined;
	return PI_READ_RANGE_PROJECTION_RULE.projectOutput({
		speculative,
		actor,
		output,
		coverage: realizedCoverage,
		keyMatch,
	});
}

function outputText(output: SettleToolCallResult | undefined): string | undefined {
	const content = output?.result.content[0];
	return content?.type === "text" ? content.text : undefined;
}

describe("Pi read range projection", () => {
	it("reconstructs a middle subrange and its exact continuation notice", async () => {
		const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`);
		const projected = await project(
			readKey("notes.txt", 1, 10),
			readKey("notes.txt", 3, 2),
			settlement(coverage(lines, { totalLines: 20 })),
		);

		expect(outputText(projected)).toBe("line-3\nline-4\n\n[16 more lines in file. Use offset=5 to continue.]");
		expect(projected?.result.details).toEqual(
			expect.objectContaining({
				[READ_RANGE_COVERAGE_DETAILS_KEY]: expect.objectContaining({
					startLine: 3,
					endLineExclusive: 5,
					lines: ["line-3", "line-4"],
					complete: false,
				}),
			}),
		);
	});

	it("preserves default-view semantics by reading through EOF", async () => {
		const projected = await project(
			readKey("notes.txt", 1, 2),
			readKey("notes.txt", 3),
			settlement(coverage(["one", "two", "three", "four", "five"])),
		);

		expect(outputText(projected)).toBe("three\nfour\nfive");
	});

	it("reconstructs the intentionally empty zero-limit view", async () => {
		const projected = await project(
			readKey("notes.txt", 1, 5),
			readKey("notes.txt", 2, 0),
			settlement(coverage(["one", "two", "three", "four", "five"])),
		);

		expect(outputText(projected)).toBe("\n\n[4 more lines in file. Use offset=2 to continue.]");
	});

	it("uses complete realized coverage beyond the speculative view", async () => {
		const projected = await project(
			readKey("notes.txt", 1, 10),
			readKey("notes.txt", 2, 20),
			settlement(coverage(["one", "two", "three", "four", "five"])),
		);

		expect(outputText(projected)).toBe("two\nthree\nfour\nfive");
	});

	it("rejects an actor view outside incomplete realized coverage", async () => {
		const projected = await project(
			readKey("notes.txt", 1, 4),
			readKey("notes.txt", 3, 3),
			settlement(coverage(["one", "two", "three", "four"], { totalLines: 10 })),
		);

		expect(projected).toBeUndefined();
	});

	it("preserves CRLF bytes represented in structured lines", async () => {
		const projected = await project(
			readKey("windows.txt", 1, 3),
			readKey("windows.txt", 2, 2),
			settlement(coverage(["one\r", "two\r", "three"])),
		);

		expect(outputText(projected)).toBe("two\r\nthree");
	});

	it("reapplies line truncation and reports the projected line interval", async () => {
		const projected = await project(
			readKey("long.txt", 1, 5),
			readKey("long.txt", 1, 4),
			settlement(coverage(["one", "two", "three", "four", "five"], { maxLines: 2 })),
		);

		expect(outputText(projected)).toBe("one\ntwo\n\n[Showing lines 1-2 of 5. Use offset=3 to continue.]");
		expect(projected?.result.details).toEqual(
			expect.objectContaining({
				truncation: expect.objectContaining({ truncated: true, truncatedBy: "lines", outputLines: 2 }),
				[READ_RANGE_COVERAGE_DETAILS_KEY]: expect.objectContaining({
					endLineExclusive: 3,
					lines: ["one", "two"],
				}),
			}),
		);
	});

	it("reapplies byte truncation without splitting a line", async () => {
		const narrowed = await project(
			readKey("bytes.txt", 1, 4),
			readKey("bytes.txt", 1, 3),
			settlement(coverage(["aa", "bb", "cc"], { maxBytes: 5 })),
		);
		expect(outputText(narrowed)).toBe("aa\nbb\n\n[Showing lines 1-2 of 3 (5B limit). Use offset=3 to continue.]");
	});

	it("fails closed when the selected first line alone exceeds the byte limit", async () => {
		const projected = await project(
			readKey("bytes.txt", 1, 3),
			readKey("bytes.txt", 1, 2),
			settlement(coverage(["abcdef", "x", "y"], { maxBytes: 5 })),
		);

		expect(projected).toBeUndefined();
	});

	it.each([
		["mismatched end", { ...coverage(["one", "two"]), endLineExclusive: 9 }],
		["non-string line", { ...coverage(["one", "two"]), lines: ["one", 2] }],
		["false completeness at EOF", { ...coverage(["one", "two"]), complete: false }],
		["non-positive byte limit", { ...coverage(["one", "two"]), maxBytes: 0 }],
		["fractional start", { ...coverage(["one", "two"]), startLine: 1.5 }],
	])("rejects malformed coverage: %s", (_label, malformed) => {
		const output = settlement(malformed);
		expect(PI_READ_RANGE_PROJECTION_RULE.captureCoverage(readKey("notes.txt", 1, 2), output)).toBeUndefined();
	});

	it("does not capture missing coverage, tool errors, or non-read outputs", () => {
		const read = readKey("notes.txt", 1, 2);
		const grep = buildPiActionKey("grep", { pattern: "TODO", path: "." }, cwd);
		expect(PI_READ_RANGE_PROJECTION_RULE.captureCoverage(read, settlement())).toBeUndefined();
		expect(
			PI_READ_RANGE_PROJECTION_RULE.captureCoverage(read, settlement(coverage(["one", "two"]), "error", true)),
		).toBeUndefined();
		expect(grep).toBeDefined();
		if (grep) {
			expect(
				PI_READ_RANGE_PROJECTION_RULE.captureCoverage(grep, settlement(coverage(["one", "two"]))),
			).toBeUndefined();
		}
	});

	it("keeps different resources and grep/find actions outside the read relation", () => {
		const read = readKey("notes.txt", 1, 10);
		expect(actionKeyMatch(read, readKey("other.txt", 2, 2), [PI_READ_RANGE_PROJECTION_RULE])).toBeUndefined();
		for (const tool of ["grep", "find"] as const) {
			const speculative = buildPiActionKey(tool, { path: ".", pattern: "*.ts", limit: 10 }, cwd);
			const actor = buildPiActionKey(tool, { path: ".", pattern: "*.ts", limit: 2 }, cwd);
			expect(speculative).toBeDefined();
			expect(actor).toBeDefined();
			if (speculative && actor) {
				expect(actionKeyMatch(speculative, actor, [PI_READ_RANGE_PROJECTION_RULE])).toBeUndefined();
			}
		}
	});
});
