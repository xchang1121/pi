import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	createFauxCore,
	type FauxContentBlock,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { PI_ACTION_SEMANTICS } from "../src/action-semantics.ts";
import { createSpeculativeActionHost, type SpeculativeAgentSettingsInput } from "../src/agent-integration.ts";
import { PATTERN_AWARE_DEFAULTS, type PatternAwareSettings, PatternAwareStore } from "../src/pattern-aware.ts";
import type { SpeculativeActionEvent } from "../src/runtime.ts";
import { summarizeSpeculativeTrace } from "../src/trace-summary.ts";

const roots: string[] = [];
const readSchema = Type.Object({ path: Type.String() });
const grepSchema = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) });

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("faux LLM speculative action end to end", () => {
	it("masks completed tool latency across fragmented Actor and Drafter streams", async () => {
		const cwd = await workspace();
		const tool = delayedRead(cwd, 120);
		const actorTurns = [
			turn([
				fauxThinking("inspect the requested file before answering ".repeat(4)),
				fauxToolCall("read", { path: "notes.txt" }),
			]),
			turn("done"),
		];
		const draftTurns = [turn(fauxToolCall("read", { path: "notes.txt" })), turn("no tool")];

		const speculative = await runAgent({
			cwd,
			sessionID: "completed-hit",
			tools: [tool],
			actorTurns,
			actorTokensPerSecond: 180,
			draftTurns,
			draftTokensPerSecond: 2_000,
			settings: drafterSettings(),
		});
		expect(speculative.streamEvents).toEqual(expect.arrayContaining(["thinking_delta", "toolcall_delta"]));
		expect(speculative.summary).toMatchObject({
			tasks: 1,
			actorActions: 1,
			speculativeHits: 1,
			actorFallbacks: 0,
		});
		expect(speculative.summary.executionAheadMs).toBeGreaterThanOrEqual(100);
		expect(speculative.summary.hitLatencyMs).toBeLessThan(40);
		expect(speculative.summary.hiddenLatencyMs).toBeGreaterThanOrEqual(100);
		expect(speculative.summary.serializedMs - speculative.summary.endToEndMs).toBeCloseTo(
			speculative.summary.hiddenLatencyMs,
		);
		expect(speculative.executions.read).toBe(1);
		expect(speculative.toolLatencyMs[0]).toBeLessThan(40);
	});

	it("joins compatible work already in flight instead of starting Actor work", async () => {
		const cwd = await workspace();
		const result = await runAgent({
			cwd,
			sessionID: "in-flight-hit",
			tools: [delayedRead(cwd, 140)],
			actorTurns: [turn(fauxToolCall("read", { path: "notes.txt" }), 45), turn("done")],
			actorTokensPerSecond: 2_000,
			draftTurns: [turn(fauxToolCall("read", { path: "notes.txt" })), turn("no tool")],
			draftTokensPerSecond: 2_000,
			settings: drafterSettings(),
		});

		expect(result.summary).toMatchObject({ actorActions: 1, speculativeHits: 1, actorFallbacks: 0 });
		expect(result.executions.read).toBe(1);
		expect(result.summary.executionAheadMs).toBeGreaterThan(15);
		expect(result.summary.hitLatencyMs).toBeGreaterThan(35);
		expect(result.summary.hitLatencyMs).toBeLessThan(135);
		expect(result.summary.attemptLeadMs).toBeGreaterThan(result.summary.executionAheadMs);
	});

	it("falls back once when Drafter delivery is late or terminates with an error", async () => {
		const cwd = await workspace();
		for (const [sessionID, draft] of [
			["late-draft", turn(fauxToolCall("read", { path: "notes.txt" }), 250)],
			["failed-draft", errorTurn("mock stream disconnected")],
		] as const) {
			const result = await runAgent({
				cwd,
				sessionID,
				tools: [delayedRead(cwd, 50)],
				actorTurns: [turn(fauxToolCall("read", { path: "notes.txt" })), turn("done")],
				actorTokensPerSecond: 2_000,
				draftTurns: [draft, turn("no tool")],
				draftTokensPerSecond: 2_000,
				settings: { ...drafterSettings(), predictionTimeoutMs: 100 },
			});

			expect(result.summary).toMatchObject({ actorActions: 1, speculativeHits: 0, actorFallbacks: 1 });
			expect(result.executions.read).toBe(1);
			expect(result.summary.actorExecutionMs).toBeGreaterThanOrEqual(40);
			expect(
				(result.summary.sourceOutcomes.error ?? 0) +
					(result.summary.sourceOutcomes.timeout ?? 0) +
					(result.summary.sourceOutcomes.aborted ?? 0),
			).toBeGreaterThanOrEqual(1);
		}
	});

	it("learns a sequence and pre-executes two PatternAware steps without a Drafter", async () => {
		const cwd = await workspace();
		await Promise.all([
			writeFile(path.join(cwd, "a.ts"), "// TODO a", "utf8"),
			writeFile(path.join(cwd, "b.ts"), "// TODO b", "utf8"),
			writeFile(path.join(cwd, "c.ts"), "// TODO c", "utf8"),
			writeFile(path.join(cwd, "d.ts"), "// TODO d", "utf8"),
			writeFile(path.join(cwd, "e.ts"), "// TODO e", "utf8"),
			writeFile(path.join(cwd, "shared.txt"), "shared", "utf8"),
		]);
		const patternSettings: PatternAwareSettings = {
			...PATTERN_AWARE_DEFAULTS,
			maxFutureGap: 0,
			minOccurrences: 2,
			minBindingReplayProbability: 0.5,
		};
		const store = new PatternAwareStore(patternSettings, undefined, {
			namespace: "pi-action-semantics-v1",
			actionKey: (tool, input, schemaHash) => PI_ACTION_SEMANTICS.buildKey(tool, input, cwd, schemaHash),
			projectors: [],
		});

		for (const [index, file] of ["a.ts", "b.ts", "c.ts", "d.ts"].entries()) {
			await runAgent({
				cwd,
				sessionID: `training-${index}`,
				tools: patternTools(cwd, 5, file),
				actorTurns: sequenceTurns(file, false),
				actorTokensPerSecond: 4_000,
				draftTurns: [],
				settings: patternAwareSettings(patternSettings),
				patternStore: store,
			});
		}

		const evaluation = await runAgent({
			cwd,
			sessionID: "pattern-evaluation",
			tools: patternTools(cwd, 70, "e.ts"),
			actorTurns: sequenceTurns("e.ts", true),
			actorTokensPerSecond: 180,
			draftTurns: [],
			settings: patternAwareSettings(patternSettings),
			patternStore: store,
		});
		const actorSettlements = evaluation.events.filter((event) => event.type === "actor_action");

		expect(actorSettlements).toHaveLength(3);
		expect(actorSettlements[0]?.settlement.provider.kind).toBe("actor");
		expect(actorSettlements.slice(1).map((event) => event.settlement.provider.kind)).toEqual([
			"speculative",
			"speculative",
		]);
		expect(
			actorSettlements
				.slice(1)
				.flatMap((event) => event.settlement.matchedPredictions)
				.every((prediction) => prediction.source === "pattern_aware"),
		).toBe(true);
		expect(evaluation.summary).toMatchObject({ actorActions: 3, speculativeHits: 2, actorFallbacks: 1 });
		expect(evaluation.summary.executionAheadMs).toBeGreaterThan(100);
	});
});

type ScriptedTurn = {
	readonly content: string | FauxContentBlock | readonly FauxContentBlock[];
	readonly delayMs: number;
	readonly stopReason: "stop" | "toolUse" | "error";
	readonly errorMessage?: string;
};

type RunAgentInput = {
	readonly cwd: string;
	readonly sessionID: string;
	readonly tools: readonly AgentTool[];
	readonly actorTurns: readonly ScriptedTurn[];
	readonly actorTokensPerSecond: number;
	readonly draftTurns: readonly ScriptedTurn[];
	readonly draftTokensPerSecond?: number;
	readonly settings: SpeculativeAgentSettingsInput;
	readonly patternStore?: PatternAwareStore;
};

function turn(content: ScriptedTurn["content"], delayMs = 0): ScriptedTurn {
	return { content, delayMs, stopReason: contentHasTool(content) ? "toolUse" : "stop" };
}

function errorTurn(errorMessage: string): ScriptedTurn {
	return { content: "", delayMs: 0, stopReason: "error", errorMessage };
}

function contentHasTool(content: ScriptedTurn["content"]): boolean {
	const blocks = typeof content === "string" ? [] : Array.isArray(content) ? content : [content];
	return blocks.some((block) => block.type === "toolCall");
}

function scriptedResponses(turns: readonly ScriptedTurn[]): FauxResponseStep[] {
	return turns.map((script) => async () => {
		if (script.delayMs > 0) await delay(script.delayMs);
		return fauxAssistantMessage(script.content as string | FauxContentBlock | FauxContentBlock[], {
			stopReason: script.stopReason,
			...(script.errorMessage ? { errorMessage: script.errorMessage } : {}),
		});
	});
}

async function runAgent(input: RunAgentInput) {
	const actor = createFauxCore({
		provider: `actor-${input.sessionID}`,
		models: [{ id: "actor", reasoning: true }],
		tokensPerSecond: input.actorTokensPerSecond,
		tokenSize: { min: 1, max: 1 },
	});
	const drafter = createFauxCore({
		provider: `drafter-${input.sessionID}`,
		models: [{ id: "draft", reasoning: false }],
		tokensPerSecond: input.draftTokensPerSecond ?? 4_000,
		tokenSize: { min: 1, max: 1 },
	});
	actor.setResponses(scriptedResponses(input.actorTurns));
	drafter.setResponses(scriptedResponses(input.draftTurns));
	const events: SpeculativeActionEvent<string>[] = [];
	const executions: Record<string, number> = {};
	const toolLatencyMs: number[] = [];
	const measuredTools = input.tools.map(
		(base): AgentTool => ({
			...base,
			execute: async (callID, args, signal, onUpdate) => {
				executions[base.name] = (executions[base.name] ?? 0) + 1;
				return base.execute(callID, args as never, signal, onUpdate as never);
			},
		}),
	);
	const host = createSpeculativeActionHost(input.sessionID, {
		cwd: input.cwd,
		getSettings: () => input.settings,
		draftModel: drafter.getModel(),
		complete: (model, context, options) => drafter.streamSimple(model, context, options).result(),
		preflight: () => true,
		...(input.patternStore ? { patternStore: input.patternStore } : {}),
		onEvent: (event) => {
			events.push(event);
		},
	});
	let currentTurnID: string | undefined;
	let lastTurnID: string | undefined;
	let turnSequence = 0;
	const actorTools = measuredTools.map(
		(base): AgentTool => ({
			...base,
			execute: async (callID, args, signal, onUpdate) => {
				const turnID = currentTurnID;
				if (!turnID) throw new Error("Actor tool executed outside a provider turn");
				const intentStartedAt = performance.now();
				const cached = await host.consume(
					{ turnID, id: callID, tool: base.name, args, tools: measuredTools },
					signal,
				);
				if (cached) {
					toolLatencyMs.push(performance.now() - intentStartedAt);
					return cached.result;
				}
				const toolStartedAt = performance.now();
				try {
					const result = await base.execute(callID, args as never, signal, onUpdate as never);
					await host.actual({
						turnID,
						id: callID,
						tool: base.name,
						args,
						tools: measuredTools,
						durationMs: performance.now() - toolStartedAt,
						output: { result, isError: false },
					});
					toolLatencyMs.push(performance.now() - intentStartedAt);
					return result;
				} catch (error) {
					await host.actual({
						turnID,
						id: callID,
						tool: base.name,
						args,
						tools: measuredTools,
						durationMs: performance.now() - toolStartedAt,
						output: {
							result: {
								content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
								details: {},
							},
							isError: true,
						},
					});
					throw error;
				}
			},
		}),
	);
	const streamEvents: string[] = [];
	const agent = new Agent({
		streamFn: actor.streamSimple,
		sessionId: input.sessionID,
		initialState: {
			model: actor.getModel(),
			systemPrompt: "Use tools to inspect the workspace, then answer briefly.",
			tools: actorTools,
		},
	});
	agent.subscribe(async (event, signal) => {
		if (event.type === "message_update") streamEvents.push(event.assistantMessageEvent.type);
		if (event.type === "turn_start") {
			currentTurnID = `turn-${++turnSequence}`;
			lastTurnID = currentTurnID;
			await host.startTurn(
				{
					turnID: currentTurnID,
					actorModel: actor.getModel(),
					context: {
						systemPrompt: agent.state.systemPrompt,
						messages: standardMessages(agent.state.messages),
						tools: measuredTools,
					},
					actorOptions: { signal },
					tools: measuredTools,
				},
				signal,
			);
		}
		if (event.type === "turn_end" && currentTurnID) {
			const turnID = currentTurnID;
			currentTurnID = undefined;
			await host.finishTurn(turnID, false);
		}
		if (event.type === "agent_end" && lastTurnID) await host.finishTurn(lastTurnID, true);
	});

	try {
		await agent.prompt("Fix the reported issue by inspecting the relevant files.");
		if (input.settings.enabled !== false) {
			await waitFor(() => events.filter((event) => event.type === "actor_action").length === toolLatencyMs.length);
		}
		return {
			events,
			executions,
			streamEvents,
			toolLatencyMs,
			summary: summarizeSpeculativeTrace(events),
		};
	} finally {
		await host.dispose();
	}
}

function standardMessages(messages: readonly AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function delayedRead(cwd: string, durationMs: number): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: "Read a workspace file",
		parameters: readSchema,
		execute: async (_callID, args, signal) => {
			await delay(durationMs, signal);
			return textResult(await readFile(path.join(cwd, args.path), "utf8"));
		},
	};
}

function patternTools(cwd: string, durationMs: number, matchFile: string): AgentTool[] {
	const read = delayedRead(cwd, durationMs);
	const grep: AgentTool<typeof grepSchema> = {
		name: "grep",
		label: "grep",
		description: "Find a pattern in a workspace file",
		parameters: grepSchema,
		execute: async (_callID, args, signal) => {
			await delay(durationMs, signal);
			return textResult(`${matchFile}:1:${args.pattern}`);
		},
	};
	return [grep, read];
}

function sequenceTurns(file: string, addThinking: boolean): ScriptedTurn[] {
	const prefix = addThinking ? [fauxThinking("inspect the next dependency before continuing ".repeat(4))] : [];
	return [
		turn([...prefix, fauxToolCall("grep", { pattern: "TODO", path: "." })]),
		turn([...prefix, fauxToolCall("read", { path: file })]),
		turn([...prefix, fauxToolCall("read", { path: "shared.txt" })]),
		turn("done"),
	];
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

function drafterSettings(): SpeculativeAgentSettingsInput {
	return {
		enabled: true,
		drafterEnabled: true,
		candidateLimit: 1,
		maxConcurrentActions: 1,
		predictionTimeoutMs: 1_000,
		patternAware: { enabled: false },
		tools: { resourceCached: ["read"], sandbox: [] },
	};
}

function patternAwareSettings(patternAware: PatternAwareSettings): SpeculativeAgentSettingsInput {
	return {
		enabled: true,
		drafterEnabled: false,
		candidateLimit: 1,
		maxConcurrentActions: 4,
		predictionTimeoutMs: 1_000,
		patternAware,
		tools: { resourceCached: ["grep", "read"], sandbox: [] },
	};
}

async function workspace(): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-spec-faux-e2e-"));
	roots.push(cwd);
	await writeFile(path.join(cwd, "notes.txt"), "one\ntwo\nthree\n", "utf8");
	return cwd;
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, durationMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for end-to-end settlement");
		await delay(5);
	}
}
