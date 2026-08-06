import { describe, expect, it } from "vitest";
import { buildActionKey } from "../src/common.ts";
import { PATTERN_AWARE_DEFAULTS } from "../src/pattern-aware.ts";
import type {
	SpeculativeActionEvent,
	SpeculativeActionRuntimeAdapter,
	SpeculativeActionSettings,
	SpeculativeDraftCandidate,
} from "../src/runtime.ts";
import { makeSpeculativeActionRuntime } from "../src/runtime.ts";

interface Start {
	readonly sessionID: string;
	readonly turnID: string;
	readonly terminal?: boolean;
}

interface Consume extends Start {
	readonly tool: string;
	readonly input: Record<string, unknown>;
}

type Adapter = SpeculativeActionRuntimeAdapter<string, string, Start, Consume, { readonly cwd: string }>;

describe("PatternAware runtime integration", () => {
	it("keeps a future candidate across an unrelated action and provider turn", async () => {
		let executions = 0;
		const outcomes: string[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: (input) => ({
					candidates:
						input.turnID === "turn_1" ? [patternCandidate("read", { path: "README.md" }, "read", 1)] : [],
					draftTokens: 0,
				}),
				executeCandidate: () => {
					executions++;
					return "prefetched";
				},
				onPatternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
			}),
		);

		await runtime.startTurn(start("turn_1"));
		await waitFor(() => executions === 1);
		expect(await runtime.consume(call("turn_1", "find", { pattern: "*" }))).toBeUndefined();
		await runtime.actual({ ...call("turn_1", "find", { pattern: "*" }), durationMs: 1, output: "files" });
		await runtime.finishTurn(start("turn_1"));

		await runtime.startTurn(start("turn_2"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(await runtime.consume(call("turn_2", "read", { path: "README.md" }))).toBe("prefetched");
		expect(executions).toBe(1);
		expect(outcomes).toEqual(["read:consumed"]);
	});

	it("expires completed sandbox work only after its future horizon is exceeded", async () => {
		const outcomes: string[] = [];
		const events: SpeculativeActionEvent<string>[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({
					candidates: [patternCandidate("bash", { command: "npm test" }, "bash", 0)],
					draftTokens: 0,
				}),
				onPatternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => events.some((event) => event.type === "completed"));
		await runtime.consume(call("turn", "find", { pattern: "*" }));

		expect(outcomes).toEqual(["bash:actor_miss"]);
		expect(events).toContainEqual(expect.objectContaining({ type: "cancelled", reason: "pattern_horizon_expired" }));
	});

	it("ends future sandbox work when the actor response is terminal", async () => {
		const outcomes: string[] = [];
		const events: SpeculativeActionEvent<string>[] = [];
		let aborted = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({
					candidates: [patternCandidate("bash", { command: "npm test" }, "terminal", 8)],
					draftTokens: 0,
				}),
				executeCandidate: ({ signal }) =>
					new Promise<string>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								aborted++;
								reject(new Error("aborted"));
							},
							{ once: true },
						);
					}),
				onPatternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => events.some((event) => event.type === "started"));
		await runtime.finishTurn({ ...start("turn"), terminal: true });
		await waitFor(() => aborted === 1);

		expect(outcomes).toEqual(["terminal:actor_miss"]);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "cancelled", reason: "request_finished_without_hit" }),
		);
	});

	it("keeps a fresh resource result after its terminal pattern lease ends", async () => {
		const outcomes: string[] = [];
		let executions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: (input) => ({
					candidates:
						input.turnID === "turn_1" ? [patternCandidate("read", { path: "README.md" }, "cached", 8)] : [],
					draftTokens: 0,
				}),
				executeCandidate: () => {
					executions++;
					return "cached";
				},
				onPatternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
			}),
		);

		await runtime.startTurn(start("turn_1"));
		await waitFor(() => executions === 1);
		await runtime.finishTurn({ ...start("turn_1"), terminal: true });
		await runtime.startTurn(start("turn_2"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(await runtime.consume(call("turn_2", "read", { path: "README.md" }))).toBe("cached");

		expect(outcomes).toEqual(["cached:actor_miss"]);
		expect(executions).toBe(1);
	});

	it("deduplicates PatternAware and drafter predictions onto one execution", async () => {
		let executions = 0;
		let launches = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({
					candidates: [patternCandidate("read", { path: "README.md" }, "shared", 0)],
					draftTokens: 0,
				}),
				predict: () => ({
					candidates: [{ type: "tool_call", tool: "read", input: { path: "README.md" } }],
					draftTokens: 3,
				}),
				executeCandidate: () => {
					executions++;
					return "one";
				},
				onPatternLaunched: () => {
					launches++;
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(await runtime.consume(call("turn", "read", { path: "README.md" }))).toBe("one");
		expect(executions).toBe(1);
		expect(launches).toBe(1);
	});

	it("routes lifecycle updates through each candidate store context", async () => {
		const first = { store: "first" };
		const second = { store: "second" };
		const launched: unknown[] = [];
		const resolved: Array<{ context: unknown; outcome: string }> = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({
					candidates: [
						{ ...patternCandidate("read", { path: "a.ts" }, "first", 1), patternContext: first },
						{ ...patternCandidate("read", { path: "b.ts" }, "second", 1), patternContext: second },
					],
					draftTokens: 0,
				}),
				onPatternLaunched: (_id, context) => {
					launched.push(context);
				},
				onPatternResolved: (_id, outcome, context) => {
					resolved.push({ context, outcome });
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => launched.length === 2);
		await runtime.consume(call("turn", "read", { path: "a.ts" }));
		await runtime.finishTurn({ ...start("turn"), terminal: true });

		expect(launched).toEqual([first, second]);
		expect(resolved).toEqual([
			{ context: first, outcome: "consumed" },
			{ context: second, outcome: "actor_miss" },
		]);
	});

	it("immediately admits a prediction learned from an authoritative action", async () => {
		let executions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				recordAuthoritative: ({ tool, output }) =>
					tool === "grep" && output === "src/a.ts"
						? { candidates: [patternCandidate("read", { path: "src/a.ts" }, "grep-read", 0)], draftTokens: 0 }
						: undefined,
				executeCandidate: () => {
					executions++;
					return "file";
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		await runtime.consume(call("turn", "grep", { pattern: "TODO" }));
		await runtime.actual({
			...call("turn", "grep", { pattern: "TODO" }),
			durationMs: 5,
			output: "src/a.ts",
		});
		await waitFor(() => executions === 1);
		expect(await runtime.consume(call("turn", "read", { path: "src/a.ts" }))).toBe("file");
	});

	it("persists a pattern lease attached to an existing turn-scoped drafter job", async () => {
		let executions = 0;
		const outcomes: string[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), candidateLimit: 2, maxConcurrentActions: 2 }),
				predict: (input) => ({
					candidates:
						input.turnID === "turn_1"
							? [
									{ type: "tool_call", tool: "bash", input: { command: "first" } },
									{ type: "tool_call", tool: "bash", input: { command: "second" } },
								]
							: [],
					draftTokens: 0,
				}),
				recordAuthoritative: ({ tool, concrete }) =>
					tool === "bash" && concrete.command === "first"
						? { candidates: [patternCandidate("bash", { command: "second" }, "second", 1)], draftTokens: 0 }
						: undefined,
				executeCandidate: ({ concrete }) => {
					executions++;
					return String(concrete.command);
				},
				onPatternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
			}),
		);

		await runtime.startTurn(start("turn_1"));
		await waitFor(() => executions === 2);
		expect(await runtime.consume(call("turn_1", "bash", { command: "first" }))).toBe("first");
		await runtime.finishTurn(start("turn_1"));
		await runtime.startTurn(start("turn_2"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(await runtime.consume(call("turn_2", "bash", { command: "second" }))).toBe("second");

		expect(executions).toBe(2);
		expect(outcomes).toEqual(["second:consumed"]);
	});

	it("preempts lower-utility in-flight work without a false completion", async () => {
		const events: SpeculativeActionEvent<string>[] = [];
		let aborted = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), candidateLimit: 1, maxConcurrentActions: 1 }),
				predict: (input) => ({
					candidates:
						input.turnID === "turn_1"
							? [scheduledCandidate("a.ts", 10)]
							: input.turnID === "turn_2"
								? [scheduledCandidate("b.ts", 90)]
								: [],
					draftTokens: 0,
				}),
				executeCandidate: ({ concrete, signal }) =>
					concrete.path === "a.ts"
						? new Promise<string>((_resolve, reject) => {
								signal.addEventListener(
									"abort",
									() => {
										aborted++;
										reject(new Error("aborted"));
									},
									{ once: true },
								);
							})
						: "b",
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn_1"));
		await waitFor(() => events.some((event) => event.type === "started"));
		await runtime.finishTurn(start("turn_1"));
		await runtime.startTurn(start("turn_2"));
		await waitFor(() => events.some((event) => event.type === "completed" && event.tool === "read"));

		expect(aborted).toBe(1);
		expect(events).toContainEqual(expect.objectContaining({ type: "cancelled", reason: "scheduler_preempted" }));
		expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
	});

	it("attributes scheduler preemption as a system outcome instead of an actor miss", async () => {
		const outcomes: string[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({
					...settings(),
					drafterEnabled: false,
					candidateLimit: 1,
					maxConcurrentActions: 1,
				}),
				predictPatternAware: (input) => ({
					candidates:
						input.turnID === "turn_1"
							? [
									{
										...patternCandidate("read", { path: "a.ts" }, "low", 8),
										expectedDurationMs: 100,
										empiricalProbability: 0.55,
										expectedLatencyBenefitMs: 55,
									},
								]
							: input.turnID === "turn_2"
								? [
										{
											...patternCandidate("read", { path: "b.ts" }, "high", 8),
											expectedDurationMs: 100,
											empiricalProbability: 0.95,
											expectedLatencyBenefitMs: 95,
										},
									]
								: [],
					draftTokens: 0,
				}),
				executeCandidate: ({ concrete }) =>
					concrete.path === "a.ts" ? new Promise<string>(() => {}) : "higher utility",
				onPatternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
			}),
		);

		await runtime.startTurn(start("turn_1"));
		await waitFor(() => runtime.inspect().resourceCandidates === 1);
		await runtime.finishTurn(start("turn_1"));
		await runtime.startTurn(start("turn_2"));
		await waitFor(() => outcomes.includes("low:system"));

		expect(outcomes).toContain("low:system");
		await runtime.dispose();
	});

	it("interrupts an in-flight resource job when per-session LRU evicts it", async () => {
		const events: SpeculativeActionEvent<string>[] = [];
		let aborted = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({
					...settings(),
					candidateLimit: 2,
					maxConcurrentActions: 2,
					resourceCacheMaxEntries: 1,
				}),
				predict: (input) => ({
					candidates:
						input.turnID === "turn_1"
							? [scheduledCandidate("a.ts", 10)]
							: input.turnID === "turn_2"
								? [scheduledCandidate("b.ts", 10)]
								: [],
					draftTokens: 0,
				}),
				executeCandidate: ({ concrete, signal }) =>
					concrete.path === "a.ts"
						? new Promise<string>((_resolve, reject) => {
								signal.addEventListener(
									"abort",
									() => {
										aborted++;
										reject(new Error("aborted"));
									},
									{ once: true },
								);
							})
						: "b",
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn_1"));
		await waitFor(() => events.some((event) => event.type === "started"));
		await runtime.finishTurn(start("turn_1"));
		await runtime.startTurn(start("turn_2"));
		await waitFor(() => events.some((event) => event.type === "completed"));

		expect(aborted).toBe(1);
		expect(events).toContainEqual(expect.objectContaining({ type: "cancelled", reason: "resource_cache_evicted" }));
	});

	it("deduplicates and bounds preparation hints without executing them", async () => {
		const prepared: string[] = [];
		let executions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), candidateLimit: 2, maxConcurrentActions: 2 }),
				predictPatternAware: () => ({
					candidates: [
						preparationHint("a.ts"),
						preparationHint("a.ts"),
						preparationHint("b.ts"),
						preparationHint("c.ts"),
					],
					draftTokens: 0,
				}),
				prepareCandidate: ({ candidate }) => {
					prepared.push(String((candidate.input as { path?: string }).path));
				},
				executeCandidate: () => {
					executions++;
					return "unexpected";
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);

		expect(prepared).toEqual(["a.ts", "b.ts"]);
		expect(executions).toBe(0);
	});

	it("expands a completed speculative result into a multi-step frontier", async () => {
		const executed: string[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({
					candidates: [
						{ ...patternCandidate("read", { path: "src/a.ts" }, "read", 0), patternContext: { step: 1 } },
					],
					draftTokens: 0,
				}),
				executeCandidate: ({ tool }) => {
					executed.push(tool);
					return tool === "read" ? "structured-read" : "test-output";
				},
				continuePatternAware: ({ candidate, output, parentConfirmed }) => {
					if (candidate.key.tool !== "read") return undefined;
					expect(output).toBe("structured-read");
					expect(parentConfirmed).toBe(false);
					return {
						candidates: [
							{ ...patternCandidate("bash", { command: "npm test" }, "bash", 0), patternContext: { step: 2 } },
						],
						draftTokens: 0,
					};
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => executed.length === 2);

		expect(executed).toEqual(["read", "bash"]);
		expect(await runtime.consume(call("turn", "bash", { command: "npm test" }))).toBe("test-output");
	});

	it("does not expand the frontier after terminal cancellation", async () => {
		let continuations = 0;
		let aborted = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({
					candidates: [
						{ ...patternCandidate("bash", { command: "long" }, "long", 4), patternContext: { step: 1 } },
					],
					draftTokens: 0,
				}),
				executeCandidate: ({ signal }) =>
					new Promise<string>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								aborted++;
								reject(new Error("aborted"));
							},
							{ once: true },
						);
					}),
				continuePatternAware: () => {
					continuations++;
					return undefined;
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().turnCandidates === 1);
		await runtime.finishTurn({ ...start("turn"), terminal: true });
		await waitFor(() => aborted === 1);

		expect(continuations).toBe(0);
	});

	it("bounds persistent cache by estimated bytes", async () => {
		const events: SpeculativeActionEvent<string>[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), resourceCacheMaxBytes: 1100 }),
				predict: (input) => ({
					candidates: [scheduledCandidate(input.turnID === "turn_1" ? "a.ts" : "b.ts", 10)],
					draftTokens: 0,
				}),
				executeCandidate: ({ concrete }) => `${String(concrete.path)}:${"x".repeat(220)}`,
				candidateSizeBytes: ({ output }) => output.length,
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn_1"));
		await waitFor(() => events.some((event) => event.type === "completed" && event.tool === "read"));
		await runtime.finishTurn(start("turn_1"));
		await runtime.startTurn(start("turn_2"));
		await waitFor(() => events.filter((event) => event.type === "completed").length === 2);

		expect(events).toContainEqual(
			expect.objectContaining({ type: "cancelled", reason: "resource_cache_byte_limit" }),
		);
		expect(await runtime.consume(call("turn_2", "read", { path: "a.ts" }))).toBeUndefined();
		expect(await runtime.consume(call("turn_2", "read", { path: "b.ts" }))).toContain("b.ts");
	});

	it("eagerly invalidates a watched resource candidate and releases its watch", async () => {
		let invalidate: ((path?: string) => void) | undefined;
		let releases = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predict: () => ({ candidates: [scheduledCandidate("a.ts", 10)], draftTokens: 0 }),
				captureResourceVersion: () => ({ captureMs: 1, captureBytes: 0, captureFiles: 0 }),
				watchResourceVersion: ({ onInvalidated }) => {
					invalidate = onInvalidated;
					return () => {
						releases++;
					};
				},
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => invalidate !== undefined && events.some((event) => event.type === "completed"));
		invalidate?.("a.ts");
		await waitFor(() => releases === 1);

		expect(await runtime.consume(call("turn", "read", { path: "a.ts" }))).toBeUndefined();
		expect(events).toContainEqual(expect.objectContaining({ type: "cancelled", reason: "resource_changed:a.ts" }));
	});

	it("isolates scheduler budgets between sessions", async () => {
		let executions = 0;
		const pending = new Promise<string>(() => {});
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), candidateLimit: 1, maxConcurrentActions: 1 }),
				predict: (input) => ({ candidates: [scheduledCandidate(`${input.sessionID}.ts`, 10)], draftTokens: 0 }),
				executeCandidate: () => {
					executions++;
					return pending;
				},
			}),
		);

		await runtime.startTurn({ sessionID: "one", turnID: "turn" });
		await runtime.startTurn({ sessionID: "two", turnID: "turn" });
		await waitFor(() => executions === 2);

		expect(runtime.inspect("one").resourceCandidates).toBe(1);
		expect(runtime.inspect("two").resourceCandidates).toBe(1);
		await runtime.dispose();
	});

	it("applies adaptive drafter skipping and bounded miss backoff deterministically", async () => {
		let requests = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predict: () => {
					requests++;
					return { candidates: [], draftTokens: 1 };
				},
			}),
		);

		for (const turnID of ["turn_1", "turn_2", "turn_3", "turn_4"]) {
			await runtime.startTurn(start(turnID));
			await waitFor(() => runtime.inspect().pendingPredictions === 0);
			await runtime.finishTurn(start(turnID));
		}

		expect(requests).toBe(3);
	});

	it("runs the drafter beside an immediate pattern candidate when adaptation is disabled", async () => {
		let requests = 0;
		let executions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), adaptiveDrafter: false }),
				predictPatternAware: () => ({
					candidates: [patternCandidate("read", { path: "README.md" }, "immediate", 0)],
					draftTokens: 0,
				}),
				predict: () => {
					requests++;
					return {
						candidates: [{ type: "tool_call", tool: "read", input: { path: "README.md" } }],
						draftTokens: 1,
					};
				},
				executeCandidate: () => {
					executions++;
					return "prefetched";
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0 && requests === 1);

		expect(requests).toBe(1);
		expect(executions).toBe(1);
	});

	it("does not defer the adaptive drafter without an immediate concrete PatternAware action", async () => {
		let requests = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({ candidates: [], draftTokens: 0, deferDrafter: true }),
				predict: () => {
					requests++;
					return { candidates: [], draftTokens: 1 };
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);

		expect(requests).toBe(1);
	});

	it("publishes byte and lifecycle phase diagnostics on completion and hit", async () => {
		const events: SpeculativeActionEvent<string>[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predict: () => ({ candidates: [scheduledCandidate("a.ts", 10)], draftTokens: 0 }),
				captureResourceVersion: () => ({ captureMs: 2, captureBytes: 3, captureFiles: 1 }),
				isResourceExpired: () => ({
					expired: false,
					durationMs: 4,
					bytesRead: 5,
					filesRead: 1,
					mode: "exact",
				}),
				candidateExecutionMetrics: () => ({ sandboxSetupMs: 6, changeCollectionMs: 7 }),
				candidateSizeBytes: () => 64,
				adoptCandidate: ({ candidate, output }) => {
					candidate.commitMs = 8;
					candidate.commitValidationMs = 3;
					candidate.commitValidationBytes = 5;
					candidate.commitValidationFiles = 1;
					return output;
				},
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => events.some((event) => event.type === "completed"));
		expect(events.find((event) => event.type === "completed")).toEqual(
			expect.objectContaining({
				resourceCaptureMs: 2,
				resourceCaptureBytes: 3,
				resourceCaptureFiles: 1,
				sandboxSetupMs: 6,
				changeCollectionMs: 7,
				cacheByteCapacity: 256 * 1024 * 1024,
			}),
		);

		expect(await runtime.consume(call("turn", "read", { path: "a.ts" }))).toBe("prefetched");
		expect(events.find((event) => event.type === "hit")).toEqual(
			expect.objectContaining({
				validationMs: 4,
				validationBytes: 5,
				validationFiles: 1,
				validationMode: "exact",
				commitMs: 8,
				commitValidationMs: 3,
				commitValidationBytes: 5,
				commitValidationFiles: 1,
			}),
		);
	});

	it("resolves a PatternAware lease attached to a resource job from an earlier turn", async () => {
		const outcomes: string[] = [];
		let executions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predict: (input) => ({
					candidates:
						input.turnID === "seed" ? [{ type: "tool_call", tool: "read", input: { path: "README.md" } }] : [],
					draftTokens: 0,
				}),
				predictPatternAware: (input) => ({
					candidates:
						input.turnID === "reuse"
							? [patternCandidate("read", { path: "README.md" }, "reused_pattern", 0)]
							: [],
					draftTokens: 0,
				}),
				executeCandidate: () => {
					executions++;
					return "cached";
				},
				onPatternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
			}),
		);

		await runtime.startTurn(start("seed"));
		await waitFor(() => executions === 1);
		await runtime.finishTurn(start("seed"));
		await runtime.startTurn(start("reuse"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		await runtime.finishTurn({ ...start("reuse"), terminal: true });

		expect(executions).toBe(1);
		expect(outcomes).toEqual(["reused_pattern:actor_miss"]);
	});

	it("credits a matching pattern independently from resource freshness", async () => {
		const outcomes: string[] = [];
		const events: SpeculativeActionEvent<string>[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({
					candidates: [patternCandidate("read", { path: "stale.txt" }, "stale_pattern", 0)],
					draftTokens: 0,
				}),
				captureResourceVersion: () => "version",
				isResourceExpired: () => true,
				onPatternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("freshness"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(await runtime.consume(call("freshness", "read", { path: "stale.txt" }))).toBeUndefined();

		expect(outcomes).toEqual(["stale_pattern:consumed"]);
		expect(events).toContainEqual(expect.objectContaining({ type: "miss", reason: "resource_expired" }));
	});

	it("expands a sandbox-dependent chain only after the parent is adopted", async () => {
		const executions: string[] = [];
		let continuations = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predictPatternAware: () => ({
					candidates: [patternCandidate("bash", { command: "prepare" }, "sandbox_parent", 0)],
					draftTokens: 0,
				}),
				executeCandidate: ({ tool }) => {
					executions.push(tool);
					return `${tool}-result`;
				},
				adoptCandidate: ({ output }) => output,
				continuePatternAware: ({ candidate }) => {
					if (candidate.tool !== "bash") return undefined;
					continuations++;
					return {
						candidates: [patternCandidate("read", { path: "generated.txt" }, "sandbox_child", 0)],
						draftTokens: 0,
					};
				},
			}),
		);

		await runtime.startTurn(start("sandbox-chain"));
		await waitFor(() => executions.includes("bash"));
		expect(continuations).toBe(0);
		expect(await runtime.consume(call("sandbox-chain", "bash", { command: "prepare" }))).toBe("bash-result");
		await waitFor(() => executions.includes("read"));
		expect(continuations).toBe(1);
	});

	it("invalidates the full bash workdir after successful sandbox adoption", async () => {
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				predict: () => ({
					candidates: [
						{
							type: "tool_call",
							tool: "bash",
							input: { command: "update a" },
							expectedDurationMs: 100,
							expectedLatencyBenefitMs: 100,
						},
						scheduledCandidate("a.ts", 100),
						scheduledCandidate("b.ts", 100),
					],
					draftTokens: 0,
				}),
				executeCandidate: ({ tool, concrete }) => `${tool}:${String(concrete.path ?? concrete.command)}`,
				adoptCandidate: ({ candidate, output }) => {
					candidate.commitValidationFiles = 1;
					candidate.changedResources = ["a.ts"];
					return output;
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(await runtime.consume(call("turn", "bash", { command: "update a" }))).toContain("bash:update a");

		expect(await runtime.consume(call("turn", "read", { path: "a.ts" }))).toBeUndefined();
		expect(await runtime.consume(call("turn", "read", { path: "b.ts" }))).toBeUndefined();
	});
});

function adapter(overrides: Partial<Adapter> = {}): Adapter {
	return {
		settings,
		definitions: () => [{ name: "read" }, { name: "grep" }, { name: "find" }, { name: "bash" }],
		stateData: () => ({ cwd: "." }),
		predict: () => ({ candidates: [], draftTokens: 0 }),
		actionKey: (tool, input) => key(tool, input as Record<string, unknown>),
		actual: (input) => ({ tool: input.tool, input: input.input }),
		preflightCandidate: () => ({ ok: true }),
		executeCandidate: () => "prefetched",
		...overrides,
	};
}

function settings(): SpeculativeActionSettings {
	return {
		enabled: true,
		mode: "predict_action_single_step",
		candidateLimit: 8,
		maxConcurrentActions: 8,
		resourceCacheMaxEntries: 512,
		predictionTimeoutMs: 100,
		patternAware: PATTERN_AWARE_DEFAULTS,
		tools: { resourceCached: ["read", "grep", "find"], sandbox: ["bash"] },
	};
}

function patternCandidate(
	tool: string,
	input: Record<string, unknown>,
	patternID: string,
	horizon: number,
): SpeculativeDraftCandidate {
	return {
		type: "tool_call",
		source: "pattern_aware",
		tool,
		input,
		patternID,
		horizon,
		empiricalProbability: 1,
		expectedDurationMs: 10,
		expectedLatencyBenefitMs: 10,
	};
}

function scheduledCandidate(path: string, expectedLatencyBenefitMs: number): SpeculativeDraftCandidate {
	return {
		type: "tool_call",
		tool: "read",
		input: { path },
		expectedDurationMs: 100,
		expectedLatencyBenefitMs,
	};
}

function preparationHint(path: string): SpeculativeDraftCandidate {
	return {
		type: "preparation_hint",
		source: "pattern_aware",
		tool: "read",
		input: { path },
		missing: [["offset"]],
		patternID: `read:${path}`,
		horizon: 1,
		empiricalProbability: 1,
		expectedDurationMs: 10,
		expectedLatencyBenefitMs: 10,
	};
}

function key(tool: string, input: Record<string, unknown>) {
	return buildActionKey({
		tool,
		execution: tool === "bash" ? "sandbox" : "resource_cached",
		resources: [String(input.path ?? input.pattern ?? input.command ?? tool)],
		input,
	});
}

function start(turnID: string): Start {
	return { sessionID: "session", turnID };
}

function call(turnID: string, tool: string, input: Record<string, unknown>): Consume {
	return { ...start(turnID), tool, input };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
