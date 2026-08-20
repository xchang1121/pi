import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_RANGE_COVERAGE_DETAILS_KEY } from "../src/action-key-projection.ts";
import { createSpeculativeActionHost, patternPlanActionID } from "../src/agent-integration.ts";
import { PATTERN_AWARE_DEFAULTS, PatternAwareStore } from "../src/pattern-aware.ts";
import { PI_READ_RANGE_PROJECTION_RULE } from "../src/pi-read-projection.ts";
import type { SpeculativeActionEvent } from "../src/runtime.ts";
import type { SpeculativeAgentSandbox } from "../src/workspace-sandbox.ts";

const roots: string[] = [];
const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});

function model(id = "actor"): Model<"openai-responses"> {
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

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
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

function drafterCall(input: Record<string, unknown>): AssistantMessage {
	return assistant([{ type: "toolCall", id: "draft-1", name: "read", arguments: input }], "toolUse");
}

function settings(candidateLimit = 1) {
	return {
		enabled: true,
		drafterEnabled: true,
		candidateLimit,
		drafterMaxDepth: 0,
		maxConcurrentActions: candidateLimit,
		tools: { resourceCached: ["read"], sandbox: [] },
		patternAware: { enabled: false },
	};
}

function startInput(tool: AgentTool, turnID = "turn-1") {
	return {
		turnID,
		actorModel: model("actor"),
		context: { systemPrompt: "system", messages: [], tools: [tool] },
		actorOptions: undefined,
		tools: [tool],
	};
}

async function temporaryWorkspace(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-host-"));
	roots.push(root);
	await writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree\nfour", "utf8");
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("speculative action host", () => {
	it("satisfies an actor call without modifying or wrapping an Agent instance", async () => {
		const cwd = await temporaryWorkspace();
		let executions = 0;
		const events: SpeculativeActionEvent<string>[] = [];
		const tool: AgentTool<typeof readSchema> = {
			name: "read",
			label: "read",
			description: "read",
			parameters: readSchema,
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "one\ntwo\nthree\nfour" }], details: {} };
			},
		};
		const host = createSpeculativeActionHost("session", {
			cwd,
			getSettings: settings,
			draftModel: model("draft"),
			complete: async () => drafterCall({ path: "notes.txt" }),
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});

		await host.startTurn(startInput(tool));
		await waitFor(() => events.some((event) => event.type === "candidate" && event.state.status === "succeeded"));
		const hit = await host.consume({
			turnID: "turn-1",
			id: "actor-1",
			tool: "read",
			args: { path: "notes.txt" },
			tools: [tool],
		});

		expect(hit?.result.content).toEqual([{ type: "text", text: "one\ntwo\nthree\nfour" }]);
		expect(executions).toBe(1);
		await waitFor(() =>
			events.some((event) => event.type === "actor_action" && event.settlement.provider.kind === "speculative"),
		);
		await host.dispose();
	});

	it("projects a wider read result only when its realized coverage proves containment", async () => {
		const cwd = await temporaryWorkspace();
		let executedInput: { path: string; offset?: number; limit?: number } | undefined;
		const tool: AgentTool<typeof readSchema> = {
			name: "read",
			label: "read",
			description: "read",
			parameters: readSchema,
			execute: async (_id, input) => {
				executedInput = input;
				return {
					content: [{ type: "text", text: "one\ntwo\nthree\nfour" }],
					details: {
						[READ_RANGE_COVERAGE_DETAILS_KEY]: {
							kind: "text",
							startLine: 1,
							endLineExclusive: 5,
							totalLines: 4,
							payloadTextLength: 18,
							maxLines: 2000,
							maxBytes: 50 * 1024,
						},
					},
				};
			},
		};
		const host = createSpeculativeActionHost("session", {
			cwd,
			getSettings: settings,
			draftModel: model("draft"),
			complete: async () => drafterCall({ path: "notes.txt", offset: 1, limit: 1 }),
			preflight: () => true,
			projectionRules: [PI_READ_RANGE_PROJECTION_RULE],
		});

		await host.startTurn(startInput(tool));
		await waitFor(() => host.runtime.inspect("session").sharedCandidates === 1);
		const hit = await host.consume({
			turnID: "turn-1",
			tool: "read",
			args: { path: "notes.txt", offset: 2, limit: 2 },
			tools: [tool],
		});

		expect(hit?.result.content[0]).toEqual({
			type: "text",
			text: "two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]",
		});
		expect(executedInput).toMatchObject({ offset: 1, limit: 2000 });
		await host.dispose();
	});

	it("reports authoritative misses and keeps cleanup failures out of actor lifecycle", async () => {
		const cwd = await temporaryWorkspace();
		const patternStore = new PatternAwareStore({ ...PATTERN_AWARE_DEFAULTS, minOccurrences: 1 });
		const observed = vi.spyOn(patternStore, "observeBatch");
		const actualEvents: SpeculativeActionEvent<string>[] = [];
		let disposed = 0;
		const sandbox: SpeculativeAgentSandbox = {
			supports: () => false,
			fork: async () => {
				throw new Error("unused");
			},
			dispose: async () => {
				disposed++;
				throw new Error("cleanup failed");
			},
		};
		const tool: AgentTool<typeof readSchema> = {
			name: "read",
			label: "read",
			description: "read",
			parameters: readSchema,
			execute: async () => ({ content: [{ type: "text", text: "actor" }], details: {} }),
		};
		const host = createSpeculativeActionHost("session", {
			cwd,
			getSettings: () => ({
				...settings(),
				drafterEnabled: false,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, minOccurrences: 1 },
			}),
			patternStore,
			draftModel: model("draft"),
			complete: async () => assistant([{ type: "text", text: "no prediction" }], "stop"),
			preflight: () => true,
			sandbox,
			onEvent: (event) => {
				actualEvents.push(event);
			},
		});
		await host.startTurn(startInput(tool));
		await waitFor(() => actualEvents.filter((event) => event.type === "source_request").length === 1);
		expect(
			actualEvents
				.filter((event) => event.type === "source_request")
				.every((event) => event.request.settlement.status === "empty"),
		).toBe(true);
		expect(
			await host.consume({
				turnID: "turn-1",
				id: "actor",
				tool: "read",
				args: { path: "notes.txt" },
				tools: [tool],
			}),
		).toBeUndefined();
		await host.actual({
			turnID: "turn-1",
			id: "actor",
			tool: "read",
			args: { path: "notes.txt" },
			tools: [tool],
			durationMs: 12,
			output: { result: await tool.execute("actor", { path: "notes.txt" }), isError: false },
		});
		await host.finishTurn("turn-1");

		await waitFor(() =>
			actualEvents.some(
				(event) =>
					event.type === "actor_action" &&
					event.settlement.provider.kind === "actor" &&
					event.settlement.provider.durationMs === 12,
			),
		);
		expect(observed.mock.calls[0]?.[0][0]?.input).toEqual({ path: "notes.txt" });
		await expect(host.dispose()).resolves.toBeUndefined();
		expect(disposed).toBe(1);
	});

	it("runs independent single-action drafts concurrently and deduplicates them by K(a)", async () => {
		const cwd = await temporaryWorkspace();
		await Promise.all([
			writeFile(path.join(cwd, "other.txt"), "other", "utf8"),
			writeFile(path.join(cwd, "ignored.txt"), "ignored", "utf8"),
		]);
		const executed: string[] = [];
		const events: SpeculativeActionEvent<string>[] = [];
		const requests: Array<{ context: Parameters<CreateComplete>[1]; options: Parameters<CreateComplete>[2] }> = [];
		let releaseSlowRequest: ((message: AssistantMessage) => void) | undefined;
		const slowRequest = new Promise<AssistantMessage>((resolve) => {
			releaseSlowRequest = resolve;
		});
		let activeRequests = 0;
		let maxActiveRequests = 0;
		const getDraftOptions = vi.fn(() => ({
			temperature: 1,
			maxTokens: 2_048,
			reasoning: "high" as const,
			deferred: true,
		}));
		const complete: CreateComplete = async (_model, context, requestOptions) => {
			const index = requests.length;
			requests.push({ context, options: requestOptions });
			activeRequests++;
			maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
			await Promise.resolve();
			if (index === 6) {
				activeRequests--;
				throw new Error("one sample failed");
			}
			if (index === 7) {
				const result = await slowRequest;
				activeRequests--;
				return result;
			}
			activeRequests--;
			const selected = index % 2 === 0 ? "notes.txt" : "other.txt";
			return assistant(
				[
					{ type: "toolCall", id: `selected-${index}`, name: "read", arguments: { path: selected } },
					{ type: "toolCall", id: `ignored-${index}`, name: "read", arguments: { path: "ignored.txt" } },
				],
				"toolUse",
			);
		};
		const tool: AgentTool<typeof readSchema> = {
			name: "read",
			label: "read",
			description: "read",
			parameters: readSchema,
			execute: async (_id, args) => {
				executed.push(args.path);
				return { content: [{ type: "text", text: args.path }], details: {} };
			},
		};
		const host = createSpeculativeActionHost("session", {
			cwd,
			getSettings: () => settings(8),
			draftModel: model("draft"),
			getDraftOptions,
			complete,
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});

		await host.startTurn(startInput(tool));
		await waitFor(
			() => events.filter((event) => event.type === "candidate" && event.state.status === "succeeded").length === 2,
		);
		expect(host.runtime.inspect("session").pendingPredictions).toBe(1);
		releaseSlowRequest?.(assistant([{ type: "text", text: "no tool needed" }], "stop"));
		await waitFor(() => !host.runtime.inspect("session").pendingPredictions);

		expect(requests).toHaveLength(8);
		expect(maxActiveRequests).toBe(8);
		expect(getDraftOptions).toHaveBeenCalledTimes(1);
		expect(new Set(requests.map((request) => request.options?.sessionId))).toEqual(new Set(["session:draft:turn-1"]));
		expect(requests.every((request) => request.context === requests[0]!.context)).toBe(true);
		expect(requests.map((request) => request.options?.temperature)).toEqual([0, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7]);
		for (const request of requests) {
			expect(request.context.systemPrompt).toContain("Continue the conversation as the assistant");
			expect(request.context.systemPrompt).not.toMatch(/drafter|predict|speculat|likely next/i);
			expect(request.context.tools?.map((candidate) => candidate.name)).toEqual(["read"]);
			expect(request.options).toMatchObject({
				maxTokens: 128,
				reasoning: undefined,
				deferred: false,
				cacheRetention: "short",
			});
		}
		expect(executed.sort()).toEqual(["notes.txt", "other.txt"]);
		await waitFor(
			() => events.filter((event) => event.type === "candidate" && event.state.status === "running").length === 2,
		);
		await host.dispose();
	});

	it("rolls one Drafter trajectory forward with authoritative tool results and a hard depth bound", async () => {
		const cwd = await temporaryWorkspace();
		await Promise.all([
			writeFile(path.join(cwd, "other.txt"), "other", "utf8"),
			writeFile(path.join(cwd, "third.txt"), "third", "utf8"),
			writeFile(path.join(cwd, "ignored.txt"), "ignored", "utf8"),
		]);
		const requests: Array<{ context: Parameters<CreateComplete>[1]; options: Parameters<CreateComplete>[2] }> = [];
		const executed: string[] = [];
		const complete: CreateComplete = async (_model, context, requestOptions) => {
			requests.push({ context, options: requestOptions });
			const depth = context.messages.filter((message) => message.role === "toolResult").length;
			if (depth === 0) {
				return assistant(
					[
						{ type: "toolCall", id: "draft-0", name: "read", arguments: { path: "notes.txt" } },
						{ type: "toolCall", id: "ignored", name: "read", arguments: { path: "ignored.txt" } },
					],
					"toolUse",
				);
			}
			if (depth === 1) {
				return assistant(
					[{ type: "toolCall", id: "draft-1", name: "read", arguments: { path: "other.txt" } }],
					"toolUse",
				);
			}
			return assistant(
				[{ type: "toolCall", id: "draft-2", name: "read", arguments: { path: "third.txt" } }],
				"toolUse",
			);
		};
		const tool: AgentTool<typeof readSchema> = {
			name: "read",
			label: "read",
			description: "read",
			parameters: readSchema,
			execute: async (_id, args) => {
				executed.push(args.path);
				return { content: [{ type: "text", text: `${args.path}:result` }], details: { path: args.path } };
			},
		};
		let currentSettings = { ...settings(1), drafterMaxDepth: 2 };
		const host = createSpeculativeActionHost("session", {
			cwd,
			getSettings: () => currentSettings,
			draftModel: model("draft"),
			complete,
			preflight: () => true,
		});

		await host.startTurn(startInput(tool));
		await waitFor(() => executed.length === 1);
		for (const [index, file] of ["notes.txt", "other.txt", "third.txt"].entries()) {
			const turnID = `turn-${index + 1}`;
			if (index > 0) await host.startTurn(startInput(tool, turnID));
			expect(
				await host.consume({
					turnID,
					id: `actor-${index}`,
					tool: "read",
					args: { path: file },
					tools: [tool],
				}),
			).toMatchObject({ result: { content: [{ type: "text", text: `${file}:result` }] } });
			if (index < 2) {
				await waitFor(() => executed.length === index + 2);
				await host.finishTurn(turnID);
				currentSettings = { ...currentSettings, drafterEnabled: false };
			}
		}
		expect(executed).toEqual(["notes.txt", "other.txt", "third.txt"]);
		expect(requests).toHaveLength(3);
		const replayedAssistant = requests[1]!.context.messages.at(-2);
		expect(replayedAssistant).toMatchObject({ role: "assistant" });
		expect(
			replayedAssistant?.role === "assistant"
				? replayedAssistant.content.filter((item) => item.type === "toolCall").map((item) => item.id)
				: [],
		).toEqual(["draft-0"]);
		expect(requests[1]!.context.messages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "draft-0",
			toolName: "read",
			content: [{ type: "text", text: "notes.txt:result" }],
			isError: false,
		});
		expect(requests[2]!.context.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		await host.dispose();
	});

	it("uses the actor model by default and permits it as the explicit Drafter model", async () => {
		const cwd = await temporaryWorkspace();
		const usedModels: string[] = [];
		const complete: CreateComplete = async (usedModel) => {
			usedModels.push(`${usedModel.provider}/${usedModel.id}`);
			return assistant([{ type: "text", text: "no tool needed" }], "stop");
		};
		const tool: AgentTool<typeof readSchema> = {
			name: "read",
			label: "read",
			description: "read",
			parameters: readSchema,
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
		};

		for (const draftModel of [undefined, model("actor")]) {
			const expectedRequests = usedModels.length + 1;
			const host = createSpeculativeActionHost("session", {
				cwd,
				getSettings: settings,
				...(draftModel ? { draftModel } : {}),
				complete,
				preflight: () => true,
			});
			await host.startTurn(startInput(tool));
			await waitFor(() => usedModels.length === expectedRequests);
			await waitFor(() => !host.runtime.inspect("session").pendingPredictions);
			await host.dispose();
		}

		expect(usedModels).toEqual(["openai/actor", "openai/actor"]);
	});

	it("names equal actions under different parent paths independently", () => {
		const left = patternPlanActionID("shared", patternPlanActionID("left"));
		const right = patternPlanActionID("shared", patternPlanActionID("right"));
		expect(left).not.toBe(right);
	});
});

type CreateComplete = NonNullable<Parameters<typeof createSpeculativeActionHost>[1]["complete"]>;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for speculative runtime");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
