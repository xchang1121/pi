import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { READ_RANGE_COVERAGE_DETAILS_KEY } from "../src/action-key-projection.ts";
import { createSpeculativeActionHost, patternPlanActionID } from "../src/agent-integration.ts";
import { PI_READ_RANGE_PROJECTION_RULE } from "../src/pi-read-projection.ts";
import type { SpeculativeActionEvent } from "../src/runtime.ts";
import type { SpeculativeAgentSandbox } from "../src/workspace-sandbox.ts";

const roots: string[] = [];
const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});

function model(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
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

function settings() {
	return {
		enabled: true,
		drafterEnabled: true,
		adaptiveDrafter: false,
		candidateLimit: 1,
		maxConcurrentActions: 1,
		tools: { resourceCached: ["read"], sandbox: [] },
		patternAware: { enabled: false },
	};
}

function startInput(tool: AgentTool) {
	return {
		turnID: "turn-1",
		actorModel: model(),
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
			complete: async () => drafterCall({ path: "notes.txt" }),
			preflight: () => true,
			onEvent: (event) => {
				events.push(event);
			},
		});

		await host.startTurn(startInput(tool));
		await waitFor(() => events.some((event) => event.type === "completed"));
		const hit = await host.consume({
			turnID: "turn-1",
			id: "actor-1",
			tool: "read",
			args: { path: "notes.txt" },
			tools: [tool],
		});

		expect(hit?.result.content).toEqual([{ type: "text", text: "one\ntwo\nthree\nfour" }]);
		expect(executions).toBe(1);
		expect(events.some((event) => event.type === "hit")).toBe(true);
		await host.dispose();
	});

	it("projects a wider read result only when its realized coverage proves containment", async () => {
		const cwd = await temporaryWorkspace();
		const tool: AgentTool<typeof readSchema> = {
			name: "read",
			label: "read",
			description: "read",
			parameters: readSchema,
			execute: async () => ({
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
			}),
		};
		const host = createSpeculativeActionHost("session", {
			cwd,
			getSettings: settings,
			complete: async () => drafterCall({ path: "notes.txt", offset: 1, limit: 4 }),
			preflight: () => true,
			projectionRules: [PI_READ_RANGE_PROJECTION_RULE],
		});

		await host.startTurn(startInput(tool));
		await waitFor(() => host.runtime.inspect("session").resourceCandidates === 1);
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
		await host.dispose();
	});

	it("reports authoritative misses and keeps cleanup failures out of actor lifecycle", async () => {
		const cwd = await temporaryWorkspace();
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
			getSettings: settings,
			complete: async () => assistant([{ type: "text", text: "no prediction" }], "stop"),
			preflight: () => true,
			sandbox,
			onEvent: (event) => {
				actualEvents.push(event);
			},
		});
		await host.startTurn(startInput(tool));
		await host.actual({
			turnID: "turn-1",
			tool: "read",
			args: { path: "notes.txt" },
			tools: [tool],
			durationMs: 12,
			output: { result: await tool.execute("actor", { path: "notes.txt" }), isError: false },
		});

		expect(actualEvents.some((event) => event.type === "actual" && event.actualDurationMs === 12)).toBe(true);
		await expect(host.dispose()).resolves.toBeUndefined();
		expect(disposed).toBe(1);
	});

	it("names equal actions under different parent paths independently", () => {
		const left = patternPlanActionID("shared", patternPlanActionID("left"));
		const right = patternPlanActionID("shared", patternPlanActionID("right"));
		expect(left).not.toBe(right);
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for speculative runtime");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
