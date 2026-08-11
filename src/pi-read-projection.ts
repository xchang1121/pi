import type { SettleToolCallResult } from "@earendil-works/pi-agent-core";
import {
	type ActionProjectionRule,
	READ_RANGE_ACTION_KEY_PROJECTOR,
	READ_RANGE_COVERAGE_DETAILS_KEY,
	type ReadRangeCoverage,
	readRangesShareInFlight,
} from "./action-key-projection.ts";
import { asRecord, READ_DEFAULT_LIMIT, readActionRange } from "./common.ts";

interface PiReadTruncation {
	readonly content: string;
	readonly truncated: boolean;
	readonly truncatedBy: "lines" | "bytes" | null;
	readonly totalLines: number;
	readonly totalBytes: number;
	readonly outputLines: number;
	readonly outputBytes: number;
	readonly lastLinePartial: false;
	readonly firstLineExceedsLimit: boolean;
	readonly maxLines: number;
	readonly maxBytes: number;
}

/** Production Pi read projection. Other tools remain exact-only. */
export const PI_READ_RANGE_PROJECTION_RULE: ActionProjectionRule<SettleToolCallResult> = {
	...READ_RANGE_ACTION_KEY_PROJECTOR,
	captureCoverage: (action, output) => {
		if (action.tool !== "read" || output.isError) return undefined;
		const details = asRecord(output.result.details);
		return parseReadCoverage(details?.[READ_RANGE_COVERAGE_DETAILS_KEY]);
	},
	projectOutput: ({ actor, output, coverage }) => {
		if (output.isError) return undefined;
		const actorRange = readActionRange(actor);
		const snapshot = parseReadCoverage(coverage);
		if (!actorRange || !snapshot || actorRange.offset > snapshot.totalLines) return undefined;

		const selectionEndExclusive =
			actorRange.limit === READ_DEFAULT_LIMIT
				? snapshot.totalLines + 1
				: Math.min(actorRange.offset + actorRange.limit, snapshot.totalLines + 1);
		if (actorRange.offset < snapshot.startLine || selectionEndExclusive > snapshot.endLineExclusive) {
			return undefined;
		}

		const selectedLines = snapshot.lines.slice(
			actorRange.offset - snapshot.startLine,
			selectionEndExclusive - snapshot.startLine,
		);
		const selectedContent = selectedLines.join("\n");
		const truncation = truncateReadHead(selectedContent, snapshot.maxLines, snapshot.maxBytes);
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
				outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${snapshot.totalLines} (${formatReadSize(snapshot.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
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

		const realizedLines = truncation.truncated ? selectedLines.slice(0, truncation.outputLines) : selectedLines;
		const projectedCoverage: ReadRangeCoverage = {
			kind: "text",
			startLine,
			endLineExclusive: startLine + realizedLines.length,
			totalLines: snapshot.totalLines,
			lines: realizedLines,
			maxLines: snapshot.maxLines,
			maxBytes: snapshot.maxBytes,
			complete: startLine + realizedLines.length === snapshot.totalLines + 1,
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
	const record = asRecord(value);
	if (!record || record.kind !== "text") return undefined;
	const lines = record.lines;
	if (!Array.isArray(lines) || !lines.every((line): line is string => typeof line === "string")) return undefined;
	const startLine = finiteInteger(record.startLine);
	const endLineExclusive = finiteInteger(record.endLineExclusive);
	const totalLines = finiteInteger(record.totalLines);
	const maxLines = finiteInteger(record.maxLines);
	const maxBytes = finiteInteger(record.maxBytes);
	if (
		startLine === undefined ||
		endLineExclusive === undefined ||
		totalLines === undefined ||
		maxLines === undefined ||
		maxBytes === undefined ||
		startLine < 1 ||
		totalLines < 1 ||
		maxLines < 1 ||
		maxBytes < 1 ||
		endLineExclusive !== startLine + lines.length ||
		endLineExclusive > totalLines + 1 ||
		record.complete !== (endLineExclusive === totalLines + 1)
	) {
		return undefined;
	}
	return {
		kind: "text",
		startLine,
		endLineExclusive,
		totalLines,
		lines: [...lines],
		maxLines,
		maxBytes,
		complete: record.complete,
	};
}

function truncateReadHead(content: string, maxLines: number, maxBytes: number): PiReadTruncation {
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}
	if (Buffer.byteLength(lines[0] ?? "", "utf8") > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const outputLines: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let index = 0; index < lines.length && index < maxLines; index++) {
		const lineBytes = Buffer.byteLength(lines[index] ?? "", "utf8") + (index > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		outputLines.push(lines[index] ?? "");
		bytes += lineBytes;
	}
	if (outputLines.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";
	const outputContent = outputLines.join("\n");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLines.length,
		outputBytes: Buffer.byteLength(outputContent, "utf8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

function splitLinesForCounting(content: string): string[] {
	if (!content) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

function finiteInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function formatReadSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
