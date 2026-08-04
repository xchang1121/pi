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
import { installSpeculativeAction } from "../src/agent-integration.ts";
import type { SpeculativeActionEvent } from "../src/runtime.ts";

const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});

type ReadTool = AgentTool<typeof readSchema, { source: string }>;

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

function createStreamHarness(options: { readonly draftMode?: "tool" | "text" | "error" } = {}) {
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
		queueMicrotask(() => {
			if (isDraft) {
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
					[{ type: "toolCall", id: `draft-${draftRequests}`, name: "read", arguments: { path: "README.md" } }],
					"toolUse",
				);
				response.push({ type: "done", reason: "toolUse", message });
				return;
			}

			actorRequests++;
			const message =
				actorRequests === 1
					? assistantMessage(
							[{ type: "toolCall", id: "actor-1", name: "read", arguments: { path: "README.md" } }],
							"toolUse",
						)
					: assistantMessage([{ type: "text", text: "done" }], "stop");
			response.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		});
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
		const streams = createStreamHarness();
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: "Act as a coding agent", tools: [tool] },
			streamFn: streams.stream,
		});
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 1000, tools: { liveReadonly: ["read"] } }),
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
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" ? result.content : undefined).toEqual([
			{ type: "text", text: "prefetched README" },
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
		});
		const installed = installSpeculativeAction(agent, {
			cwd: "/workspace",
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 100, tools: { liveReadonly: ["read"] } }),
			onEvent: (event) => {
				events.push(event);
			},
		});

		await agent.prompt("Read README.md");

		expect(toolExecutions).toBe(1);
		expect(streams.draftRequests()).toBe(2);
		expect(events.some((event) => event.type === "miss" && event.reason === "permission_or_policy")).toBe(true);
		expect(events.some((event) => event.type === "hit")).toBe(false);
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
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 100, tools: { liveReadonly: ["read"] } }),
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
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 100, tools: { liveReadonly: ["read"] } }),
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
			getSettings: () => ({ enabled: true, predictionTimeoutMs: 100, tools: { liveReadonly: ["read"] } }),
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
