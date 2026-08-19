export interface TimelineInterval {
	readonly startedAt: number;
	readonly completedAt: number;
}

export interface SpeculativeTaskTiming {
	readonly startedAt: number;
	readonly completedAt: number;
	readonly endToEndMs: number;
	readonly nonToolMs: number;
	readonly actorPhaseMs: number;
	readonly orchestrationMs: number;
	readonly toolExecutionMs: number;
	readonly serializedMs: number;
	readonly hiddenLatencyMs: number;
	readonly authoritativeToolCount: number;
}

/** Reconstructs a no-overlap baseline from one authoritative execution timeline. */
export function measureSpeculativeTask(input: {
	readonly startedAt: number;
	readonly completedAt: number;
	readonly actorPhases: readonly TimelineInterval[];
	readonly authoritativeTools: readonly TimelineInterval[];
}): SpeculativeTaskTiming {
	const startedAt = metric(input.startedAt);
	const completedAt = Math.max(startedAt, metric(input.completedAt));
	const actorPhases = input.actorPhases
		.map(normalizeInterval)
		.map((interval) => clip(interval, startedAt, completedAt))
		.filter((interval) => interval.completedAt > interval.startedAt);
	const authoritativeTools = input.authoritativeTools.map(normalizeInterval);
	const endToEndMs = completedAt - startedAt;
	const actorPhaseMs = unionDuration(actorPhases);
	const toolExecutionMs = durationSum(authoritativeTools);
	const coveredMs = unionDuration(
		[...actorPhases, ...authoritativeTools.map((interval) => clip(interval, startedAt, completedAt))].filter(
			(interval) => interval.completedAt > interval.startedAt,
		),
	);
	const orchestrationMs = Math.max(0, endToEndMs - coveredMs);
	const nonToolMs = actorPhaseMs + orchestrationMs;
	const serializedMs = nonToolMs + toolExecutionMs;
	return Object.freeze({
		startedAt,
		completedAt,
		endToEndMs,
		nonToolMs,
		actorPhaseMs,
		orchestrationMs,
		toolExecutionMs,
		serializedMs,
		hiddenLatencyMs: Math.max(0, serializedMs - endToEndMs),
		authoritativeToolCount: authoritativeTools.length,
	});
}

function clip(interval: TimelineInterval, startedAt: number, completedAt: number): TimelineInterval {
	return {
		startedAt: Math.max(startedAt, interval.startedAt),
		completedAt: Math.min(completedAt, interval.completedAt),
	};
}

function normalizeInterval(interval: TimelineInterval): TimelineInterval {
	const startedAt = metric(interval.startedAt);
	return Object.freeze({ startedAt, completedAt: Math.max(startedAt, metric(interval.completedAt)) });
}

function durationSum(intervals: readonly TimelineInterval[]): number {
	return intervals.reduce((total, interval) => total + interval.completedAt - interval.startedAt, 0);
}

function unionDuration(intervals: readonly TimelineInterval[]): number {
	const sorted = [...intervals].sort(
		(left, right) => left.startedAt - right.startedAt || left.completedAt - right.completedAt,
	);
	let total = 0;
	let current: TimelineInterval | undefined;
	for (const interval of sorted) {
		if (!current) {
			current = interval;
			continue;
		}
		if (interval.startedAt <= current.completedAt) {
			current = { startedAt: current.startedAt, completedAt: Math.max(current.completedAt, interval.completedAt) };
			continue;
		}
		total += current.completedAt - current.startedAt;
		current = interval;
	}
	return current ? total + current.completedAt - current.startedAt : total;
}

function metric(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}
