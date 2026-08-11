import { describe, expect, it } from "vitest";
import { buildActionKey } from "../src/common.ts";
import type { WorldBranch } from "../src/execution-world.ts";
import { PATTERN_AWARE_DEFAULTS } from "../src/pattern-aware.ts";
import type { PlanAction, PlanProposal } from "../src/plan-proposal.ts";
import type {
	PlanActionResolution,
	SpeculativeActionEvent,
	SpeculativeActionRuntimeAdapter,
	SpeculativeActionSettings,
	SpeculativeDraftCandidate,
	SpeculativePlanSource,
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
type PlanSource = SpeculativePlanSource<string, string, Start, Consume, { readonly cwd: string }>;
type SourceContinueInput = Parameters<NonNullable<PlanSource["continue"]>>[0];
type SourceObserveInput = Parameters<NonNullable<PlanSource["observe"]>>[0];

interface TestDraftCandidate extends SpeculativeDraftCandidate {
	readonly patternID?: string;
	readonly patternContext?: unknown;
}

interface TestPrediction {
	readonly candidates: readonly TestDraftCandidate[];
	readonly draftTokens: number;
}

interface PatternRuntimeTestHooks {
	readonly draftPropose?: (
		input: Start,
		settings: SpeculativeActionSettings,
		definitions: readonly { readonly name: string }[],
		candidateNames: readonly string[],
		signal: AbortSignal,
	) => TestPrediction | Promise<TestPrediction>;
	readonly patternPropose?: (
		input: Start,
		settings: SpeculativeActionSettings,
		definitions: readonly { readonly name: string }[],
		candidateNames: readonly string[],
		signal: AbortSignal,
	) => TestPrediction | Promise<TestPrediction>;
	readonly patternContinue?: (
		input: SourceContinueInput & {
			readonly patternID: string;
			readonly patternContext: unknown;
		},
	) => TestPrediction | Promise<TestPrediction | undefined> | undefined;
	readonly patternObserve?: (
		input: SourceObserveInput,
	) => TestPrediction | Promise<TestPrediction | undefined> | undefined;
	readonly patternLaunched?: (patternID: string, context?: unknown) => void | Promise<void>;
	readonly patternResolved?: (
		patternID: string,
		outcome: PlanActionResolution,
		context?: unknown,
	) => void | Promise<void>;
	readonly patternFlush?: () => void | Promise<void>;
}

type AdapterOverrides = Partial<Adapter> & PatternRuntimeTestHooks;

describe("PatternAware runtime integration", () => {
	it("keeps a future candidate across an unrelated action and provider turn", async () => {
		let executions = 0;
		const outcomes: string[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: (input) => ({
					candidates:
						input.turnID === "turn_1" ? [patternCandidate("read", { path: "README.md" }, "read", 1)] : [],
					draftTokens: 0,
				}),
				executeCandidate: () => {
					executions++;
					return "prefetched";
				},
				patternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
			}),
		);

		await runtime.startTurn(start("turn_1"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(executions).toBe(0);
		expect(await runtime.consume(call("turn_1", "find", { pattern: "*" }))).toBeUndefined();
		await waitFor(() => executions === 1);
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
				patternPropose: () => ({
					candidates: [patternCandidate("bash", { command: "npm test" }, "bash", 0)],
					draftTokens: 0,
				}),
				patternResolved: (id, outcome) => {
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
		expect(events).toContainEqual(
			expect.objectContaining({ type: "cancelled", reason: "prediction_horizon_expired" }),
		);
	});

	it("settles deferred future sandbox work without starting it when the actor response is terminal", async () => {
		const outcomes: string[] = [];
		const events: SpeculativeActionEvent<string>[] = [];
		let aborted = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
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
				patternResolved: (id, outcome) => {
					outcomes.push(`${id}:${outcome}`);
				},
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(runtime.inspect().deferredPlanActions).toBe(1);
		await runtime.finishTurn({ ...start("turn"), terminal: true });

		expect(outcomes).toEqual(["terminal:actor_miss"]);
		expect(aborted).toBe(0);
		expect(events.some((event) => event.type === "started")).toBe(false);
	});

	it("awaits pattern persistence before terminal finish returns", async () => {
		let flushStarted = false;
		let flushFinished = false;
		let releaseFlush!: () => void;
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternFlush: async () => {
					flushStarted = true;
					await flushGate;
					flushFinished = true;
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		const finishing = runtime.finishTurn({ ...start("turn"), terminal: true });
		await waitFor(() => flushStarted);
		expect(flushFinished).toBe(false);
		releaseFlush();
		await finishing;

		expect(flushFinished).toBe(true);
	});

	it("keeps a fresh resource result after its terminal pattern lease ends", async () => {
		const outcomes: string[] = [];
		let executions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: (input) => ({
					candidates:
						input.turnID === "turn_1" ? [patternCandidate("read", { path: "README.md" }, "cached", 0)] : [],
					draftTokens: 0,
				}),
				executeCandidate: () => {
					executions++;
					return "cached";
				},
				patternResolved: (id, outcome) => {
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
		const events: SpeculativeActionEvent<string>[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
					candidates: [patternCandidate("read", { path: "README.md" }, "shared", 0)],
					draftTokens: 0,
				}),
				draftPropose: () => ({
					candidates: [{ type: "tool_call", tool: "read", input: { path: "README.md" } }],
					draftTokens: 3,
				}),
				executeCandidate: () => {
					executions++;
					return "one";
				},
				patternLaunched: () => {
					launches++;
				},
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(await runtime.consume(call("turn", "read", { path: "README.md" }))).toBe("one");
		expect(executions).toBe(1);
		expect(launches).toBe(1);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "hit",
				source: "pattern_aware",
				sources: ["pattern_aware", "drafter"],
			}),
		);
	});

	it("flushes terminal PatternAware state after prediction leases settle", async () => {
		const lifecycle: string[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
					candidates: [patternCandidate("read", { path: "README.md" }, "terminal-pattern", 8)],
					draftTokens: 0,
				}),
				onTurnFinished: () => {
					lifecycle.push("turn_finished");
				},
				patternResolved: (_id, outcome) => {
					lifecycle.push(`resolved:${outcome}`);
				},
				patternFlush: () => {
					lifecycle.push(`flush_after:${lifecycle.at(-1)}`);
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		expect(runtime.inspect().deferredPlanActions).toBe(1);
		await runtime.finishTurn({ ...start("turn"), terminal: true });

		expect(lifecycle).toEqual(["turn_finished", "resolved:actor_miss", "flush_after:resolved:actor_miss"]);
	});

	it("routes lifecycle updates through each candidate store context", async () => {
		const first = { store: "first" };
		const second = { store: "second" };
		const launched: unknown[] = [];
		const resolved: Array<{ context: unknown; outcome: string }> = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
					candidates: [
						{ ...patternCandidate("read", { path: "a.ts" }, "first", 0), patternContext: first },
						{ ...patternCandidate("read", { path: "b.ts" }, "second", 0), patternContext: second },
					],
					draftTokens: 0,
				}),
				patternLaunched: (_id, context) => {
					launched.push(context);
				},
				patternResolved: (_id, outcome, context) => {
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
				patternObserve: ({ tool, output }) =>
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
				draftPropose: (input) => ({
					candidates:
						input.turnID === "turn_1"
							? [
									{ type: "tool_call", tool: "bash", input: { command: "first" } },
									{ type: "tool_call", tool: "bash", input: { command: "second" } },
								]
							: [],
					draftTokens: 0,
				}),
				patternObserve: ({ tool, concrete }) =>
					tool === "bash" && concrete.command === "first"
						? { candidates: [patternCandidate("bash", { command: "second" }, "second", 1)], draftTokens: 0 }
						: undefined,
				executeCandidate: ({ concrete }) => {
					executions++;
					return worldExecution(String(concrete.command));
				},
				patternResolved: (id, outcome) => {
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
				draftPropose: (input) => ({
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
				patternPropose: (input) => ({
					candidates:
						input.turnID === "turn_1"
							? [
									{
										...patternCandidate("read", { path: "a.ts" }, "low", 0),
										expectedDurationMs: 100,
										empiricalProbability: 0.55,
										expectedLatencyBenefitMs: 55,
									},
								]
							: input.turnID === "turn_2"
								? [
										{
											...patternCandidate("read", { path: "b.ts" }, "high", 0),
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
				patternResolved: (id, outcome) => {
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

	it("keeps in-flight jobs outside result-cache LRU pressure", async () => {
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
				draftPropose: (input) => ({
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

		expect(aborted).toBe(0);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "cancelled", reason: "resource_cache_evicted" }),
		);
		expect(runtime.inspect("session").resourceCandidates).toBe(2);
		await runtime.dispose();
		expect(aborted).toBe(1);
	});

	it("deduplicates and bounds preparation hints without executing them", async () => {
		const prepared: string[] = [];
		let executions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), candidateLimit: 2, maxConcurrentActions: 2 }),
				patternPropose: () => ({
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

	it("expands each PatternAware lease once when a continuation reuses the same result", async () => {
		const continuations: string[] = [];
		let executions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
					candidates: [patternCandidate("read", { path: "src/a.ts" }, "parent", 0)],
					draftTokens: 0,
				}),
				executeCandidate: () => {
					executions++;
					return "file";
				},
				patternContinue: ({ patternID }) => {
					continuations.push(patternID);
					return patternID === "parent"
						? {
								candidates: [patternCandidate("read", { path: "src/a.ts" }, "child", 0)],
								draftTokens: 0,
							}
						: undefined;
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => continuations.includes("parent"));
		expect(executions).toBe(1);
		expect(await runtime.consume(call("turn", "read", { path: "src/a.ts" }))).toBe("file");
		await waitFor(() => continuations.includes("child"));

		expect(executions).toBe(1);
		expect(continuations.filter((patternID) => patternID === "parent")).toHaveLength(2);
		expect(continuations.filter((patternID) => patternID === "child")).toHaveLength(1);
		await runtime.dispose();
	});

	it("keeps immediate template predictions while multi-step speculation is disabled", async () => {
		const executed: string[] = [];
		const prepared: string[] = [];
		let continuations = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({
					...settings(),
					patternAware: { ...PATTERN_AWARE_DEFAULTS, multiStepEnabled: false },
				}),
				patternPropose: () => ({
					candidates: [
						patternCandidate("read", { path: "immediate.ts" }, "immediate", 0),
						patternCandidate("read", { path: "future.ts" }, "future", 1),
						preparationHint("hint.ts"),
					],
					draftTokens: 0,
				}),
				prepareCandidate: ({ candidate }) => {
					prepared.push(String((candidate.input as { path?: string }).path));
				},
				executeCandidate: ({ concrete }) => {
					executed.push(String(concrete.path));
					return "immediate";
				},
				patternContinue: () => {
					continuations++;
					return undefined;
				},
			}),
		);

		await runtime.startTurn(start("turn"));
		await waitFor(() => runtime.inspect().pendingPredictions === 0);
		await waitFor(() => executed.length === 1);

		expect(executed).toEqual(["immediate.ts"]);
		expect(prepared).toEqual(["immediate.ts"]);
		expect(continuations).toBe(0);
		await runtime.dispose();
	});

	it("expands a completed speculative result into a multi-step frontier", async () => {
		const executed: string[] = [];
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
					candidates: [
						{ ...patternCandidate("read", { path: "src/a.ts" }, "read", 0), patternContext: { step: 1 } },
					],
					draftTokens: 0,
				}),
				executeCandidate: ({ tool }) => {
					executed.push(tool);
					return tool === "read" ? "structured-read" : worldExecution("test-output");
				},
				patternContinue: ({ candidate, output, parentConfirmed }) => {
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
		await waitFor(() => executed.length === 1);
		expect(executed).toEqual(["read"]);
		expect(await runtime.consume(call("turn", "read", { path: "src/a.ts" }))).toBe("structured-read");
		await waitFor(() => executed.length === 2);

		expect(executed).toEqual(["read", "bash"]);
		expect(await runtime.consume(call("turn", "bash", { command: "npm test" }))).toBe("test-output");
	});

	it("upgrades an already-expanded chain after parent confirmation without re-executing it", async () => {
		const executions = new Map<string, number>();
		const continuations: string[] = [];
		const launches: string[] = [];
		let predictions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), predictionTimeoutMs: 5_000 }),
				patternPropose: () => ({
					candidates:
						predictions++ === 0 ? [confidenceCandidate("parent.ts", "parent", 0.25, { confidence: 0.25 })] : [],
					draftTokens: 0,
				}),
				executeCandidate: ({ concrete }) => {
					const path = String(concrete.path);
					executions.set(path, (executions.get(path) ?? 0) + 1);
					return `${path}:output`;
				},
				patternContinue: ({ candidate, patternContext, parentConfirmed }) => {
					const path = String(candidate.input.path);
					const confidence = (patternContext as { confidence?: number } | undefined)?.confidence;
					continuations.push(`${path}:${parentConfirmed}:${candidate.empiricalProbability}:${confidence}`);
					if (path === "parent.ts") {
						const next = parentConfirmed ? 0.8 : 0.2;
						return {
							candidates: [confidenceCandidate("child.ts", "child", next, { confidence: next })],
							draftTokens: 0,
						};
					}
					if (path === "child.ts") {
						const next = confidence === 0.8 ? 0.6 : 0.1;
						return {
							candidates: [confidenceCandidate("grandchild.ts", "grandchild", next, { confidence: next })],
							draftTokens: 0,
						};
					}
					return undefined;
				},
				patternLaunched: (patternID) => {
					launches.push(patternID);
				},
			}),
		);

		await runtime.startTurn(start("upgrade-chain"));
		await waitFor(() => continuations.includes("parent.ts:false:0.25:0.25"));
		expect(Object.fromEntries(executions)).toEqual({
			"parent.ts": 1,
		});

		expect(await runtime.consume(call("upgrade-chain", "read", { path: "parent.ts" }))).toBe("parent.ts:output");
		await waitFor(() => continuations.includes("child.ts:false:0.8:0.8"));
		expect(Object.fromEntries(executions)).toEqual({ "parent.ts": 1, "child.ts": 1 });
		expect(await runtime.consume(call("upgrade-chain", "read", { path: "child.ts" }))).toBe("child.ts:output");
		await waitFor(() => continuations.includes("grandchild.ts:false:0.6:0.6"));

		expect(continuations).toEqual([
			"parent.ts:false:0.25:0.25",
			"parent.ts:true:0.25:0.25",
			"child.ts:false:0.8:0.8",
			"child.ts:true:0.8:0.8",
			"grandchild.ts:false:0.6:0.6",
		]);
		expect(launches).toEqual(["parent", "child", "grandchild"]);
		expect(Object.fromEntries(executions)).toEqual({
			"parent.ts": 1,
			"child.ts": 1,
			"grandchild.ts": 1,
		});

		await runtime.consume(call("upgrade-chain", "read", { path: "grandchild.ts" }));
		expect(continuations.filter((item) => item.startsWith("child.ts:true"))).toHaveLength(1);
		await runtime.dispose();
	});

	it("defers a low-confidence descendant until its parent becomes authoritative", async () => {
		const executions: string[] = [];
		const parentConfirmations: boolean[] = [];
		const events: SpeculativeActionEvent<string>[] = [];
		const launches: string[] = [];
		let predictions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({
					...settings(),
					candidateLimit: 1,
					maxConcurrentActions: 1,
					predictionTimeoutMs: 5_000,
				}),
				patternPropose: () => ({
					candidates: predictions++ === 0 ? [confidenceCandidate("parent.ts", "parent", 0.5)] : [],
					draftTokens: 0,
				}),
				executeCandidate: ({ concrete }) => {
					const path = String(concrete.path ?? concrete.pattern);
					executions.push(path);
					return `${path}:output`;
				},
				patternContinue: ({ candidate, parentConfirmed }) => {
					if (candidate.input.path !== "parent.ts") return undefined;
					parentConfirmations.push(parentConfirmed);
					return {
						candidates: [
							{
								...confidenceCandidate("child.ts", "child", parentConfirmed ? 0.9 : 0.2),
								tool: "grep",
								input: { pattern: "child.ts" },
							},
						],
						draftTokens: 0,
					};
				},
				patternLaunched: (patternID) => {
					launches.push(patternID);
				},
				onEvent: (event) => {
					events.push(event);
				},
			}),
		);

		await runtime.startTurn(start("admit-after-confirmation"));
		await waitFor(() => parentConfirmations.includes(false));
		expect(executions).toEqual(["parent.ts"]);
		expect(parentConfirmations).toEqual([false]);
		expect(events.some((event) => event.type === "cancelled" && event.tool === "grep")).toBe(false);

		expect(await runtime.consume(call("admit-after-confirmation", "read", { path: "parent.ts" }))).toBe(
			"parent.ts:output",
		);
		await waitFor(() => executions.includes("child.ts"));

		expect(parentConfirmations).toEqual([false, true]);
		expect(executions).toEqual(["parent.ts", "child.ts"]);
		expect(launches).toEqual(["parent", "child"]);
		expect(events.some((event) => event.type === "cancelled" && event.tool === "grep")).toBe(false);
		await runtime.dispose();
	});

	it("expands a running parent once at confirmed confidence when the actor arrives first", async () => {
		const executions: string[] = [];
		const parentConfirmations: boolean[] = [];
		const outcomes: string[] = [];
		let releaseParent!: (output: string) => void;
		const parentOutput = new Promise<string>((resolve) => {
			releaseParent = resolve;
		});
		let predictions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
					candidates: predictions++ === 0 ? [confidenceCandidate("parent.ts", "parent", 0.4)] : [],
					draftTokens: 0,
				}),
				executeCandidate: ({ concrete }) => {
					const path = String(concrete.path ?? concrete.pattern);
					executions.push(path);
					return path === "parent.ts" ? parentOutput : "child-output";
				},
				patternContinue: ({ candidate, parentConfirmed }) => {
					if (candidate.input.path !== "parent.ts") return undefined;
					parentConfirmations.push(parentConfirmed);
					return {
						candidates: [
							{
								...confidenceCandidate("child.ts", "child", 0.8),
								tool: "grep",
								input: { pattern: "child.ts" },
							},
						],
						draftTokens: 0,
					};
				},
				patternResolved: (patternID, outcome) => {
					outcomes.push(`${patternID}:${outcome}`);
				},
			}),
		);

		await runtime.startTurn(start("actor-first"));
		await waitFor(() => executions.includes("parent.ts"));
		const consumed = runtime.consume(call("actor-first", "read", { path: "parent.ts" }));
		await waitFor(() => outcomes.includes("parent:consumed"));
		releaseParent("parent-output");

		expect(await consumed).toBe("parent-output");
		await waitFor(() => executions.includes("child.ts"));
		expect(parentConfirmations).toEqual([true]);
		expect(executions).toEqual(["parent.ts", "child.ts"]);
		await runtime.dispose();
	});

	it("does not upgrade descendants when the actor misses their speculative parent", async () => {
		const parentConfirmations: boolean[] = [];
		const executions: string[] = [];
		let predictions = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
					candidates: predictions++ === 0 ? [confidenceCandidate("parent.ts", "parent", 0.4)] : [],
					draftTokens: 0,
				}),
				executeCandidate: ({ concrete }) => {
					executions.push(String(concrete.path));
					return "output";
				},
				patternContinue: ({ candidate, parentConfirmed }) => {
					if (candidate.input.path !== "parent.ts") return undefined;
					parentConfirmations.push(parentConfirmed);
					return {
						candidates: [confidenceCandidate("child.ts", "child", parentConfirmed ? 0.9 : 0.2)],
						draftTokens: 0,
					};
				},
			}),
		);

		await runtime.startTurn(start("parent-miss"));
		await waitFor(() => parentConfirmations.includes(false));
		expect(await runtime.consume(call("parent-miss", "find", { pattern: "*.ts" }))).toBeUndefined();

		expect(parentConfirmations).toEqual([false]);
		expect(executions).toEqual(["parent.ts"]);
		expect(runtime.inspect().blockedPlanActions).toBe(1);
		await runtime.dispose();
	});

	it("does not expand the frontier after terminal cancellation", async () => {
		let continuations = 0;
		let aborted = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				patternPropose: () => ({
					candidates: [
						{ ...patternCandidate("bash", { command: "long" }, "long", 0), patternContext: { step: 1 } },
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
				patternContinue: () => {
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
				settings: () => ({ ...settings(), resourceCacheMaxBytes: 1200 }),
				draftPropose: (input) => ({
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
				draftPropose: () => ({ candidates: [scheduledCandidate("a.ts", 10)], draftTokens: 0 }),
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
				draftPropose: (input) => ({
					candidates: [scheduledCandidate(`${input.sessionID}.ts`, 10)],
					draftTokens: 0,
				}),
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
				draftPropose: () => {
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
				patternPropose: () => ({
					candidates: [patternCandidate("read", { path: "README.md" }, "immediate", 0)],
					draftTokens: 0,
				}),
				draftPropose: () => {
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
				patternPropose: () => ({ candidates: [], draftTokens: 0, deferDrafter: true }),
				draftPropose: () => {
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
				draftPropose: () => ({
					candidates: [patternCandidate("bash", { command: "collect metrics" }, "metrics", 0)],
					draftTokens: 0,
				}),
				captureResourceVersion: () => ({ captureMs: 2, captureBytes: 3, captureFiles: 1 }),
				isResourceExpired: () => ({
					expired: false,
					durationMs: 4,
					bytesRead: 5,
					filesRead: 1,
					mode: "exact",
				}),
				executeCandidate: () =>
					worldExecution("prefetched", {
						executionMetrics: { setupMs: 6, captureMs: 7 },
						adoptionMetrics: {
							durationMs: 8,
							validationMs: 3,
							bytesValidated: 5,
							resourcesValidated: 1,
							resourcesAdopted: 1,
						},
					}),
				candidateSizeBytes: () => 64,
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

		expect(await runtime.consume(call("turn", "bash", { command: "collect metrics" }))).toBe("prefetched");
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
				draftPropose: (input) => ({
					candidates:
						input.turnID === "seed" ? [{ type: "tool_call", tool: "read", input: { path: "README.md" } }] : [],
					draftTokens: 0,
				}),
				patternPropose: (input) => ({
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
				patternResolved: (id, outcome) => {
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
				patternPropose: () => ({
					candidates: [patternCandidate("read", { path: "stale.txt" }, "stale_pattern", 0)],
					draftTokens: 0,
				}),
				captureResourceVersion: () => "version",
				isResourceExpired: () => true,
				patternResolved: (id, outcome) => {
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
				patternPropose: () => ({
					candidates: [patternCandidate("bash", { command: "prepare" }, "sandbox_parent", 0)],
					draftTokens: 0,
				}),
				executeCandidate: ({ tool }) => {
					executions.push(tool);
					const output = `${tool}-result`;
					return tool === "bash" ? worldExecution(output) : output;
				},
				patternContinue: ({ candidate, parentConfirmed }) => {
					if (candidate.tool !== "bash") return undefined;
					expect(parentConfirmed).toBe(true);
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
				draftPropose: () => ({
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
				executeCandidate: ({ tool, concrete }) => {
					const output = `${tool}:${String(concrete.path ?? concrete.command)}`;
					return tool === "bash"
						? worldExecution(output, {
								resources: ["a.ts"],
								adoptionMetrics: {
									durationMs: 1,
									validationMs: 1,
									bytesValidated: 1,
									resourcesValidated: 1,
									resourcesAdopted: 1,
								},
							})
						: output;
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

function adapter(overrides: AdapterOverrides = {}): Adapter {
	const {
		draftPropose,
		patternPropose,
		patternContinue,
		patternObserve,
		patternLaunched,
		patternResolved,
		patternFlush,
		sources: configuredSources,
		...runtimeOverrides
	} = overrides;
	const sources: PlanSource[] = [...(configuredSources ?? [])];
	const patternRevisions = new Map<string, number>();
	let observedPlans = 0;
	if (patternPropose || patternContinue || patternObserve || patternLaunched || patternResolved || patternFlush) {
		sources.push({
			id: "pattern_aware",
			enabled: (current) => current.patternAware?.enabled ?? false,
			multiStepEnabled: (current) => current.patternAware?.multiStepEnabled ?? true,
			propose: async ({ startInput, settings: current, definitions, candidateNames, signal }) => {
				const proposalID = `test:pattern:${startInput.sessionID}:${startInput.turnID}`;
				patternRevisions.set(proposalID, 0);
				const predicted =
					(await patternPropose?.(startInput, current, definitions, candidateNames, signal)) ?? emptyPrediction();
				return fixturePlan(proposalID, "pattern_aware", predicted);
			},
			continue: patternContinue
				? async (input) => {
						const draft = input.feedback as TestDraftCandidate;
						if (!draft.patternID) return undefined;
						const predicted = await patternContinue({
							...input,
							patternID: draft.patternID,
							patternContext: draft.patternContext,
						});
						if (!predicted?.candidates.length) return undefined;
						const revision = (patternRevisions.get(input.proposalID) ?? 0) + 1;
						patternRevisions.set(input.proposalID, revision);
						return {
							proposalID: input.proposalID,
							source: "pattern_aware",
							revision,
							upsert: fixtureActions(predicted.candidates, [{ actionID: input.actionID, condition: "adopted" }]),
							draftTokens: predicted.draftTokens,
						};
					}
				: undefined,
			observe: patternObserve
				? async (input) => {
						const predicted = await patternObserve(input);
						if (!predicted?.candidates.length) return undefined;
						return fixturePlan(
							`test:pattern:observed:${input.consumeInput.sessionID}:${input.consumeInput.turnID}:${input.order}:${observedPlans++}`,
							"pattern_aware",
							predicted,
						);
					}
				: undefined,
			onLaunched: patternLaunched
				? ({ feedback }) => {
						const draft = feedback as TestDraftCandidate;
						if (draft.patternID) return patternLaunched(draft.patternID, draft.patternContext);
					}
				: undefined,
			onResolved: patternResolved
				? ({ feedback, outcome }) => {
						const draft = feedback as TestDraftCandidate;
						if (draft.patternID) return patternResolved(draft.patternID, outcome, draft.patternContext);
					}
				: undefined,
			flush: patternFlush,
		});
	}
	sources.push({
		id: "drafter",
		enabled: (current) => current.drafterEnabled ?? true,
		adaptive: true,
		timeoutMs: (current) => current.predictionTimeoutMs,
		propose: async ({ startInput, settings: current, definitions, candidateNames, signal }) =>
			fixturePlan(
				`test:drafter:${startInput.sessionID}:${startInput.turnID}`,
				"drafter",
				(await draftPropose?.(startInput, current, definitions, candidateNames, signal)) ?? emptyPrediction(),
			),
	});
	return {
		settings,
		definitions: () => [{ name: "read" }, { name: "grep" }, { name: "find" }, { name: "bash" }],
		stateData: () => ({ cwd: "." }),
		sources,
		actionKey: (tool, input) => key(tool, input as Record<string, unknown>),
		actual: (input) => ({ tool: input.tool, input: input.input }),
		preflightCandidate: () => ({ ok: true }),
		executeCandidate: ({ tool }) => (tool === "bash" ? worldExecution("prefetched") : "prefetched"),
		...runtimeOverrides,
	};
}

function worldExecution(output: string, overrides: Partial<WorldBranch<string>> = {}): WorldBranch<string> {
	return {
		output,
		backend: "test",
		resources: [],
		capturedBytes: 0,
		executionMetrics: {},
		state: "ready",
		adopt: async () => output,
		...overrides,
	};
}

function emptyPrediction(): TestPrediction {
	return { candidates: [], draftTokens: 0 };
}

function fixturePlan(id: string, source: string, predicted: TestPrediction): PlanProposal {
	return {
		id,
		source,
		revision: 0,
		actions: fixtureActions(predicted.candidates),
		draftTokens: predicted.draftTokens,
	};
}

function fixtureActions(
	candidates: readonly TestDraftCandidate[],
	dependsOn?: PlanAction["dependsOn"],
): readonly PlanAction[] {
	return candidates.map((candidate, index) => ({
		id: `${candidate.patternID ?? "action"}:${index}`,
		type: candidate.type,
		tool: candidate.tool,
		input: candidate.input,
		...(candidate.missing ? { missing: candidate.missing } : {}),
		...(candidate.execution ? { execution: candidate.execution } : {}),
		...(candidate.diagnostic ? { diagnostic: candidate.diagnostic } : {}),
		...(candidate.horizon !== undefined ? { horizon: candidate.horizon } : {}),
		...(candidate.empiricalProbability !== undefined ? { empiricalProbability: candidate.empiricalProbability } : {}),
		...(candidate.conditionalProbability !== undefined
			? { conditionalProbability: candidate.conditionalProbability }
			: {}),
		...(candidate.expectedDurationMs !== undefined ? { expectedDurationMs: candidate.expectedDurationMs } : {}),
		...(candidate.expectedLatencyBenefitMs !== undefined
			? { expectedLatencyBenefitMs: candidate.expectedLatencyBenefitMs }
			: {}),
		...(candidate.resourceDemand !== undefined ? { resourceDemand: candidate.resourceDemand } : {}),
		...(candidate.depth !== undefined ? { depth: candidate.depth } : {}),
		...(dependsOn?.length ? { dependsOn } : candidate.dependsOn?.length ? { dependsOn: candidate.dependsOn } : {}),
		feedback: candidate,
	}));
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
): TestDraftCandidate {
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

function confidenceCandidate(
	path: string,
	patternID: string,
	empiricalProbability: number,
	patternContext?: unknown,
): TestDraftCandidate {
	return {
		type: "tool_call",
		source: "pattern_aware",
		tool: "read",
		input: { path },
		patternID,
		...(patternContext !== undefined ? { patternContext } : {}),
		horizon: 0,
		empiricalProbability,
		conditionalProbability: empiricalProbability,
		expectedDurationMs: 100,
	};
}

function scheduledCandidate(path: string, expectedLatencyBenefitMs: number): TestDraftCandidate {
	return {
		type: "tool_call",
		tool: "read",
		input: { path },
		expectedDurationMs: 100,
		expectedLatencyBenefitMs,
	};
}

function preparationHint(path: string): TestDraftCandidate {
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
