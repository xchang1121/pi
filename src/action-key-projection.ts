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
	/** Directed in-flight coalescing is opt-in and independent from completed-result projection. */
	readonly canShareInFlight?: (speculative: ActionKey, actor: ActionKey) => boolean;
}

export const READ_RANGE_COVERAGE_DETAILS_KEY = "speculativeReadRange";

/** Structured text payload emitted by Pi's read tool; line numbers are 1-indexed and end-exclusive. */
export interface ReadRangeCoverage {
	readonly kind: "text";
	readonly startLine: number;
	readonly endLineExclusive: number;
	readonly totalLines: number;
	readonly lines: readonly string[];
	readonly maxLines: number;
	readonly maxBytes: number;
	readonly complete: boolean;
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
	return JSON.stringify([action.execution, action.resources, range.path]);
}
