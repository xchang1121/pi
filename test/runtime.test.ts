import { describe, expect, it } from "vitest";
import type { CandidateLifetime } from "../src/common.ts";
import { buildPiActionKey } from "../src/common.ts";
import type {
	SpeculativeActionEvent,
	SpeculativeActionSettings,
	SpeculativeCandidate,
	SpeculativeDraftCandidate,
	SpeculativePrediction,
} from "../src/runtime.ts";
import { makeSpeculativeActionRuntime } from "../src/runtime.ts";

interface StartInput {
	readonly sessionID: string;
	readonly turnID: string;
}

interface ConsumeInput extends StartInput {
	readonly tool: string;
	readonly input: Record<string, unknown>;
}

interface HarnessOptions {
	readonly settings?: SpeculativeActionSettings;
	readonly predict: (input: StartInput, signal: AbortSignal) => Promise<SpeculativePrediction> | SpeculativePrediction;
	readonly execute?: (candidate: SpeculativeDraftCandidate, signal: AbortSignal) => Promise<string> | string;
	readonly lifetime?: CandidateLifetime;
	readonly captureResourceVersion?: () => Promise<unknown> | unknown;
	readonly isResourceExpired?: (input: {
		readonly consumeInput?: ConsumeInput;
		readonly candidate: SpeculativeCandidate;
	}) => Promise<boolean> | boolean;
	readonly projectOutput?: (output: string) => Promise<string | undefined> | string | undefined;
	readonly adopt?: (output: string) => Promise<string | undefined> | string | undefined;
	readonly observerThrows?: boolean;
}

const enabledSettings: SpeculativeActionSettings = {
	enabled: true,
	mode: "predict_action_single_step",
	maxCandidates: 4,
	resourceCacheMaxEntries: 512,
	predictionTimeoutMs: 250,
	tools: { resourceCached: ["read", "grep", "find"], sandbox: [] },
};

function createHarness(options: HarnessOptions) {
	const events: SpeculativeActionEvent<string>[] = [];
	let executions = 0;
	const runtime = makeSpeculativeActionRuntime<
		string,
		string,
		StartInput,
		ConsumeInput,
		ConsumeInput,
		{ readonly cwd: string }
	>({
		settings: () => options.settings ?? enabledSettings,
		definitions: () => [
			{ name: "read", description: "Read files" },
			{ name: "grep", description: "Search files" },
			{ name: "find", description: "Find files" },
			{ name: "task", description: "Run a subagent" },
		],
		stateData: () => ({ cwd: "/workspace" }),
		predict: (input, _settings, _definitions, _candidateNames, signal) => options.predict(input, signal),
		actionKey: (tool, input) => buildPiActionKey(tool, input, "/workspace"),
		actual: (input) => ({ tool: input.tool, input: input.input }),
		preflightCandidate: () => ({ ok: true }),
		executeCandidate: ({ candidate, signal }) => {
			executions++;
			return options.execute?.(candidate, signal) ?? "prefetched";
		},
		...(options.lifetime ? { candidateLifetime: () => options.lifetime as CandidateLifetime } : {}),
		...(options.captureResourceVersion ? { captureResourceVersion: () => options.captureResourceVersion?.() } : {}),
		...(options.isResourceExpired
			? { isResourceExpired: (input) => options.isResourceExpired?.(input) ?? false }
			: {}),
		...(options.projectOutput ? { projectOutput: ({ output }) => options.projectOutput?.(output) } : {}),
		...(options.adopt ? { adoptCandidate: ({ output }) => options.adopt?.(output) } : {}),
		onEvent: (event) => {
			events.push(event);
			if (options.observerThrows) throw new Error("observer failed");
		},
	});
	return { runtime, events, executions: () => executions };
}

function readCandidate(path = "README.md", offset?: number, limit?: number): SpeculativeDraftCandidate {
	return { type: "tool_call", tool: "read", input: { path, offset, limit } };
}

function prediction(...candidates: SpeculativeDraftCandidate[]): SpeculativePrediction {
	return { candidates, draftTokens: 11 };
}

function consume(turnID: string, input: Record<string, unknown> = { path: "README.md" }): ConsumeInput {
	return { sessionID: "session", turnID, tool: "read", input };
}

describe("speculative action runtime", () => {
	it("adopts a matching candidate while pre-execution is still running", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => execution.promise,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		const result = harness.runtime.consume(consume("turn-1"));
		await waitFor(() => harness.executions() === 1);
		execution.resolve("running-prefetch");

		expect(await result).toBe("running-prefetch");
		expect(harness.executions()).toBe(1);
		expect(harness.events.map((event) => event.type)).toEqual(expect.arrayContaining(["started", "hit"]));
	});

	it("adopts an already completed candidate without executing it twice", async () => {
		const harness = createHarness({ predict: () => prediction(readCandidate()), execute: () => "ready-prefetch" });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.events.some((event) => event.type === "started"));

		expect(await harness.runtime.consume(consume("turn-1"))).toBe("ready-prefetch");
		expect(harness.executions()).toBe(1);
	});

	it("publishes running and completed cache snapshots before a hit", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			settings: { ...enabledSettings, resourceCacheMaxEntries: 7 },
			predict: () => prediction(readCandidate()),
			execute: () => execution.promise,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-cache" });
		await waitFor(() => harness.events.some((event) => event.type === "started"));

		const started = harness.events.find((event) => event.type === "started");
		expect(started).toMatchObject({
			cacheEntries: 1,
			cacheCapacity: 7,
			cacheRunning: 1,
			cacheCompleted: 0,
			activeCandidates: 1,
			turnCandidates: 0,
			resourceCandidates: 1,
			cacheTools: ["read"],
			cacheExecutions: ["resource_cached"],
		});
		const result = harness.runtime.consume(consume("turn-cache"));
		execution.resolve("cached");
		expect(await result).toBe("cached");

		const eventTypes = harness.events.map((event) => event.type);
		expect(eventTypes.indexOf("cache")).toBeGreaterThan(eventTypes.indexOf("started"));
		expect(eventTypes.indexOf("cache")).toBeLessThan(eventTypes.indexOf("hit"));
		expect(harness.events.find((event) => event.type === "cache")).toMatchObject({
			cacheEntries: 1,
			cacheRunning: 0,
			cacheCompleted: 1,
			activeCandidates: 0,
		});
	});

	it("refreshes cache telemetry when a candidate completes without an actor hit", async () => {
		const harness = createHarness({ predict: () => prediction(readCandidate()), execute: () => "ready" });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-background" });
		await waitFor(() => harness.events.some((event) => event.type === "cache"));

		expect(harness.events.some((event) => event.type === "hit")).toBe(false);
		expect(harness.events.find((event) => event.type === "cache")).toMatchObject({
			cacheCompleted: 1,
			cacheRunning: 0,
		});
	});

	it("publishes actual fallback duration without creating another speculative miss", async () => {
		const harness = createHarness({ predict: () => prediction() });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-actual" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-actual"))).toBeUndefined();
		const misses = harness.events.filter((event) => event.type === "miss").length;

		await harness.runtime.actual({ ...consume("turn-actual"), durationMs: 23 });

		expect(harness.events.filter((event) => event.type === "miss")).toHaveLength(misses);
		expect(harness.events.find((event) => event.type === "actual")).toMatchObject({
			type: "actual",
			tool: "read",
			execution: "resource_cached",
			actionKeyHash: expect.any(String),
			actualAction: expect.any(String),
			actualDurationMs: 23,
			cacheEntries: 0,
		});
	});

	it("waits for a drafter candidate that arrives after the actor call", async () => {
		const draft = deferred<SpeculativePrediction>();
		const harness = createHarness({ predict: () => draft.promise });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		const result = harness.runtime.consume(consume("turn-1"));
		draft.resolve(prediction(readCandidate()));

		expect(await result).toBe("prefetched");
		expect(harness.events.some((event) => event.type === "hit")).toBe(true);
	});

	it("times out and falls back when the drafter never produces a candidate", async () => {
		const settings = { ...enabledSettings, predictionTimeoutMs: 20 };
		const harness = createHarness({
			settings,
			predict: () => new Promise<SpeculativePrediction>(() => {}),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });

		expect(await harness.runtime.consume(consume("turn-1"))).toBeUndefined();
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "prediction_timeout")).toBe(true);
		expect(harness.executions()).toBe(0);
	});

	it("reuses a resource candidate across turns until its version expires", async () => {
		let expired = false;
		const harness = createHarness({
			predict: (input) => (input.turnID === "turn-1" ? prediction(readCandidate()) : prediction()),
			captureResourceVersion: () => "v1",
			isResourceExpired: () => expired,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });

		expect(await harness.runtime.consume(consume("turn-2"))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
		await harness.runtime.finishTurn(consume("turn-2", {}));
		expired = true;
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-3" });
		expect(await harness.runtime.consume(consume("turn-3"))).toBeUndefined();
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "resource_expired")).toBe(true);
	});

	it("lets the drafter reuse an exact resource candidate without reporting no candidate", async () => {
		const harness = createHarness({ predict: () => prediction(readCandidate()) });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-2"))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "no_candidate")).toBe(false);
	});

	it("deduplicates exact draft candidates after one cache miss", async () => {
		const harness = createHarness({ predict: () => prediction(readCandidate(), readCandidate()) });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1"))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
	});

	it("reuses a containing read candidate from the same draft batch", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100), readCandidate("README.md", 1, 60)),
			execute: () => "lines-1-100",
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1", { path: "README.md", offset: 1, limit: 60 }))).toBe(
			"projected:lines-1-100",
		);
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
	});

	it("keeps containing reads separate when no safe projector is installed", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100), readCandidate("README.md", 1, 60)),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1", { path: "README.md", offset: 1, limit: 60 }))).toBe(
			"prefetched",
		);
		expect(harness.executions()).toBe(2);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("shares an in-flight resource job between the next drafter and actor", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => execution.promise,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		const result = harness.runtime.consume(consume("turn-2"));
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		execution.resolve("shared-prefetch");

		expect(await result).toBe("shared-prefetch");
		expect(harness.executions()).toBe(1);
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "no_candidate")).toBe(false);
	});

	it("expires a stale drafter cache entry before starting one replacement", async () => {
		let version = "v1";
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => `prefetched-${version}`,
			captureResourceVersion: () => version,
			isResourceExpired: ({ candidate }) => candidate.resourceVersion !== version,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		version = "v2";
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => harness.executions() === 2);

		expect(await harness.runtime.consume(consume("turn-2"))).toBe("prefetched-v2");
		expect(harness.executions()).toBe(2);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("does not charge reused candidates against the execution limit", async () => {
		const harness = createHarness({
			settings: { ...enabledSettings, maxCandidates: 1 },
			predict: (input) =>
				input.turnID === "turn-1"
					? prediction(readCandidate("README.md"))
					: prediction(readCandidate("README.md"), readCandidate("CHANGELOG.md")),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-2", { path: "CHANGELOG.md" }))).toBe("prefetched");
		expect(harness.executions()).toBe(2);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("projects a containing speculative read and rejects uncovered reads", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100)),
			execute: () => "lines-1-100",
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		expect(await harness.runtime.consume(consume("turn-1", { path: "README.md", offset: 20, limit: 10 }))).toBe(
			"projected:lines-1-100",
		);

		await harness.runtime.startTurn({ sessionID: "other", turnID: "turn-2" });
		expect(
			await harness.runtime.consume({
				sessionID: "other",
				turnID: "turn-2",
				tool: "read",
				input: { path: "README.md", offset: 95, limit: 10 },
			}),
		).toBeUndefined();
	});

	it("applies the candidate limit after unsupported draft tools are skipped", async () => {
		const harness = createHarness({
			settings: { ...enabledSettings, maxCandidates: 1 },
			predict: () => prediction({ type: "tool_call", tool: "task", input: { prompt: "inspect" } }, readCandidate()),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });

		expect(await harness.runtime.consume(consume("turn-1"))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
	});

	it("keeps an unfinished resource candidate alive after finishTurn", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			predict: (input) => (input.turnID === "turn-1" ? prediction(readCandidate()) : prediction()),
			execute: () => execution.promise,
			captureResourceVersion: () => "v1",
			isResourceExpired: () => false,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		const result = harness.runtime.consume(consume("turn-2"));
		execution.resolve("late-prefetch");

		expect(await result).toBe("late-prefetch");
		expect(harness.executions()).toBe(1);
	});

	it("cancels unconsumed turn-scoped work when the turn finishes", async () => {
		let aborted = false;
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			lifetime: "turn",
			execute: (_candidate, signal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		expect(aborted).toBe(true);
		expect(
			harness.events.some((event) => event.type === "cancelled" && event.reason === "turn_finished_without_hit"),
		).toBe(true);
	});

	it("falls back when candidate execution fails", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => {
				throw new Error("candidate failed");
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });

		expect(await harness.runtime.consume(consume("turn-1"))).toBeUndefined();
		expect(
			harness.events.some((event) => event.type === "miss" && event.reason === "candidate_execution_failed"),
		).toBe(true);
	});

	it("updates LRU order on access and evicts the oldest resource candidate", async () => {
		const paths: Record<string, string | undefined> = {
			"turn-a": "a.txt",
			"turn-b": "b.txt",
			"turn-c": "c.txt",
		};
		const harness = createHarness({
			settings: { ...enabledSettings, resourceCacheMaxEntries: 2 },
			predict: (input) => {
				const path = paths[input.turnID];
				return path ? prediction(readCandidate(path)) : prediction();
			},
			execute: (candidate) => String((candidate.input as { path: string }).path),
		});
		for (const turnID of ["turn-a", "turn-b"]) {
			await harness.runtime.startTurn({ sessionID: "session", turnID });
			await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
			await harness.runtime.finishTurn({ sessionID: "session", turnID, tool: "read", input: {} });
		}

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-touch" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-touch", { path: "a.txt" }))).toBe("a.txt");
		await harness.runtime.finishTurn(consume("turn-touch", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-c" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		await harness.runtime.finishTurn({ sessionID: "session", turnID: "turn-c", tool: "read", input: {} });
		expect(harness.runtime.inspect("session").resourceCandidates).toBe(2);

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-check-b" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-check-b", { path: "b.txt" }))).toBeUndefined();
		await harness.runtime.finishTurn(consume("turn-check-b", {}));
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-check-a" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-check-a", { path: "a.txt" }))).toBe("a.txt");
	});

	it("reports adoption failure and leaves the actor on the normal execution path", async () => {
		const harness = createHarness({
			settings: { ...enabledSettings, tools: { resourceCached: [], sandbox: ["write"] } },
			predict: () => prediction({ type: "tool_call", tool: "write", input: { path: "out.txt", content: "draft" } }),
			execute: () => "staged",
			adopt: () => undefined,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-write" });

		expect(
			await harness.runtime.consume({
				sessionID: "session",
				turnID: "turn-write",
				tool: "write",
				input: { path: "out.txt", content: "draft" },
			}),
		).toBeUndefined();
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "adoption_failed")).toBe(true);
	});

	it("isolates observer failures from candidate settlement", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			observerThrows: true,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-observer" });

		expect(await harness.runtime.consume(consume("turn-observer"))).toBe("prefetched");
		expect(harness.events.some((event) => event.type === "hit")).toBe(true);
	});

	it("publishes complete redacted lifecycle payloads with cumulative draft tokens", async () => {
		const harness = createHarness({
			predict: (input) => {
				const path = input.turnID === "turn-1" ? "README.md" : "CHANGELOG.md";
				const sensitive = {
					type: "tool_call" as const,
					tool: "read",
					input: { path, token: "top-secret", authorization: "Bearer private" },
					diagnostic: JSON.stringify({
						toolCallID: `draft-${input.turnID}`,
						tool: "read",
						input: { path, token: "top-secret", note: "sk-abcdefghijklmnop" },
					}),
				};
				return { candidates: [sensitive], draftTokens: input.turnID === "turn-1" ? 7 : 5 };
			},
		});

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-1"))).toBe("prefetched");
		await harness.runtime.finishTurn(consume("turn-1", {}));
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-2", { path: "CHANGELOG.md" }))).toBe("prefetched");

		const started = harness.events.filter((event) => event.type === "started");
		expect(started).toHaveLength(2);
		expect(started[0]).toMatchObject({
			type: "started",
			tool: "read",
			execution: "resource_cached",
			draftTokens: 7,
			totalDraftTokens: 7,
			predictionLatencyMs: expect.any(Number),
			actionKeyHash: expect.any(String),
		});
		expect(started[1]).toMatchObject({ draftTokens: 5, totalDraftTokens: 12 });
		if (started[0]?.type !== "started") throw new Error("Expected a started event");
		expect(started[0].draftCandidate).toContain("[redacted]");
		expect(started[0].draftCandidate).not.toContain("top-secret");
		expect(started[0].draftCandidate).not.toContain("sk-abcdefghijklmnop");
		expect(started[0].predictedAction).not.toContain("Bearer private");

		const hit = harness.events.find((event) => event.type === "hit");
		expect(hit).toMatchObject({
			type: "hit",
			tool: "read",
			draftTokens: 7,
			totalDraftTokens: 7,
			savedMs: expect.any(Number),
			waitedMs: expect.any(Number),
			actualAction: expect.any(String),
		});

		const missHarness = createHarness({
			predict: () => prediction(readCandidate("README.md")),
			lifetime: "turn",
		});
		await missHarness.runtime.startTurn({ sessionID: "session", turnID: "turn-miss" });
		await waitFor(() => missHarness.runtime.inspect().pendingPredictions === 0);
		expect(await missHarness.runtime.consume(consume("turn-miss", { path: "CHANGELOG.md" }))).toBeUndefined();

		expect(missHarness.events.find((event) => event.type === "miss")).toMatchObject({
			type: "miss",
			reason: "key_mismatch",
			tool: "read",
			actionKeyHash: expect.any(String),
			predictedAction: expect.any(String),
			actualAction: expect.any(String),
		});
		expect(missHarness.events.find((event) => event.type === "cancelled")).toMatchObject({
			type: "cancelled",
			reason: "explicit_miss",
			tool: "read",
			actionKeyHash: expect.any(String),
			draftCandidate: expect.any(String),
			predictedAction: expect.any(String),
		});
	});

	it("performs no prediction or background work while disabled", async () => {
		let predictions = 0;
		const harness = createHarness({
			settings: { ...enabledSettings, enabled: false },
			predict: () => {
				predictions++;
				return prediction(readCandidate());
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });

		expect(predictions).toBe(0);
		expect(harness.runtime.inspect()).toEqual({
			activeTurns: 0,
			turnCandidates: 0,
			resourceCandidates: 0,
			pendingPredictions: 0,
		});
	});
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
