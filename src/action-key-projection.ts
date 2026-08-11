import type { ActionKey, ActionKeyProjector, ProjectedActionKeyMatch } from "./common.ts";
import { readActionRange } from "./common.ts";

export interface ActionProjectionCoverage {
	readonly rule: string;
	readonly value: unknown;
}

/** One lossless projection owns the key relation, realized coverage proof, and output reconstruction. */
export interface ActionProjectionRule<Output> extends ActionKeyProjector {
	readonly captureCoverage: (action: ActionKey, output: Output) => unknown | undefined;
	readonly projectOutput: (input: {
		readonly speculative: ActionKey;
		readonly actor: ActionKey;
		readonly output: Output;
		readonly coverage: unknown;
		readonly keyMatch: ProjectedActionKeyMatch;
	}) => Output | undefined | Promise<Output | undefined>;
}

/** In-memory-only metadata; symbol keys never leak into persisted tool-result details. */
export const READ_RANGE_COVERAGE_DETAILS_KEY: unique symbol = Symbol("pi.speculative.readRange");

/** Compact descriptor for the text prefix already present in Pi's read output. */
export interface ReadRangeCoverage {
	readonly kind: "text";
	readonly startLine: number;
	readonly endLineExclusive: number;
	readonly totalLines: number;
	/** UTF-16 length of the file payload before any continuation notice. */
	readonly payloadTextLength: number;
	readonly maxLines: number;
	readonly maxBytes: number;
}

/** π_read narrows a cached read action to the actor's requested interval. */
export const READ_RANGE_ACTION_KEY_PROJECTOR: ActionKeyProjector = {
	id: "read.range",
	partition: readProjectionPartition,
	project: (speculative, actor) => {
		const speculativeRange = readActionRange(speculative);
		const actorRange = readActionRange(actor);
		if (!speculativeRange || !actorRange) return undefined;
		if (readProjectionPartition(speculative) !== readProjectionPartition(actor)) return undefined;
		if (
			speculativeRange.limit === 0 ||
			speculativeRange.offset > actorRange.offset ||
			actorRange.offset > speculativeRange.end + 1
		) {
			return undefined;
		}
		return {
			action: actor,
			distance: actorRange.offset - speculativeRange.offset + Math.abs(speculativeRange.end - actorRange.end),
		};
	},
	canShareInFlight: readRangesShareInFlight,
};

export function readRangesShareInFlight(speculative: ActionKey, actor: ActionKey): boolean {
	const speculativeRange = readActionRange(speculative);
	const actorRange = readActionRange(actor);
	return (
		!!speculativeRange &&
		!!actorRange &&
		readProjectionPartition(speculative) === readProjectionPartition(actor) &&
		speculativeRange.offset <= actorRange.offset &&
		speculativeRange.end >= actorRange.end
	);
}

function readProjectionPartition(action: ActionKey): string | undefined {
	const range = readActionRange(action);
	if (!range) return undefined;
	return JSON.stringify([action.execution, action.schemaHash, action.resources, range.path]);
}
