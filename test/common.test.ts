import { describe, expect, it } from "vitest";
import {
	actionKeyMatches,
	actionLifetime,
	buildDrafterToolCallPrompt,
	buildPiActionKey,
	clampMaxCandidates,
	inferredExecution,
} from "../src/common.ts";
import { candidateToolNames } from "../src/runtime.ts";

describe("speculative action common", () => {
	it("builds a tool-call-only drafter prompt without embedding unrelated schemas", () => {
		const prompt = buildDrafterToolCallPrompt(
			[
				{ name: "read", description: "Read files" },
				{ name: "task", description: "Run a subagent" },
			],
			["read"],
			4,
		);

		expect(prompt).toContain("Dispatch tool calls only");
		expect(prompt).toContain("provider tool-call channel only");
		expect(prompt).toContain("Call 1 to 4");
		expect(prompt).not.toContain('"task"');
	});

	it("clamps candidate limits to the source range", () => {
		expect(clampMaxCandidates(0)).toBe(1);
		expect(clampMaxCandidates(4.9)).toBe(4);
		expect(clampMaxCandidates(100)).toBe(8);
		expect(clampMaxCandidates("4")).toBe(1);
	});

	it("assigns resource lifetime only to M1 read-only actions", () => {
		expect(actionLifetime("read")).toBe("resource");
		expect(actionLifetime("grep")).toBe("resource");
		expect(actionLifetime("find")).toBe("resource");
		expect(actionLifetime("bash")).toBe("turn");
	});

	it("canonicalizes Pi defaults and rejects paths outside the workspace", () => {
		const implicitRead = buildPiActionKey("read", { path: "README.md" }, "/workspace");
		const explicitRead = buildPiActionKey("read", { path: "README.md", offset: 1, limit: 2000 }, "/workspace");
		const implicitGrep = buildPiActionKey("grep", { pattern: "TODO" }, "/workspace");
		const explicitGrep = buildPiActionKey(
			"grep",
			{ pattern: "TODO", path: ".", ignoreCase: false, literal: false, context: 0, limit: 100 },
			"/workspace",
		);
		const implicitFind = buildPiActionKey("find", { pattern: "**/*.ts" }, "/workspace");
		const explicitFind = buildPiActionKey("find", { pattern: "**/*.ts", path: ".", limit: 1000 }, "/workspace");

		expect(implicitRead?.key).toBe(explicitRead?.key);
		expect(implicitGrep?.key).toBe(explicitGrep?.key);
		expect(implicitFind?.key).toBe(explicitFind?.key);
		expect(buildPiActionKey("read", { path: "../secret" }, "/workspace")).toBeUndefined();
		expect(buildPiActionKey("find", { pattern: "**/*.ts", path: "/outside" }, "/workspace")).toBeUndefined();
	});

	it("builds stable, conflict-sensitive keys for Pi sandbox tools", () => {
		const bash = buildPiActionKey("bash", { command: "npm test", timeout: 30 }, "/workspace/a");
		const otherCwd = buildPiActionKey("bash", { command: "npm test", timeout: 30 }, "/workspace/b");
		const write = buildPiActionKey("write", { path: "src/out.ts", content: "one\n" }, "/workspace");
		const otherWrite = buildPiActionKey("write", { path: "src/out.ts", content: "two\n" }, "/workspace");
		const edit = buildPiActionKey(
			"edit",
			{ path: "src/out.ts", edits: [{ oldText: "one", newText: "two" }] },
			"/workspace",
		);
		const sameEdit = buildPiActionKey(
			"edit",
			{ path: "src/out.ts", edits: [{ newText: "two", oldText: "one" }] },
			"/workspace",
		);

		expect(bash).toMatchObject({ tool: "bash", execution: "sandbox", resources: ["/workspace/a"] });
		expect(bash?.key).not.toBe(otherCwd?.key);
		expect(write).toMatchObject({ tool: "write", execution: "sandbox", resources: ["src/out.ts"] });
		expect(write?.key).not.toBe(otherWrite?.key);
		expect(edit?.key).toBe(sameEdit?.key);
		expect(buildPiActionKey("write", { path: "../outside", content: "no" }, "/workspace")).toBeUndefined();
		expect(buildPiActionKey("edit", { path: "file", edits: [] }, "/workspace")).toBeUndefined();
	});

	it("selects configured readonly and sandbox candidates independently", () => {
		expect(
			candidateToolNames({
				enabled: true,
				mode: "predict_action_single_step",
				maxCandidates: 4,
				resourceCacheMaxEntries: 8,
				predictionTimeoutMs: 100,
				tools: { liveReadonly: ["read"], sandbox: ["bash", "write"] },
			}),
		).toEqual(["read", "bash", "write"]);
		expect(inferredExecution("read")).toBe("live_readonly");
		expect(inferredExecution("edit")).toBe("sandbox");
	});

	it("matches a containing speculative read but not an uncovered range", () => {
		const speculative = buildPiActionKey("read", { path: "src/runtime.ts", offset: 100, limit: 160 }, "/workspace");
		const contained = buildPiActionKey("read", { path: "src/runtime.ts", offset: 220, limit: 30 }, "/workspace");
		const uncovered = buildPiActionKey("read", { path: "src/runtime.ts", offset: 80, limit: 30 }, "/workspace");

		expect(speculative && contained ? actionKeyMatches(speculative, contained) : false).toBe(true);
		expect(speculative && uncovered ? actionKeyMatches(speculative, uncovered) : true).toBe(false);
	});
});
