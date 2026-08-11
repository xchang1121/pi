import { formatSize, type SettleToolCallResult, truncateHead } from "@earendil-works/pi-agent-core";
import {
	type ActionProjectionRule,
	READ_RANGE_ACTION_KEY_PROJECTOR,
	READ_RANGE_COVERAGE_DETAILS_KEY,
	type ReadRangeCoverage,
	readRangesShareInFlight,
} from "./action-key-projection.ts";
import { READ_DEFAULT_LIMIT, readActionRange } from "./common.ts";

/** Production Pi read projection. Other tools remain exact-only. */
export const PI_READ_RANGE_PROJECTION_RULE: ActionProjectionRule<SettleToolCallResult> = {
	...READ_RANGE_ACTION_KEY_PROJECTOR,
	captureCoverage: (action, output) => {
		if (action.tool !== "read" || output.isError) return undefined;
		return parseReadCoverage(readCoverageValue(output.result.details));
	},
	projectOutput: ({ actor, output, coverage }) => {
		if (output.isError) return undefined;
		const actorRange = readActionRange(actor);
		const snapshot = parseReadCoverage(coverage);
		const sourceLines = snapshot ? readCoverageLines(output, snapshot) : undefined;
		if (!actorRange || !snapshot || !sourceLines || actorRange.offset > snapshot.totalLines) return undefined;

		const selectionEndExclusive =
			actorRange.limit === READ_DEFAULT_LIMIT
				? snapshot.totalLines + 1
				: Math.min(actorRange.offset + actorRange.limit, snapshot.totalLines + 1);
		if (actorRange.offset < snapshot.startLine || selectionEndExclusive > snapshot.endLineExclusive) {
			return undefined;
		}

		const selectedLines = sourceLines.slice(
			actorRange.offset - snapshot.startLine,
			selectionEndExclusive - snapshot.startLine,
		);
		const selectedContent = selectedLines.join("\n");
		const truncation = truncateHead(selectedContent, {
			maxLines: snapshot.maxLines,
			maxBytes: snapshot.maxBytes,
		});
		if (truncation.firstLineExceedsLimit) return undefined;

		const startLine = actorRange.offset;
		const startLineIndex = startLine - 1;
		let outputText: string;
		if (truncation.truncated) {
			const endLine = startLine + truncation.outputLines - 1;
			const nextOffset = endLine + 1;
			outputText = truncation.content;
			if (truncation.truncatedBy === "lines") {
				outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${snapshot.totalLines}. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${snapshot.totalLines} (${formatSize(snapshot.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
			}
		} else if (
			actorRange.limit !== READ_DEFAULT_LIMIT &&
			startLineIndex + selectedLines.length < snapshot.totalLines
		) {
			const remaining = snapshot.totalLines - (startLineIndex + selectedLines.length);
			const nextOffset = startLine + selectedLines.length;
			outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText = truncation.content;
		}

		const realizedLineCount = truncation.truncated ? truncation.outputLines : selectedLines.length;
		const projectedCoverage: ReadRangeCoverage = {
			kind: "text",
			startLine,
			endLineExclusive: startLine + realizedLineCount,
			totalLines: snapshot.totalLines,
			payloadTextLength: truncation.content.length,
			maxLines: snapshot.maxLines,
			maxBytes: snapshot.maxBytes,
		};
		return {
			result: {
				...output.result,
				content: [{ type: "text", text: outputText }],
				details: {
					...(truncation.truncated ? { truncation } : {}),
					[READ_RANGE_COVERAGE_DETAILS_KEY]: projectedCoverage,
				},
			},
			isError: false,
		};
	},
	canShareInFlight: readRangesShareInFlight,
};

function parseReadCoverage(value: unknown): ReadRangeCoverage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.kind !== "text") return undefined;
	const startLine = finiteInteger(record.startLine);
	const endLineExclusive = finiteInteger(record.endLineExclusive);
	const totalLines = finiteInteger(record.totalLines);
	const payloadTextLength = finiteInteger(record.payloadTextLength);
	const maxLines = finiteInteger(record.maxLines);
	const maxBytes = finiteInteger(record.maxBytes);
	if (
		startLine === undefined ||
		endLineExclusive === undefined ||
		totalLines === undefined ||
		payloadTextLength === undefined ||
		maxLines === undefined ||
		maxBytes === undefined ||
		startLine < 1 ||
		totalLines < 1 ||
		payloadTextLength < 0 ||
		maxLines < 1 ||
		maxBytes < 1 ||
		endLineExclusive < startLine ||
		endLineExclusive > totalLines + 1
	) {
		return undefined;
	}
	return {
		kind: "text",
		startLine,
		endLineExclusive,
		totalLines,
		payloadTextLength,
		maxLines,
		maxBytes,
	};
}

function readCoverageValue(details: unknown): unknown {
	if (!details || typeof details !== "object") return undefined;
	return (details as { readonly [READ_RANGE_COVERAGE_DETAILS_KEY]?: unknown })[READ_RANGE_COVERAGE_DETAILS_KEY];
}

function readCoverageLines(output: SettleToolCallResult, coverage: ReadRangeCoverage): readonly string[] | undefined {
	const content = output.result.content[0];
	if (!content || content.type !== "text" || coverage.payloadTextLength > content.text.length) return undefined;
	const payload = content.text.slice(0, coverage.payloadTextLength);
	const lineCount = coverage.endLineExclusive - coverage.startLine;
	const lines = lineCount === 0 ? [] : payload.split("\n");
	return lines.length === lineCount ? lines : undefined;
}

function finiteInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
