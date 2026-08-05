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

		expect(outcomes).toEqual(["bash:unused"]);
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

		expect(outcomes).toEqual(["terminal:unused"]);
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

		expect(outcomes).toEqual(["cached:unused"]);
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
			{ context: second, outcome: "unused" },
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
				settings: () => ({ ...settings(), maxCandidates: 2 }),
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
				settings: () => ({ ...settings(), maxCandidates: 1 }),
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

	it("interrupts an in-flight resource job when per-session LRU evicts it", async () => {
		const events: SpeculativeActionEvent<string>[] = [];
		let aborted = 0;
		const runtime = makeSpeculativeActionRuntime(
			adapter({
				settings: () => ({ ...settings(), maxCandidates: 2, resourceCacheMaxEntries: 1 }),
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
				settings: () => ({ ...settings(), maxCandidates: 2 }),
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
		maxCandidates: 8,
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
