import { describe, expect, it } from "vitest";
import {
	actionKeyMatches,
	actionLifetime,
	buildDrafterToolCallPrompt,
	buildPiActionKey,
	clampMaxCandidates,
} from "../src/common.ts";

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

	it("matches a containing speculative read but not an uncovered range", () => {
		const speculative = buildPiActionKey("read", { path: "src/runtime.ts", offset: 100, limit: 160 }, "/workspace");
		const contained = buildPiActionKey("read", { path: "src/runtime.ts", offset: 220, limit: 30 }, "/workspace");
		const uncovered = buildPiActionKey("read", { path: "src/runtime.ts", offset: 80, limit: 30 }, "/workspace");

		expect(speculative && contained ? actionKeyMatches(speculative, contained) : false).toBe(true);
		expect(speculative && uncovered ? actionKeyMatches(speculative, uncovered) : true).toBe(false);
	});
});
