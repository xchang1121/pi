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
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_ACTION_SEMANTICS } from "../src/action-semantics.ts";
import { createSpeculativeActionHost, type SpeculativeAgentSettingsInput } from "../src/agent-integration.ts";
import { PATTERN_AWARE_DEFAULTS, type PatternAwareSettings, PatternAwareStore } from "../src/pattern-aware.ts";
import type { SpeculativeActionEvent } from "../src/runtime.ts";
import { summarizeSpeculativeTrace } from "../src/trace-summary.ts";

const roots: string[] = [];
const readSchema = Type.Object({ path: Type.String() });
const grepSchema = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) });
const findSchema = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) });
const lsSchema = Type.Object({ path: Type.Optional(Type.String()) });
const bashSchema = Type.Object({ command: Type.String() });

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("faux LLM speculative action end to end", () => {
	it("gives the first Drafter request the current user message", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "target.txt"), "target", "utf8");
		const prompt = "Inspect target.txt before answering.";
		const result = await runAgent({
			cwd,
			sessionID: "current-user-context",
			prompt,
			tools: [delayedRead(cwd, 80)],
			actorTurns: [turn(fauxToolCall("read", { path: "target.txt" }), 120), turn("done")],
			actorTokensPerSecond: 4_000,
			draftTurns: [],
			draftResponses: [
				(context) =>
					fauxAssistantMessage(
						fauxToolCall("read", {
							path: context.messages.some(
								(message) => message.role === "user" && JSON.stringify(message.content).includes("target.txt"),
							)
								? "target.txt"
								: "notes.txt",
						}),
						{ stopReason: "toolUse" },
					),
				fauxAssistantMessage("no tool"),
			],
			settings: drafterSettings(),
		});

		expect(result.summary).toMatchObject({ actorActions: 1, speculativeHits: 1, actorFallbacks: 0 });
		expect(result.executions.read).toBe(1);
	});

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

	it("continues after joining compatible work already in flight", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "target.txt"), "target", "utf8");
		const run = (sessionID: string, drafterMaxDepth: number) => {
			const respond: FauxResponseStep = (context) => {
				const followsOwnDraft = context.messages.some(
					(message) => message.role === "assistant" && message.provider === `drafter-${sessionID}`,
				);
				const hasToolResult = context.messages.some((message) => message.role === "toolResult");
				return fauxAssistantMessage(
					!hasToolResult
						? fauxToolCall("read", { path: "notes.txt" })
						: followsOwnDraft
							? fauxToolCall("read", { path: "target.txt" })
							: "no tool",
					{ stopReason: !hasToolResult || followsOwnDraft ? "toolUse" : "stop" },
				);
			};
			return runAgent({
				cwd,
				sessionID,
				tools: [delayedRead(cwd, (file) => (file === "notes.txt" ? 160 : 180))],
				actorTurns: [
					turn(fauxToolCall("read", { path: "notes.txt" }), 45),
					turn(fauxToolCall("read", { path: "target.txt" }), 220),
					turn("done"),
				],
				actorTokensPerSecond: 2_000,
				draftTurns: [],
				draftResponses: Array.from({ length: 5 }, () => respond),
				draftTokensPerSecond: 2_000,
				settings: { ...drafterSettings(), drafterMaxDepth },
			});
		};
		const baseline = await run("in-flight-baseline", 0);
		const treatment = await run("in-flight-treatment", 1);

		expect(treatment.summary.sourceRequests).toBe(baseline.summary.sourceRequests);
		expect(baseline.summary).toMatchObject({ actorActions: 2, speculativeHits: 1, actorFallbacks: 1 });
		expect(treatment.summary).toMatchObject({ actorActions: 2, speculativeHits: 2, actorFallbacks: 0 });
		expect(treatment.executions.read).toBe(2);
		expect(treatment.summary.executionAheadMs).toBeGreaterThan(0);
		expect(treatment.summary.hitLatencyMs).toBeGreaterThan(0);
		expect(treatment.toolLatencyMs[1]).toBeLessThan(40);
		expect(baseline.summary.endToEndMs - treatment.summary.endToEndMs).toBeGreaterThan(120);
	});

	it("replaces an early low-utility pattern with a late high-utility draft for the same decision", async () => {
		const cwd = await workspace();
		await Promise.all([
			writeFile(path.join(cwd, "wrong.txt"), "wrong", "utf8"),
			writeFile(path.join(cwd, "target.txt"), "target", "utf8"),
		]);
		const patternSettings: PatternAwareSettings = {
			...PATTERN_AWARE_DEFAULTS,
			beamWidth: 1,
			maxContextLength: 1,
			maxFutureGap: 0,
			minOccurrences: 2,
		};
		const store = patternStore(cwd, patternSettings);
		for (const sessionID of ["training-one", "training-two"]) {
			trainPattern(store, sessionID, [
				["grep", { pattern: "target" }, 1, ["wrong.txt"]],
				["read", { path: "wrong.txt" }, 1],
			]);
		}
		store.observe({
			sessionID: "utility-replacement",
			turnID: "probe:grep",
			tool: "grep",
			input: { pattern: "target" },
			outputPaths: ["wrong.txt"],
			outcome: "success",
			durationMs: 1,
		});

		const result = await runAgent({
			cwd,
			sessionID: "utility-replacement",
			tools: [delayedRead(cwd, 250)],
			actorTurns: [turn(fauxToolCall("read", { path: "target.txt" }), 300), turn("done")],
			actorTokensPerSecond: 4_000,
			draftTurns: [turn(fauxToolCall("read", { path: "target.txt" }), 20), turn("no tool")],
			draftTokensPerSecond: 4_000,
			settings: {
				...patternAwareSettings(patternSettings),
				drafterEnabled: true,
				candidateLimit: 1,
				maxConcurrentActions: 1,
				tools: ["read"],
			},
			patternStore: store,
		});

		expect(result.summary).toMatchObject({ actorActions: 1, speculativeHits: 1, actorFallbacks: 0 });
		expect(result.summary.executionAheadMs).toBeGreaterThanOrEqual(200);
		expect(result.summary.hitLatencyMs).toBeLessThan(40);
		expect(result.executions.read).toBe(2);
		expect(
			result.events.some(
				(event) =>
					event.type === "candidate" &&
					event.state.status === "cancelled" &&
					event.state.cause.code === "scheduler_preempted",
			),
		).toBe(true);
	});

	it("uses the Actor runway to prioritize realizable hidden latency", async () => {
		const cwd = await workspace();
		await Promise.all([
			writeFile(path.join(cwd, "wrong.txt"), "wrong", "utf8"),
			writeFile(path.join(cwd, "target.txt"), "target", "utf8"),
		]);
		const patternSettings: PatternAwareSettings = {
			...PATTERN_AWARE_DEFAULTS,
			beamWidth: 2,
			maxContextLength: 1,
			maxFutureGap: 0,
			minOccurrences: 2,
		};
		const store = patternStore(cwd, patternSettings);
		for (let index = 0; index < 6; index++) {
			const target = index < 4;
			trainPattern(store, `runway-training-${index}`, [
				["grep", { pattern: "target" }, 1],
				["read", { path: target ? "target.txt" : "wrong.txt" }, target ? 80 : 1_000],
			]);
		}
		const grep = patternTools(cwd, 1, "target.txt").find((tool) => tool.name === "grep")!;

		const result = await runAgent({
			cwd,
			sessionID: "runway-priority",
			tools: [grep, delayedRead(cwd, (file) => (file === "wrong.txt" ? 1_000 : 80))],
			actorTurns: [
				turn(fauxToolCall("grep", { pattern: "target" }), 10),
				turn(fauxToolCall("read", { path: "target.txt" }), 100),
				turn("done"),
			],
			actorTokensPerSecond: 4_000,
			draftTurns: [],
			settings: {
				...patternAwareSettings(patternSettings),
				maxConcurrentActions: 1,
			},
			patternStore: store,
		});
		expect(result.summary).toMatchObject({
			actorActions: 2,
			speculativeHits: 1,
			actorFallbacks: 1,
			candidateTerminalCauses: { "admission:scheduler_preempted": 1 },
		});
		expect(result.executions).toEqual({ grep: 1, read: 2 });
		expect(result.summary.executionAheadMs).toBeGreaterThanOrEqual(60);
		expect(result.toolLatencyMs.at(-1)).toBeLessThan(30);
	});

	it("lets a nearer draft displace ready work for a later decision", async () => {
		const cwd = await workspace();
		await Promise.all([
			writeFile(path.join(cwd, "slow.txt"), "slow", "utf8"),
			writeFile(path.join(cwd, "target.txt"), "target", "utf8"),
		]);
		const patternSettings: PatternAwareSettings = {
			...PATTERN_AWARE_DEFAULTS,
			beamWidth: 1,
			maxContextLength: 3,
			maxFutureGap: 0,
			minOccurrences: 2,
			minBindingReplayProbability: 0.5,
		};
		const store = patternStore(cwd, patternSettings);
		for (const sessionID of ["training-one", "training-two", "training-three", "training-four"]) {
			trainPattern(store, sessionID, [
				["grep", { pattern: "target" }, 1],
				["find", { pattern: "step" }, 20],
				["ls", { path: "." }, 20],
				["read", { path: "slow.txt" }, 500],
			]);
		}
		store.observe({
			sessionID: "deadline-dominance",
			turnID: "probe:grep",
			tool: "grep",
			input: { pattern: "target" },
			outcome: "success",
			durationMs: 1,
		});

		const result = await runAgent({
			cwd,
			sessionID: "deadline-dominance",
			tools: [
				delayedStep("find", findSchema, 20),
				delayedStep("ls", lsSchema, 20),
				delayedRead(cwd, (file) => (file === "slow.txt" ? 500 : 200)),
			],
			actorTurns: [turn(fauxToolCall("read", { path: "target.txt" }), 400), turn("done")],
			actorTokensPerSecond: 4_000,
			draftTurns: [turn(fauxToolCall("read", { path: "target.txt" }), 100), turn("no tool")],
			draftTokensPerSecond: 4_000,
			settings: {
				...patternAwareSettings(patternSettings),
				drafterEnabled: true,
				candidateLimit: 1,
				maxConcurrentActions: 1,
				tools: ["find", "ls", "read"],
			},
			patternStore: store,
		});

		expect(result.summary).toMatchObject({ actorActions: 1, speculativeHits: 1, actorFallbacks: 0 });
		expect(result.summary.executionAheadMs).toBeGreaterThanOrEqual(150);
		expect(result.summary.hitLatencyMs).toBeLessThan(40);
	});

	it("matches Bash across fragmented model streams but executes only through the Actor", async () => {
		const cwd = await workspace();
		const result = await runAgent({
			cwd,
			sessionID: "bash-branch-hit",
			tools: [fallbackBash(cwd)],
			actorTurns: [
				turn([
					fauxThinking("prepare and validate the workspace command before invoking it ".repeat(5)),
					fauxToolCall("bash", { command: "generate artifact" }),
				]),
				turn("done"),
			],
			actorTokensPerSecond: 180,
			draftTurns: [turn(fauxToolCall("bash", { command: "generate artifact" })), turn("no tool")],
			draftTokensPerSecond: 2_000,
			settings: {
				...drafterSettings(),
				tools: ["bash"],
			},
		});

		expect(result.streamEvents).toEqual(expect.arrayContaining(["thinking_delta", "toolcall_delta"]));
		expect(result.summary).toMatchObject({
			actorActions: 1,
			speculativeHits: 0,
			actorFallbacks: 1,
			predictionsMatched: 1,
			predictionsAdopted: 0,
			executionBlockedActorActions: 1,
		});
		expect(result.summary.executionBlockedPotentialHiddenLatencyMs).toBeGreaterThan(0);
		expect(
			result.summary.executionBlockedPotentialHiddenLatencyMs + result.summary.executionBlockedPotentialHitLatencyMs,
		).toBe(result.summary.actorExecutionMs);
		expect(result.executions.bash).toBe(1);
		expect(await readFile(path.join(cwd, "generated.txt"), "utf8")).toBe("actor");
		expect(result.events.find((event) => event.type === "prediction")).toMatchObject({
			settlement: {
				match: {
					matched: true,
					adoption: { status: "rejected", cause: { stage: "execution", code: "isolation_unavailable" } },
				},
			},
		});
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
			tools: patternTools(cwd, 120, "e.ts"),
			actorTurns: [
				turn(fauxToolCall("grep", { pattern: "TODO", path: "." })),
				turn(fauxToolCall("read", { path: "e.ts" }), 230),
				turn(fauxToolCall("read", { path: "shared.txt" })),
				turn("done"),
			],
			actorTokensPerSecond: 4_000,
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
		expect(evaluation.summary.executionAheadMs).toBeGreaterThanOrEqual(200);
		expect(evaluation.summary.serializedMs - evaluation.summary.endToEndMs).toBeCloseTo(
			evaluation.summary.hiddenLatencyMs,
		);
		expect(evaluation.executions).toEqual({ grep: 1, read: 2 });
		expect(evaluation.toolLatencyMs.at(-1)).toBeLessThan(40);

		const observe = store.observeBatch.bind(store);
		vi.spyOn(store, "observeBatch").mockImplementation((...args) => {
			const deadline = performance.now() + 100;
			while (performance.now() < deadline) {
				// Replay the upper tail of PatternAware mining observed in historical traces.
			}
			return observe(...args);
		});
		const fastActor = await runAgent({
			cwd,
			sessionID: "pattern-fast-actor",
			tools: patternTools(cwd, 20, "e.ts"),
			actorTurns: sequenceTurns("e.ts", false),
			actorTokensPerSecond: 4_000,
			draftTurns: [],
			settings: patternAwareSettings(patternSettings),
			patternStore: store,
		});
		expect(fastActor.summary.actorActions).toBe(3);
		expect(fastActor.executions).toEqual({ grep: 1, read: 2 });
	});

	it("hides a sampled exact-action recurrence after its tool proves reuse", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "other.txt"), "other", "utf8");
		const patternSettings: PatternAwareSettings = {
			...PATTERN_AWARE_DEFAULTS,
			maxContextLength: 1,
			maxFutureGap: 0,
			minOccurrences: 2,
		};
		const store = new PatternAwareStore(patternSettings, undefined, {
			namespace: "pi-action-semantics-v1",
			actionKey: (tool, input, schemaHash) => PI_ACTION_SEMANTICS.buildKey(tool, input, cwd, schemaHash),
			projectors: [],
		});
		const result = await runAgent({
			cwd,
			sessionID: "exact-action-backoff",
			tools: patternTools(cwd, 120, "notes.txt"),
			actorTurns: [
				turn(fauxToolCall("read", { path: "notes.txt" })),
				turn(fauxToolCall("grep", { pattern: "separator", path: "." })),
				turn(fauxToolCall("read", { path: "notes.txt" })),
				turn(fauxToolCall("read", { path: "other.txt" })),
				turn([
					fauxThinking("verify the previously inspected file before answering ".repeat(4)),
					fauxToolCall("read", { path: "other.txt" }),
				]),
				turn("done"),
			],
			actorTokensPerSecond: 180,
			draftTurns: [],
			settings: patternAwareSettings(patternSettings),
			patternStore: store,
		});
		const actorSettlements = result.events.filter((event) => event.type === "actor_action");

		expect(actorSettlements).toHaveLength(5);
		expect(actorSettlements.at(-1)?.settlement.provider.kind).toBe("speculative");
		expect(result.summary).toMatchObject({ actorActions: 5, speculativeHits: 1, actorFallbacks: 4 });
		expect(result.summary.executionAheadMs).toBeGreaterThanOrEqual(100);
		expect(result.toolLatencyMs.at(-1)).toBeLessThan(40);
	});

	it("does not let an unisolated tool crowd an executable tool off a one-slot scheduler", async () => {
		const cwd = await workspace();
		const patternSettings: PatternAwareSettings = {
			...PATTERN_AWARE_DEFAULTS,
			beamWidth: 1,
			maxContextLength: 1,
			maxFutureGap: 0,
			minOccurrences: 2,
		};
		const store = new PatternAwareStore(patternSettings, undefined, {
			namespace: "pi-action-semantics-v1",
			actionKey: (tool, input, schemaHash) => PI_ACTION_SEMANTICS.buildKey(tool, input, cwd, schemaHash),
			projectors: [],
		});
		const train = (
			sessionID: string,
			turn: string,
			tool: string,
			input: Record<string, unknown>,
			durationMs: number,
			outputPaths?: readonly string[],
		) => {
			store.observe({
				sessionID,
				turnID: `${turn}:grep`,
				tool: "grep",
				input: { pattern: "TODO", path: "." },
				...(outputPaths ? { outputPaths } : {}),
				outcome: "success",
				durationMs: 1,
			});
			store.observe({ sessionID, turnID: `${turn}:${tool}`, tool, input, outcome: "success", durationMs });
		};
		for (let index = 0; index < 8; index++) {
			const sessionID = `historical-${index}`;
			train(sessionID, sessionID, "bash", { command: "generate artifact" }, 500);
		}
		for (let index = 0; index < 3; index++) {
			const file = `historical-read-${index}.txt`;
			train(`historical-read-${index}`, `seed-${index}`, "read", { path: file }, 120, [file]);
		}

		const result = await runAgent({
			cwd,
			sessionID: "tool-stratified-beam",
			tools: [...patternTools(cwd, 120, "notes.txt"), fallbackBash(cwd)],
			actorTurns: [
				turn(fauxToolCall("grep", { pattern: "TODO", path: "." })),
				turn([
					fauxThinking("inspect the matching file before continuing ".repeat(4)),
					fauxToolCall("read", { path: "notes.txt" }),
				]),
				turn("done"),
			],
			actorTokensPerSecond: 180,
			draftTurns: [],
			settings: {
				...patternAwareSettings(patternSettings),
				maxConcurrentActions: 1,
				tools: ["grep", "read", "bash"],
			},
			patternStore: store,
		});

		expect(result.summary).toMatchObject({ actorActions: 2, speculativeHits: 1, actorFallbacks: 1 });
		expect(result.executions).toEqual({ grep: 1, read: 1 });
		expect(result.summary.executionAheadMs).toBeGreaterThanOrEqual(100);
		expect(result.toolLatencyMs.at(-1)).toBeLessThan(40);
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
	readonly prompt?: string;
	readonly tools: readonly AgentTool[];
	readonly actorTurns: readonly ScriptedTurn[];
	readonly actorTokensPerSecond: number;
	readonly draftTurns: readonly ScriptedTurn[];
	readonly draftResponses?: readonly FauxResponseStep[];
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
	drafter.setResponses(input.draftResponses ? [...input.draftResponses] : scriptedResponses(input.draftTurns));
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
	const prompt: AgentMessage = {
		role: "user",
		content: input.prompt ?? "Fix the reported issue by inspecting the relevant files.",
		timestamp: Date.now(),
	};
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
						messages: standardMessages(
							turnSequence === 1 ? [...agent.state.messages, prompt] : agent.state.messages,
						),
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
		await agent.prompt(prompt);
		if (input.settings.enabled !== false) {
			await waitFor(
				() => events.filter((event) => event.type === "actor_action").length === toolLatencyMs.length,
				5_000,
			);
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

function delayedRead(cwd: string, durationMs: number | ((file: string) => number)): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: "Read a workspace file",
		parameters: readSchema,
		execute: async (_callID, args, signal) => {
			await delay(typeof durationMs === "number" ? durationMs : durationMs(args.path), signal);
			return textResult(await readFile(path.join(cwd, args.path), "utf8"));
		},
	};
}

function delayedStep(name: "find" | "ls", parameters: AgentTool["parameters"], durationMs: number): AgentTool {
	return {
		name,
		label: name,
		description: `Run ${name}`,
		parameters,
		execute: async (_callID, _args, signal) => {
			await delay(durationMs, signal);
			return textResult(name);
		},
	};
}

function fallbackBash(cwd: string): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description: "Execute a workspace command",
		parameters: bashSchema,
		execute: async () => {
			await writeFile(path.join(cwd, "generated.txt"), "actor", "utf8");
			return textResult("actor");
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
		tools: ["read"],
	};
}

type PatternTrainingStep = readonly [
	tool: string,
	input: Readonly<Record<string, unknown>>,
	durationMs: number,
	outputPaths?: ReadonlyArray<string>,
];

function patternStore(cwd: string, settings: PatternAwareSettings): PatternAwareStore {
	return new PatternAwareStore(settings, undefined, {
		namespace: "pi-action-semantics-v1",
		actionKey: (tool, input, schemaHash) => PI_ACTION_SEMANTICS.buildKey(tool, input, cwd, schemaHash),
		projectors: [],
	});
}

function trainPattern(store: PatternAwareStore, sessionID: string, steps: ReadonlyArray<PatternTrainingStep>): void {
	for (const [index, [tool, input, durationMs, outputPaths]] of steps.entries()) {
		store.observe({
			sessionID,
			turnID: `${sessionID}:${index}`,
			tool,
			input: structuredClone(input),
			...(outputPaths ? { outputPaths } : {}),
			outcome: "success",
			durationMs,
		});
	}
	store.finishSession(sessionID);
}

function patternAwareSettings(patternAware: PatternAwareSettings): SpeculativeAgentSettingsInput {
	return {
		enabled: true,
		drafterEnabled: false,
		candidateLimit: 1,
		maxConcurrentActions: 4,
		predictionTimeoutMs: 1_000,
		patternAware,
		tools: ["grep", "read"],
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
