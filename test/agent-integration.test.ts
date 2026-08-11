import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { READ_RANGE_COVERAGE_DETAILS_KEY, type ReadRangeCoverage } from "../src/action-key-projection.ts";
import { installSpeculativeAction, type SpeculativeAgentSettingsInput } from "../src/agent-integration.ts";
import { PATTERN_AWARE_DEFAULTS, type PatternAwareEventInput, PatternAwareStore } from "../src/pattern-aware.ts";
import { PI_READ_RANGE_PROJECTION_RULE } from "../src/pi-read-projection.ts";
import type { SpeculativeActionEvent } from "../src/runtime.ts";
import { createWorkspaceSandbox, type SpeculativeAgentSandbox } from "../src/workspace-sandbox.ts";

const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});

type ReadTool = AgentTool<typeof readSchema, { source: string }>;

interface ProjectionReadDetails {
	readonly source: string;
	readonly [READ_RANGE_COVERAGE_DETAILS_KEY]: ReadRangeCoverage;
}

type ProjectionReadTool = AgentTool<typeof readSchema, ProjectionReadDetails>;

const reorderedReadSchema = Type.Object({
	limit: Type.Optional(Type.Number()),
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
});
type ReorderedReadTool = AgentTool<typeof reorderedReadSchema, { source: string }>;

const changedReadSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
	encoding: Type.Optional(Type.String()),
});
type ChangedReadTool = AgentTool<typeof changedReadSchema, { source: string }>;

const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
type WriteTool = AgentTool<typeof writeSchema, { target: string }>;

const findSchema = Type.Object({ pattern: Type.String() });
type FindTool = AgentTool<typeof findSchema, undefined>;

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(id = "mock"): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createStreamHarness(
	options: {
		readonly draftMode?: "tool" | "text" | "error";
		readonly draftOnlyFirst?: boolean;
		readonly toolName?: string;
		readonly toolArgs?: Record<string, unknown>;
		readonly draftToolArgs?: Record<string, unknown>;
		readonly actorDelayMs?: number;
	} = {},
) {
	let actorRequests = 0;
	let draftRequests = 0;
	const draftModels: string[] = [];
	const draftOptions: (SimpleStreamOptions | undefined)[] = [];
	const stream = (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions): MockAssistantStream => {
		const response = new MockAssistantStream();
		const isDraft = context.systemPrompt?.includes("Dispatch tool calls only") === true;
		if (isDraft) {
			draftRequests++;
			draftModels.push(model.id);
			draftOptions.push(streamOptions);
		}
		const publish = () => {
			if (isDraft) {
				if (options.draftOnlyFirst && draftRequests > 1) {
					const message = assistantMessage([{ type: "text", text: "No second candidate" }], "stop");
					response.push({ type: "done", reason: "stop", message });
					return;
				}
				if (options.draftMode === "text") {
					const message = assistantMessage([{ type: "text", text: "No tool call" }], "stop");
					response.push({ type: "done", reason: "stop", message });
					return;
				}
				if (options.draftMode === "error") {
					const error = {
						...assistantMessage([{ type: "text", text: "Drafter failed" }], "error"),
						errorMessage: "Drafter failed",
					};
					response.push({ type: "error", reason: "error", error });
					return;
				}
				const message = assistantMessage(
					[
						{
							type: "toolCall",
							id: `draft-${draftRequests}`,
							name: options.toolName ?? "read",
							arguments: options.draftToolArgs ?? options.toolArgs ?? { path: "README.md" },
						},
					],
					"toolUse",
				);
				response.push({ type: "done", reason: "toolUse", message });
				return;
			}

			actorRequests++;
			const message =
				actorRequests === 1
					? assistantMessage(
							[
								{
									type: "toolCall",
									id: "actor-1",
									name: options.toolName ?? "read",
									arguments: options.toolArgs ?? { path: "README.md" },
								},
							],
							"toolUse",
						)
					: assistantMessage([{ type: "text", text: "done" }], "stop");
			response.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		};
		if (!isDraft && options.actorDelayMs) setTimeout(publish, options.actorDelayMs);
		else queueMicrotask(publish);
		return response;
	};
	return {
		stream,
		actorRequests: () => actorRequests,
		draftRequests: () => draftRequests,
		draftModels: () => draftModels,
		draftOptions: () => draftOptions,
	};
}

describe("Pi Agent speculative integration", () => {
	it("disposes sandbox resources without changing uninstall semantics", async () => {
		let disposeCalls = 0;
		const sandbox: SpeculativeAgentSandbox = {
			supports: () => false,
			execute: async () => {
				throw new Error("unused sandbox");
			},
			adopt: async (execution) => execution.output,
			dispose: async () => {
				disposeCalls++;
				throw new Error("simulated cleanup failure");
			},
		};
		const streams = createStreamHarness();
		const agent = new Agent({ initialState: { model: createModel(), tools: [] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			sandbox,
			getSettings: () => ({ enabled: false }),
		});

		await expect(installed.uninstall()).resolves.toBeUndefined();
		expect(disposeCalls).toBe(1);
	});

	it("runs the drafter beside the actor and settles the real call from one pre-execution", async () => {
		const execution = deferred<void>();
		let toolExecutions = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				toolExecutions++;
				await execution.promise;
				return { content: [{ type: "text", text: "prefetched README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness({ actorDelayMs: 100 });
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: "Act as a coding agent", tools: [tool] },
			streamFn: streams.stream,
		});
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({
				enabled: true,
				predictionTimeoutMs: 1000,
				patternAware: { enabled: false },
				tools: { liveReadonly: ["read"] },
			}),
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});

		const prompt = agent.prompt("Read README.md");
		await waitFor(() => toolExecutions === 1);
		execution.resolve();
		await prompt;

		expect(toolExecutions).toBe(1);
		expect(streams.actorRequests()).toBe(2);
		expect(streams.draftRequests()).toBe(2);
		expect(events.some((event) => event.type === "hit" && event.tool === "read")).toBe(true);
		expect(events.some((event) => event.type === "actual")).toBe(false);
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" ? result.content : undefined).toEqual([
			{ type: "text", text: "prefetched README" },
		]);
		await installed.uninstall();
	});

	it("keeps a speculative hit when a live tool is replaced by a schema-equivalent definition", async () => {
		let speculativeExecutions = 0;
		let replacementExecutions = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const original: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				speculativeExecutions++;
				return { content: [{ type: "text", text: "cached README" }], details: { source: "original" } };
			},
		};
		const replacement: ReorderedReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: reorderedReadSchema,
			async execute() {
				replacementExecutions++;
				return { content: [{ type: "text", text: "replacement README" }], details: { source: "replacement" } };
			},
		};
		const streams = createStreamHarness({ actorDelayMs: 100, draftOnlyFirst: true });
		const agent = new Agent({ initialState: { model: createModel(), tools: [original] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({
				enabled: true,
				patternAware: { enabled: false },
				tools: { resourceCached: ["read"] },
			}),
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});

		const prompt = agent.prompt("Read README.md");
		await waitFor(() => speculativeExecutions === 1);
		agent.state.tools = [replacement];
		await prompt;

		expect(speculativeExecutions).toBe(1);
		expect(replacementExecutions).toBe(0);
		expect(events.some((event) => event.type === "hit" && event.tool === "read")).toBe(true);
		expect(events.some((event) => event.type === "actual")).toBe(false);
		await installed.uninstall();
	});

	it("rejects a cached result when a live tool schema changes before the actor call", async () => {
		let originalToolExecutions = 0;
		let replacementToolExecutions = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const original: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				originalToolExecutions++;
				return { content: [{ type: "text", text: "stale schema result" }], details: { source: "original" } };
			},
		};
		const replacement: ChangedReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file with encoding",
			parameters: changedReadSchema,
			async execute() {
				replacementToolExecutions++;
				return { content: [{ type: "text", text: "current schema result" }], details: { source: "replacement" } };
			},
		};
		const streams = createStreamHarness({ actorDelayMs: 100, draftOnlyFirst: true });
		const agent = new Agent({ initialState: { model: createModel(), tools: [original] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({
				enabled: true,
				patternAware: { enabled: false },
				tools: { resourceCached: ["read"] },
			}),
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});

		const prompt = agent.prompt("Read README.md");
		await waitFor(() => originalToolExecutions === 1);
		agent.state.tools = [replacement];
		await prompt;

		// The normal Agent loop snapshots tools at prompt start, so rejecting the
		// speculative entry falls back to that authoritative snapshot. The replacement
		// only changes the live schema used to decide whether reuse is still safe.
		expect(originalToolExecutions).toBe(2);
		expect(replacementToolExecutions).toBe(0);
		expect(events.some((event) => event.type === "hit")).toBe(false);
		expect(events.some((event) => event.type === "actual" && event.tool === "read")).toBe(true);
		expect(events.some((event) => event.type === "miss" && event.reason === "key_mismatch")).toBe(true);
		await installed.uninstall();
	});

	it("projects a broad production read into the actor's exact narrow result", async () => {
		let toolExecutions = 0;
		const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`);
		const tool: ProjectionReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				toolExecutions++;
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						source: "tool",
						[READ_RANGE_COVERAGE_DETAILS_KEY]: {
							kind: "text",
							startLine: 1,
							endLineExclusive: 11,
							totalLines: 10,
							lines,
							maxLines: 2000,
							maxBytes: 50 * 1024,
							complete: true,
						},
					},
				};
			},
		};
		const streams = createStreamHarness({
			actorDelayMs: 100,
			draftOnlyFirst: true,
			draftToolArgs: { path: "README.md", offset: 1, limit: 10 },
			toolArgs: { path: "README.md", offset: 3, limit: 2 },
		});
		const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({
				enabled: true,
				predictionTimeoutMs: 1000,
				patternAware: { enabled: false },
				tools: { liveReadonly: ["read"] },
			}),
			preflight: () => true,
			projectionRules: [PI_READ_RANGE_PROJECTION_RULE],
		});

		await agent.prompt("Read lines 3-4 of README.md");

		expect(toolExecutions).toBe(1);
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" ? result.content : undefined).toEqual([
			{ type: "text", text: "line-3\nline-4\n\n[6 more lines in file. Use offset=5 to continue.]" },
		]);
		await installed.uninstall();
	});

	it("makes no drafter request when disabled and preserves normal execution", async () => {
		let toolExecutions = 0;
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				toolExecutions++;
				return { content: [{ type: "text", text: "normal README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness();
		const agent = new Agent({
			initialState: { model: createModel(), tools: [tool] },
			streamFn: streams.stream,
		});
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({ enabled: false }),
		});

		await agent.prompt("Read README.md");

		expect(toolExecutions).toBe(1);
		expect(streams.actorRequests()).toBe(2);
		expect(streams.draftRequests()).toBe(0);
		expect(installed.runtime.inspect()).toEqual({
			activeTurns: 0,
			turnCandidates: 0,
			resourceCandidates: 0,
			pendingPredictions: 0,
		});
		await installed.uninstall();
	});

	it("fails closed without speculative preflight and uses the normal tool path", async () => {
		let toolExecutions = 0;
		let previousActualCalls = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				toolExecutions++;
				return { content: [{ type: "text", text: "normal README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness();
		const agent = new Agent({
			initialState: { model: createModel(), tools: [tool] },
			streamFn: streams.stream,
			actualToolCall: async () => {
				previousActualCalls++;
			},
		});
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 100, tools: { resourceCached: ["read"] } }),
			onEvent: (event) => {
				events.push(event);
			},
		});

		await agent.prompt("Read README.md");

		expect(toolExecutions).toBe(1);
		expect(streams.draftRequests()).toBe(2);
		expect(previousActualCalls).toBe(1);
		expect(events.some((event) => event.type === "hit")).toBe(false);
		expect(events.find((event) => event.type === "actual")).toMatchObject({
			type: "actual",
			tool: "read",
			execution: "resource_cached",
			actualDurationMs: expect.any(Number),
			actualAction: expect.any(String),
		});
		await installed.uninstall();
	});

	it("uses the configured drafter model and request options", async () => {
		let toolExecutions = 0;
		let optionCalls = 0;
		const actorModel = createModel("actor");
		const draftModel = createModel("drafter");
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				toolExecutions++;
				return { content: [{ type: "text", text: "draft-model README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness();
		const agent = new Agent({ initialState: { model: actorModel, tools: [tool] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 100, tools: { resourceCached: ["read"] } }),
			draftModel,
			getDraftOptions: (context) => {
				optionCalls++;
				expect(context.actorModel.id).toBe("actor");
				expect(context.draftModel.id).toBe("drafter");
				return { signal: context.signal, sessionId: "draft-options", temperature: 0 };
			},
			preflight: () => true,
		});

		await agent.prompt("Read README.md");

		expect(toolExecutions).toBe(1);
		expect(optionCalls).toBe(2);
		expect(streams.draftModels()).toEqual(["drafter", "drafter"]);
		expect(streams.draftOptions().map((options) => options?.sessionId)).toEqual(["draft-options", "draft-options"]);
		await installed.uninstall();
	});

	it("treats a non-tool drafter response as no candidate and preserves normal execution", async () => {
		let toolExecutions = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				toolExecutions++;
				return { content: [{ type: "text", text: "normal README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness({ draftMode: "text" });
		const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 100, tools: { resourceCached: ["read"] } }),
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});

		await agent.prompt("Read README.md");

		expect(toolExecutions).toBe(1);
		expect(events.some((event) => event.type === "miss" && event.reason === "no_candidate")).toBe(true);
		expect(events.some((event) => event.type === "hit")).toBe(false);
		await installed.uninstall();
	});

	it("isolates a drafter error and preserves normal execution", async () => {
		let toolExecutions = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				toolExecutions++;
				return { content: [{ type: "text", text: "normal README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness({ draftMode: "error" });
		const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 100, tools: { resourceCached: ["read"] } }),
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});

		await agent.prompt("Read README.md");

		expect(toolExecutions).toBe(1);
		expect(events.some((event) => event.type === "miss" && event.reason === "drafter_error")).toBe(true);
		expect(events.some((event) => event.type === "hit")).toBe(false);
		await installed.uninstall();
	});

	it("adopts a staged write through the Agent settlement path without executing against the real path first", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-agent-spec-write-"));
		try {
			let executions = 0;
			const preparedTools: string[][] = [];
			const tool: WriteTool = {
				name: "write",
				label: "Write",
				description: "Write a file",
				parameters: writeSchema,
				async execute(_callID, args) {
					executions++;
					await mkdir(path.dirname(path.resolve(root, args.path)), { recursive: true });
					await writeFile(path.resolve(root, args.path), args.content, "utf8");
					return {
						content: [{ type: "text", text: `wrote ${args.path}` }],
						details: { target: args.path },
					};
				},
			};
			const args = { path: "created.txt", content: "from speculation\n" };
			const streams = createStreamHarness({
				toolName: "write",
				toolArgs: args,
				draftOnlyFirst: true,
				actorDelayMs: 100,
			});
			const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
			const baseSandbox = createWorkspaceSandbox();
			const sandbox = {
				...baseSandbox,
				prepare: async (input: Parameters<NonNullable<typeof baseSandbox.prepare>>[0]) => {
					preparedTools.push([...input.tools]);
					await baseSandbox.prepare?.(input);
				},
			};
			const installed = installSpeculativeAction(agent, {
				cwd: root,
				getSettings: () => ({
					enabled: true,
					patternAware: { enabled: false },
					tools: { resourceCached: [], sandbox: ["write"] },
				}),
				preflight: () => true,
				sandbox,
			});

			await agent.prompt("Create the file");

			expect(executions).toBe(1);
			expect(preparedTools.some((tools) => tools.includes("write"))).toBe(true);
			expect(await readFile(path.join(root, "created.txt"), "utf8")).toBe("from speculation\n");
			const result = agent.state.messages.find((message) => message.role === "toolResult");
			expect(result?.role === "toolResult" ? result.content : undefined).toEqual([
				{ type: "text", text: "wrote created.txt" },
			]);
			await installed.uninstall();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to the real write when sandbox adoption detects a base conflict", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-agent-spec-conflict-"));
		try {
			const staged = deferred<void>();
			let executions = 0;
			const tool: WriteTool = {
				name: "write",
				label: "Write",
				description: "Write a file",
				parameters: writeSchema,
				async execute(_callID, args) {
					executions++;
					if (path.isAbsolute(args.path)) await staged.promise;
					await mkdir(path.dirname(path.resolve(root, args.path)), { recursive: true });
					await writeFile(path.resolve(root, args.path), args.content, "utf8");
					return { content: [{ type: "text", text: `wrote ${args.path}` }], details: { target: args.path } };
				},
			};
			const args = { path: "conflict.txt", content: "actor result\n" };
			const streams = createStreamHarness({
				toolName: "write",
				toolArgs: args,
				draftOnlyFirst: true,
				actorDelayMs: 100,
			});
			const events: SpeculativeActionEvent<string>[] = [];
			const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
			const installed = installSpeculativeAction(agent, {
				cwd: root,
				getSettings: () => ({
					enabled: true,
					patternAware: { enabled: false },
					tools: { resourceCached: [], sandbox: ["write"] },
				}),
				preflight: () => true,
				sandbox: createWorkspaceSandbox(),
				onEvent: (event) => {
					events.push(event);
				},
			});

			const prompt = agent.prompt("Create the file");
			await waitFor(() => executions === 1);
			await writeFile(path.join(root, "conflict.txt"), "concurrent change\n", "utf8");
			staged.resolve();
			await prompt;

			expect(executions).toBe(2);
			expect(await readFile(path.join(root, "conflict.txt"), "utf8")).toBe("actor result\n");
			expect(events.some((event) => event.type === "miss" && event.reason === "adoption_failed")).toBe(true);
			await installed.uninstall();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed for configured sandbox tools when the host capability is absent", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-agent-spec-no-sandbox-"));
		try {
			let executions = 0;
			const events: SpeculativeActionEvent<string>[] = [];
			const tool: WriteTool = {
				name: "write",
				label: "Write",
				description: "Write a file",
				parameters: writeSchema,
				async execute(_callID, args) {
					executions++;
					await writeFile(path.join(root, args.path), args.content, "utf8");
					return { content: [{ type: "text", text: "normal write" }], details: { target: args.path } };
				},
			};
			const args = { path: "normal.txt", content: "normal\n" };
			const streams = createStreamHarness({ toolName: "write", toolArgs: args, draftOnlyFirst: true });
			const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
			const installed = installSpeculativeAction(agent, {
				cwd: root,
				getSettings: () => ({ enabled: true, tools: { resourceCached: [], sandbox: ["write"] } }),
				preflight: () => true,
				onEvent: (event) => {
					events.push(event);
				},
			});

			await agent.prompt("Write normally");

			expect(executions).toBe(1);
			expect(events.some((event) => event.type === "hit")).toBe(false);
			await installed.uninstall();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed before preflight when the drafter emits schema-invalid arguments", async () => {
		const executedCallIDs: string[] = [];
		let preflightCalls = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute(callID) {
				executedCallIDs.push(callID);
				return { content: [{ type: "text", text: "normal README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness({
			toolArgs: { path: "README.md" },
			draftToolArgs: {},
			draftOnlyFirst: true,
		});
		const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({ enabled: true, tools: { resourceCached: ["read"] } }),
			preflight: () => {
				preflightCalls++;
				return true;
			},
			onEvent: (event) => {
				events.push(event);
			},
		});

		await agent.prompt("Read README.md");

		expect(executedCallIDs).toEqual(["actor-1"]);
		expect(preflightCalls).toBe(0);
		expect(events.some((event) => event.type === "miss" && event.reason === "unsupported_tool_or_input")).toBe(true);
		expect(events.some((event) => event.type === "hit")).toBe(false);
		await installed.uninstall();
	});

	it("treats an invalid enabled setting as disabled", async () => {
		let executions = 0;
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "normal README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness();
		const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
		const invalidSettings = { enabled: "true" } as unknown as SpeculativeAgentSettingsInput;
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => invalidSettings,
			preflight: () => true,
		});

		await agent.prompt("Read README.md");

		expect(executions).toBe(1);
		expect(streams.draftRequests()).toBe(0);
		await installed.uninstall();
	});

	it("records authoritative output paths and schema metadata in the PatternAware store", async () => {
		class RecordingStore extends PatternAwareStore {
			readonly observed: PatternAwareEventInput[] = [];
			readonly batches: ReadonlyArray<PatternAwareEventInput>[] = [];

			override observeBatch(
				inputs: ReadonlyArray<PatternAwareEventInput>,
				schemaHashes: Readonly<Record<string, string>> = {},
			) {
				this.batches.push(inputs);
				this.observed.push(...inputs);
				return super.observeBatch(inputs, schemaHashes);
			}
		}
		const store = new RecordingStore(PATTERN_AWARE_DEFAULTS);
		const tool: FindTool = {
			name: "find",
			label: "Find",
			description: "Find files",
			parameters: findSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
					details: undefined,
				};
			},
		};
		const streams = createStreamHarness({
			draftMode: "text",
			toolName: "find",
			toolArgs: { pattern: "src/*.ts" },
		});
		const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			patternStore: store,
			getSettings: () => ({ enabled: true, tools: { resourceCached: ["find"] } }),
			preflight: () => true,
		});

		await agent.prompt("Find TypeScript files");

		const event = store.observed.find((item) => item.tool === "find");
		expect(event).toMatchObject({
			tool: "find",
			input: { pattern: "src/*.ts" },
			outcome: "success",
			outputPaths: ["src/a.ts", "src/b.ts"],
			learnTarget: true,
		});
		expect(event?.schemaHash).toMatch(/^[a-f0-9]{32}$/);
		expect(store.batches).toHaveLength(1);
		expect(store.batches[0]?.map((item) => item.tool)).toEqual(["find"]);
		await installed.uninstall();
	});

	it("uses a learned PatternAware candidate while keeping drafter arbitration active", async () => {
		const store = new PatternAwareStore(PATTERN_AWARE_DEFAULTS);
		trainPattern(store, "one", "README.md");
		trainPattern(store, "two", "README.md");
		let executions = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const tool: ReadTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "README" }], details: { source: "tool" } };
			},
		};
		const streams = createStreamHarness({ draftMode: "text", actorDelayMs: 100 });
		const agent = new Agent({ initialState: { model: createModel(), tools: [tool] }, streamFn: streams.stream });
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			patternStore: store,
			getSettings: () => ({ enabled: true, tools: { resourceCached: ["read"] } }),
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});
		store.observe(patternInput(installed.sessionID, "grep", { pattern: "README" }, ["README.md"]));

		await agent.prompt("Read README.md");

		expect(executions).toBe(1);
		expect(streams.draftRequests()).toBe(2);
		expect(events).toContainEqual(expect.objectContaining({ type: "hit", source: "pattern_aware" }));
		await installed.uninstall();
	});
});

function trainPattern(store: PatternAwareStore, sessionID: string, path: string): void {
	store.observe(patternInput(sessionID, "grep", { pattern: "README" }, [path]));
	store.observeTurn({ sessionID, turnID: `${sessionID}:turn`, phase: "start", model: "openai/mock" });
	store.observe(patternInput(sessionID, "read", { path }));
}

function patternInput(
	sessionID: string,
	tool: string,
	input: Record<string, unknown>,
	outputPaths?: readonly string[],
): PatternAwareEventInput {
	return {
		sessionID,
		turnID: `${sessionID}:turn`,
		tool,
		input,
		actionKey: JSON.stringify({ tool, input }),
		outcome: "success",
		durationMs: 10,
		...(outputPaths ? { outputPaths } : {}),
	};
}

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
