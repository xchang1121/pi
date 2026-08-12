import { createReadToolDefinition, type ReadToolInput } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { READ_RANGE_COVERAGE_DETAILS_KEY, type ReadRangeCoverage } from "../src/action-key-projection.ts";
import { withPiReadCoverage } from "../src/pi-read-projection.ts";

async function execute(source: string, input: ReadToolInput) {
	const tool = createReadToolDefinition("/workspace", {
		operations: {
			access: async () => undefined,
			readFile: async () => Buffer.from(source),
			detectImageMimeType: async () => undefined,
		},
	});
	const result = await tool.execute("read", input, undefined, undefined, undefined as never);
	return withPiReadCoverage(input, result);
}

function coverage(result: Awaited<ReturnType<typeof execute>>): ReadRangeCoverage | undefined {
	return (result.details as { [READ_RANGE_COVERAGE_DETAILS_KEY]?: ReadRangeCoverage } | undefined)?.[
		READ_RANGE_COVERAGE_DETAILS_KEY
	];
}

describe("read coverage on unmodified Pi output", () => {
	it("recovers the payload before Pi's continuation notice", async () => {
		const result = await execute("one\ntwo\nthree\nfour", { path: "notes.txt", offset: 2, limit: 2 });
		expect(coverage(result)).toEqual({
			kind: "text",
			startLine: 2,
			endLineExclusive: 4,
			totalLines: 4,
			payloadTextLength: "two\nthree".length,
			maxLines: 2000,
			maxBytes: 50 * 1024,
		});
	});

	it("records zero realized lines for limit zero", async () => {
		const result = await execute("one\ntwo", { path: "notes.txt", limit: 0 });
		expect(coverage(result)).toEqual(expect.objectContaining({ startLine: 1, endLineExclusive: 1, totalLines: 2 }));
	});

	it("recovers line-truncated coverage from the stock notice", async () => {
		const source = Array.from({ length: 2002 }, (_, index) => `line-${index + 1}`).join("\n");
		const result = await execute(source, { path: "long.txt" });
		expect(coverage(result)).toEqual(
			expect.objectContaining({ startLine: 1, endLineExclusive: 2001, totalLines: 2002 }),
		);
	});

	it("does not claim coverage when Pi cannot return the first complete line", async () => {
		const result = await execute(`${"x".repeat(50 * 1024 + 1)}\ntail`, { path: "wide.txt" });
		expect(coverage(result)).toBeUndefined();
	});
});
