import path from "node:path";
import { describe, expect, it } from "vitest";
import { READ_RANGE_ACTION_KEY_PROJECTOR } from "../src/action-key-projection.ts";
import {
	type ActionKeyProjector,
	actionKeyCovers,
	actionKeyMatch,
	actionKeyMatches,
	actionKeyMismatchReason,
	actionKeyProjectionPartitions,
	buildActionKey,
	buildPiActionKey,
	buildSingleToolCallPrompt,
	clampCandidateLimit,
	DEFAULTS,
	inferredExecution,
} from "../src/common.ts";
import { candidateToolNames } from "../src/runtime.ts";

describe("speculative action common", () => {
	it("keeps each draft in the actor role while requiring one tool call", () => {
		const prompt = buildSingleToolCallPrompt();

		expect(prompt).toContain("Continue the conversation as the assistant");
		expect(prompt).toContain("provider tool-call channel only");
		expect(prompt).toContain("exactly one tool call");
		expect(prompt).not.toMatch(/drafter|predict|speculat|likely next/i);
		expect(DEFAULTS.drafterEnabled).toBe(true);
	});

	it("clamps the per-turn candidate limit to the source range", () => {
		expect(clampCandidateLimit(0)).toBe(1);
		expect(clampCandidateLimit(4.9)).toBe(4);
		expect(clampCandidateLimit(100)).toBe(8);
		expect(clampCandidateLimit("4")).toBe(1);
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

		expect(bash).toMatchObject({
			tool: "bash",
			execution: "sandbox",
			resources: [path.resolve("/workspace/a").replaceAll("\\", "/")],
		});
		expect(bash?.key).not.toBe(otherCwd?.key);
		expect(write).toMatchObject({ tool: "write", execution: "sandbox", resources: ["src/out.ts"] });
		expect(write?.key).not.toBe(otherWrite?.key);
		expect(edit?.key).toBe(sameEdit?.key);
		expect(buildPiActionKey("write", { path: "../outside", content: "no" }, "/workspace")).toBeUndefined();
		expect(buildPiActionKey("edit", { path: "file", edits: [] }, "/workspace")).toBeUndefined();
	});

	it("namespaces K(a) by execution class and validated schema", () => {
		const base = buildActionKey({
			tool: "custom",
			execution: "resource_cached",
			resources: ["resource"],
			input: { alpha: 1, beta: 2 },
			schemaHash: "schema-a",
		});
		const reordered = buildActionKey({
			tool: "custom",
			execution: "resource_cached",
			resources: ["resource"],
			input: { beta: 2, alpha: 1 },
			schemaHash: "schema-a",
		});
		const sandbox = buildActionKey({
			tool: "custom",
			execution: "sandbox",
			resources: ["resource"],
			input: { alpha: 1, beta: 2 },
			schemaHash: "schema-a",
		});
		const nextSchema = buildActionKey({
			tool: "custom",
			execution: "resource_cached",
			resources: ["resource"],
			input: { alpha: 1, beta: 2 },
			schemaHash: "schema-b",
		});
		const implicitSchema = buildActionKey({
			tool: "custom",
			execution: "resource_cached",
			resources: ["resource"],
			input: { value: 1 },
		});
		const explicitEmptySchema = buildActionKey({
			tool: "custom",
			execution: "resource_cached",
			resources: ["resource"],
			input: { value: 1 },
			schemaHash: "",
		});

		expect(reordered.key).toBe(base.key);
		expect(new Set([base.key, sandbox.key, nextSchema.key]).size).toBe(3);
		expect(implicitSchema.key).toBe(explicitEmptySchema.key);
		expect(base.schemaHash).toBe("schema-a");
	});

	it("allows read projection only inside one schema namespace", () => {
		const broad = buildPiActionKey("read", { path: "a.ts", offset: 1, limit: 100 }, "/workspace", "schema-a");
		const compatible = buildPiActionKey("read", { path: "a.ts", offset: 20, limit: 10 }, "/workspace", "schema-a");
		const changedSchema = buildPiActionKey("read", { path: "a.ts", offset: 20, limit: 10 }, "/workspace", "schema-b");
		const grepBroad = buildPiActionKey("grep", { pattern: "TODO", limit: 100 }, "/workspace", "schema-a");
		const grepNarrow = buildPiActionKey("grep", { pattern: "TODO", limit: 10 }, "/workspace", "schema-a");
		const findBroad = buildPiActionKey("find", { pattern: "*.ts", limit: 100 }, "/workspace", "schema-a");
		const findNarrow = buildPiActionKey("find", { pattern: "*.ts", limit: 10 }, "/workspace", "schema-a");
		const projectors = [READ_RANGE_ACTION_KEY_PROJECTOR];

		expect(broad && compatible ? actionKeyMatches(broad, compatible, projectors) : false).toBe(true);
		expect(broad && changedSchema ? actionKeyMatches(broad, changedSchema, projectors) : true).toBe(false);
		expect(broad && changedSchema ? actionKeyProjectionPartitions(broad, projectors) : []).not.toEqual(
			changedSchema ? actionKeyProjectionPartitions(changedSchema, projectors) : [],
		);
		expect(grepBroad && grepNarrow ? actionKeyMatches(grepBroad, grepNarrow, projectors) : true).toBe(false);
		expect(findBroad && findNarrow ? actionKeyMatches(findBroad, findNarrow, projectors) : true).toBe(false);
	});

	it("classifies K(a) mismatches without exposing action inputs", () => {
		const projectors = [READ_RANGE_ACTION_KEY_PROJECTOR];
		const broad = buildPiActionKey("read", { path: "a.ts", offset: 1, limit: 100 }, "/workspace", "schema-a");
		const narrow = buildPiActionKey("read", { path: "a.ts", offset: 20, limit: 10 }, "/workspace", "schema-a");
		const otherPath = buildPiActionKey(
			"read",
			{ path: "secret-name.ts", offset: 20, limit: 10 },
			"/workspace",
			"schema-a",
		);
		const otherSchema = buildPiActionKey("read", { path: "a.ts", offset: 20, limit: 10 }, "/workspace", "schema-b");
		const otherTool = buildPiActionKey("grep", { pattern: "private-pattern" }, "/workspace", "schema-a");
		const sandbox = buildActionKey({
			tool: "read",
			execution: "sandbox",
			resources: narrow?.resources ?? [],
			input: { ...(narrow?.input ?? {}) },
			schemaHash: "schema-a",
		});

		expect(broad && narrow ? actionKeyMismatchReason(broad, narrow, projectors) : "missing").toBeUndefined();
		expect(narrow ? actionKeyMismatchReason(narrow, narrow, projectors) : "missing").toBeUndefined();
		expect(broad && narrow ? actionKeyMismatchReason(narrow, broad, projectors) : "missing").toBe(
			"projection_not_applicable",
		);
		expect(broad && narrow ? actionKeyMismatchReason(narrow, broad) : "missing").toBe("different_core");
		expect(broad && otherPath ? actionKeyMismatchReason(broad, otherPath, projectors) : "missing").toBe(
			"different_core",
		);
		expect(broad && otherSchema ? actionKeyMismatchReason(broad, otherSchema, projectors) : "missing").toBe(
			"different_schema",
		);
		expect(broad ? actionKeyMismatchReason(sandbox, broad, projectors) : "missing").toBe("different_execution");
		expect(broad && otherTool ? actionKeyMismatchReason(otherTool, broad, projectors) : "missing").toBe(
			"different_tool",
		);
		expect(JSON.stringify(actionKeyMismatchReason(broad!, otherPath!, projectors))).not.toContain("secret-name");
	});

	it("selects configured readonly and sandbox candidates independently", () => {
		expect(DEFAULTS.tools.sandbox).toEqual(["bash", "write", "edit"]);
		expect(
			candidateToolNames({
				enabled: true,
				candidateLimit: 4,
				maxConcurrentActions: 4,
				resourceCacheMaxEntries: 8,
				predictionTimeoutMs: 100,
				tools: { resourceCached: ["read"], sandbox: ["bash", "write"] },
			}),
		).toEqual(["read", "bash", "write"]);
		expect(inferredExecution("read")).toBe("resource_cached");
		expect(inferredExecution("edit")).toBe("sandbox");
	});

	it("defines equivalence through an injected projection without changing K(a)", () => {
		const projector: ActionKeyProjector = {
			id: "custom.subset",
			partition: (action) =>
				action.tool === "custom"
					? JSON.stringify([action.execution, action.schemaHash, action.resources, action.input.namespace])
					: undefined,
			project: (speculative, actor) => {
				const speculativeValues = Array.isArray(speculative.input.values) ? speculative.input.values : undefined;
				const actorValues = Array.isArray(actor.input.values) ? actor.input.values : undefined;
				if (!speculativeValues || !actorValues) return undefined;
				if (!actorValues.every((value) => speculativeValues.includes(value))) return undefined;
				return {
					action: buildActionKey({
						tool: speculative.tool,
						execution: speculative.execution,
						resources: speculative.resources,
						schemaHash: speculative.schemaHash,
						input: { ...speculative.input, values: actorValues },
					}),
					distance: speculativeValues.length - actorValues.length,
				};
			},
			canShareInFlight: (speculative, actor) => {
				const speculativeValues = Array.isArray(speculative.input.values) ? speculative.input.values : undefined;
				const actorValues = Array.isArray(actor.input.values) ? actor.input.values : undefined;
				return (
					!!speculativeValues && !!actorValues && actorValues.every((value) => speculativeValues.includes(value))
				);
			},
		};
		const speculative = buildActionKey({
			tool: "custom",
			execution: "resource_cached",
			resources: ["set"],
			input: { namespace: "items", values: ["a", "b", "c"] },
		});
		const actor = buildActionKey({
			tool: "custom",
			execution: "resource_cached",
			resources: ["set"],
			input: { namespace: "items", values: ["b", "c"] },
		});

		expect(actionKeyMatch(speculative, actor, [projector])).toEqual({
			kind: "projected",
			projector: "custom.subset",
			distance: 1,
		});
		expect(actionKeyCovers(speculative, actor, [projector])).toBe(true);
		const unguarded: ActionKeyProjector = {
			id: "unguarded",
			partition: projector.partition,
			project: projector.project,
		};
		expect(actionKeyCovers(speculative, actor, [unguarded])).toBe(false);
		expect(
			actionKeyCovers(speculative, actor, [{ ...projector, id: "guarded", canShareInFlight: () => false }]),
		).toBe(false);
		expect(
			actionKeyCovers(speculative, actor, [
				{
					...projector,
					id: "throwing-guard",
					canShareInFlight: () => {
						throw new Error("coverage failed");
					},
				},
			]),
		).toBe(false);
		const broken: ActionKeyProjector = {
			id: "broken",
			partition: () => {
				throw new Error("partition failed");
			},
			project: () => {
				throw new Error("projection failed");
			},
		};
		expect(actionKeyMatch(speculative, actor, [broken])).toBeUndefined();
		expect(actionKeyProjectionPartitions(speculative, [broken])).toEqual([]);
	});

	it("matches a potentially projectable read while rejecting impossible ranges", () => {
		const speculative = buildPiActionKey("read", { path: "src/runtime.ts", offset: 100, limit: 160 }, "/workspace");
		const contained = buildPiActionKey("read", { path: "src/runtime.ts", offset: 220, limit: 30 }, "/workspace");
		const needsCompleteCoverage = buildPiActionKey(
			"read",
			{ path: "src/runtime.ts", offset: 250, limit: 30 },
			"/workspace",
		);
		const startsAfterPlannedRange = buildPiActionKey(
			"read",
			{ path: "src/runtime.ts", offset: 261, limit: 1 },
			"/workspace",
		);
		const uncovered = buildPiActionKey("read", { path: "src/runtime.ts", offset: 80, limit: 30 }, "/workspace");

		const projectors = [READ_RANGE_ACTION_KEY_PROJECTOR];
		expect(speculative && contained ? actionKeyMatches(speculative, contained) : true).toBe(false);
		expect(contained ? actionKeyMatches(contained, contained) : false).toBe(true);
		expect(speculative && contained ? actionKeyMatches(speculative, contained, projectors) : false).toBe(true);
		expect(speculative && contained ? actionKeyCovers(speculative, contained, projectors) : false).toBe(true);
		expect(
			speculative && needsCompleteCoverage
				? actionKeyMatches(speculative, needsCompleteCoverage, projectors)
				: false,
		).toBe(true);
		expect(
			speculative && needsCompleteCoverage ? actionKeyCovers(speculative, needsCompleteCoverage, projectors) : true,
		).toBe(false);
		expect(
			speculative && startsAfterPlannedRange
				? actionKeyMatches(speculative, startsAfterPlannedRange, projectors)
				: true,
		).toBe(false);
		expect(speculative && uncovered ? actionKeyMatches(speculative, uncovered, projectors) : true).toBe(false);
		expect(speculative && contained ? actionKeyMatch(speculative, contained, projectors) : undefined).toEqual({
			kind: "projected",
			projector: "read.range",
			distance: 130,
		});
		expect(speculative && contained ? actionKeyProjectionPartitions(speculative, projectors) : undefined).toEqual(
			contained ? actionKeyProjectionPartitions(contained, projectors) : undefined,
		);
		expect(
			speculative && contained ? actionKeyMatches({ ...speculative, key: "opaque" }, contained, projectors) : false,
		).toBe(true);
		expect(
			speculative && contained
				? actionKeyMatches(
						{ ...speculative, key: "opaque", input: { ...speculative.input, path: "other.ts" } },
						contained,
						projectors,
					)
				: true,
		).toBe(false);
	});
});
