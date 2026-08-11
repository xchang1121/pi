import type { ActionKey, ActionKeyProjector } from "./common.ts";
import { buildActionKey, readActionRange } from "./common.ts";

/** π_read narrows a cached read action to the actor's requested interval. */
export const READ_RANGE_ACTION_KEY_PROJECTOR: ActionKeyProjector = {
	id: "read.range",
	partition: readProjectionPartition,
	project: (speculative, actor) => {
		const speculativeRange = readActionRange(speculative);
		const actorRange = readActionRange(actor);
		if (!speculativeRange || !actorRange) return undefined;
		if (readProjectionPartition(speculative) !== readProjectionPartition(actor)) return undefined;
		if (speculativeRange.offset > actorRange.offset || speculativeRange.end < actorRange.end) return undefined;
		return {
			action: buildActionKey({
				tool: speculative.tool,
				execution: speculative.execution,
				resources: speculative.resources,
				input: {
					...speculative.input,
					offset: actorRange.offset,
					limit: actorRange.limit,
				},
			}),
			distance: actorRange.offset - speculativeRange.offset + (speculativeRange.end - actorRange.end),
		};
	},
};

function readProjectionPartition(action: ActionKey): string | undefined {
	const range = readActionRange(action);
	if (!range) return undefined;
	return JSON.stringify([action.execution, action.resources, range.path]);
}
