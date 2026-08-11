import type { SpeculativeActionEvent } from "./runtime.ts";

export interface SpeculativeTraceSummary {
	readonly actorActions: number;
	readonly started: number;
	readonly completed: number;
	readonly hits: number;
	readonly misses: number;
	readonly cancelled: number;
	readonly hitRate: number;
	readonly executionMs: number;
	readonly savedMs: number;
	readonly waitedMs: number;
	readonly consumeOverheadMs: number;
	readonly missReasons: Readonly<Record<string, number>>;
	readonly cancellationReasons: Readonly<Record<string, number>>;
	readonly schedulerOutcomes: Readonly<Record<string, number>>;
}

/** Recomputes comparable aggregate metrics from persisted runtime events. */
export function summarizeSpeculativeTrace<SessionID>(
	events: ReadonlyArray<SpeculativeActionEvent<SessionID>>,
): SpeculativeTraceSummary {
	let actuals = 0;
	let started = 0;
	let completed = 0;
	let hits = 0;
	let misses = 0;
	let cancelled = 0;
	let executionMs = 0;
	let savedMs = 0;
	let waitedMs = 0;
	let consumeOverheadMs = 0;
	const missReasons: Record<string, number> = {};
	const cancellationReasons: Record<string, number> = {};
	const schedulerOutcomes: Record<string, number> = {};

	for (const event of events) {
		if (event.type === "actual") actuals++;
		if (event.type === "started") started++;
		if (event.type === "completed") {
			completed++;
			executionMs += metric(event.executionMs);
		}
		if (event.type === "hit") {
			hits++;
			savedMs += metric(event.savedMs);
			waitedMs += metric(event.waitedMs);
			consumeOverheadMs += metric(event.consumeOverheadMs);
		}
		if (event.type === "miss") {
			misses++;
			increment(missReasons, event.reason);
		}
		if (event.type === "cancelled") {
			cancelled++;
			increment(cancellationReasons, event.reason);
		}
		if ("schedulerOutcome" in event && event.schedulerOutcome) increment(schedulerOutcomes, event.schedulerOutcome);
	}

	const actorActions = actuals + hits;
	return {
		actorActions,
		started,
		completed,
		hits,
		misses,
		cancelled,
		hitRate: actorActions === 0 ? 0 : hits / actorActions,
		executionMs,
		savedMs,
		waitedMs,
		consumeOverheadMs,
		missReasons,
		cancellationReasons,
		schedulerOutcomes,
	};
}

function metric(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function increment(target: Record<string, number>, key: string): void {
	target[key] = (target[key] ?? 0) + 1;
}
