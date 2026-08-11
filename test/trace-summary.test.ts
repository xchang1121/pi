import { describe, expect, test } from "vitest";
import type { SpeculativeActionEvent } from "../src/runtime.ts";
import { summarizeSpeculativeTrace } from "../src/trace-summary.ts";

describe("summarizeSpeculativeTrace", () => {
	test("replays actor outcomes, latency savings, and failure distributions", () => {
		const events = [
			{ type: "started", schedulerOutcome: "promoted" },
			{ type: "completed", executionMs: 40, schedulerOutcome: "promoted" },
			{ type: "hit", savedMs: 30, waitedMs: 5, consumeOverheadMs: 2, schedulerOutcome: "reused" },
			{ type: "actual" },
			{ type: "miss", reason: "key_mismatch" },
			{ type: "miss", reason: "key_mismatch" },
			{ type: "cancelled", reason: "resource_stale", schedulerOutcome: "discarded" },
			{ type: "completed", executionMs: Number.NaN },
			{ type: "hit", savedMs: -10, waitedMs: Number.POSITIVE_INFINITY, consumeOverheadMs: -1 },
		] as unknown as SpeculativeActionEvent<string>[];

		expect(summarizeSpeculativeTrace(events)).toEqual({
			actorActions: 3,
			started: 1,
			completed: 2,
			hits: 2,
			misses: 2,
			cancelled: 1,
			hitRate: 2 / 3,
			executionMs: 40,
			savedMs: 30,
			waitedMs: 5,
			consumeOverheadMs: 2,
			missReasons: { key_mismatch: 2 },
			cancellationReasons: { resource_stale: 1 },
			schedulerOutcomes: { promoted: 2, reused: 1, discarded: 1 },
		});
	});
});
