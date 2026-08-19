import { describe, expect, it } from "vitest";
import {
	type ActionKeyProjector,
	type ActionSemanticsDefinition,
	ActionSemanticsRegistry,
	actionKeyMatch,
	actionKeyMismatchReason,
	buildActionKey,
	buildPiActionKey,
	IDEMPOTENT_ACTION_TOOLS,
	isAdoptableSandboxAction,
	isObservableSandboxAction,
	KEYABLE_TOOLS,
	PI_ACTION_SEMANTICS,
	READ_RANGE_ACTION_KEY_PROJECTOR,
	SANDBOX_ACTION_TOOLS,
} from "../src/action-semantics.ts";

describe("ActionSemanticsRegistry", () => {
	it("defines every Pi tool's execution, reuse, versioning, and sandbox policy in one place", () => {
		expect(PI_ACTION_SEMANTICS.toolNames()).toEqual(["read", "grep", "find", "bash", "write", "edit"]);
		expect(KEYABLE_TOOLS).toEqual(PI_ACTION_SEMANTICS.toolNames());
		expect(IDEMPOTENT_ACTION_TOOLS).toEqual(["read", "grep", "find"]);
		expect(SANDBOX_ACTION_TOOLS).toEqual(["bash", "write", "edit"]);

		expect(PI_ACTION_SEMANTICS.definition("read")).toMatchObject({
			execution: "resource_cached",
			reuse: "shared_result",
			resourceVersion: "resources",
			resourceScope: "content",
			sandboxMode: "none",
		});
		expect(PI_ACTION_SEMANTICS.definition("bash")).toMatchObject({
			execution: "sandbox",
			reuse: "exclusive_branch",
			resourceVersion: "workspace",
			resourceScope: "tree_content",
			sandboxMode: "workspace_snapshot",
		});
		expect(PI_ACTION_SEMANTICS.definition("write")).toMatchObject({
			execution: "sandbox",
			reuse: "exclusive_branch",
			resourceVersion: "actor_time",
			sandboxMode: "file_mutation",
		});
		expect(PI_ACTION_SEMANTICS.resourceScope("write")).toBeUndefined();
		expect(isObservableSandboxAction("bash")).toBe(true);
		expect(isAdoptableSandboxAction("write")).toBe(true);
		expect(isAdoptableSandboxAction("edit")).toBe(true);
	});

	it("keeps read's omitted-limit view distinct inside its versioned K(a)", () => {
		const implicit = buildPiActionKey("read", { path: "src/a.ts" }, "/workspace", "schema-v1");
		const explicit = buildPiActionKey(
			"read",
			{ path: "src/a.ts", offset: 1, limit: 2000 },
			"/workspace",
			"schema-v1",
		);

		expect(implicit?.key).not.toBe(explicit?.key);
		expect(
			implicit && explicit ? actionKeyMatch(implicit, explicit, [READ_RANGE_ACTION_KEY_PROJECTOR]) : undefined,
		).toMatchObject({ kind: "projected", projector: "read.range" });
		expect(implicit).toMatchObject({
			tool: "read",
			execution: "resource_cached",
			semanticsEpoch: "pi.read.v2",
			schemaHash: "schema-v1",
			resources: ["src/a.ts"],
		});
		expect(implicit?.input).not.toHaveProperty("limit");
		expect(explicit?.input).toHaveProperty("limit", 2000);
		expect(implicit?.key).toContain('"semanticsEpoch":"pi.read.v2"');
		expect(Object.isFrozen(implicit)).toBe(true);
		expect(Object.isFrozen(implicit?.input)).toBe(true);
		expect(Object.isFrozen(implicit?.resources)).toBe(true);
	});

	it("fails closed instead of folding unsupported numeric query views into valid keys", () => {
		expect(buildPiActionKey("read", { path: "a.ts", offset: 1.5 }, "/workspace")).toBeUndefined();
		expect(buildPiActionKey("read", { path: "a.ts", limit: -1 }, "/workspace")).toBeUndefined();
		expect(buildPiActionKey("grep", { pattern: "x", context: 0.5 }, "/workspace")).toBeUndefined();
		expect(buildPiActionKey("grep", { pattern: "x", limit: 0 }, "/workspace")).toBeUndefined();
		expect(buildPiActionKey("find", { pattern: "*", limit: 0 }, "/workspace")).toBeUndefined();
		expect(buildPiActionKey("find", { pattern: "*", limit: 1.5 }, "/workspace")).toBeUndefined();
	});

	it("never equates identical inputs across different tool-semantics epochs", () => {
		const oldAction = buildActionKey({
			tool: "read",
			execution: "resource_cached",
			resources: ["a.ts"],
			input: { path: "a.ts", offset: 1, limit: 20 },
			schemaHash: "schema",
			semanticsEpoch: "read.v1",
		});
		const newAction = buildActionKey({
			tool: "read",
			execution: "resource_cached",
			resources: ["a.ts"],
			input: { path: "a.ts", offset: 1, limit: 20 },
			schemaHash: "schema",
			semanticsEpoch: "read.v2",
		});

		expect(actionKeyMatch(oldAction, newAction, [READ_RANGE_ACTION_KEY_PROJECTOR])).toBeUndefined();
		expect(actionKeyMismatchReason(oldAction, newAction, [READ_RANGE_ACTION_KEY_PROJECTOR])).toBe(
			"different_semantics",
		);
	});

	it("never equates identical actions resolved to different execution backends", () => {
		const first = PI_ACTION_SEMANTICS.buildKey("bash", { command: "echo $VALUE" }, "/workspace", "schema", {
			fingerprint: "local:env-a",
		});
		const second = PI_ACTION_SEMANTICS.buildKey("bash", { command: "echo $VALUE" }, "/workspace", "schema", {
			fingerprint: "local:env-b",
		});

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) throw new Error("Expected keyed bash actions");
		expect(actionKeyMatch(first, second)).toBeUndefined();
		expect(actionKeyMismatchReason(first, second)).toBe("different_executor");
	});

	it("supports a new host tool with one semantics definition", () => {
		const registry = new ActionSemanticsRegistry([
			resourceDefinition("stat", "host.stat.v1", (input) => {
				if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") {
					return undefined;
				}
				return { input: { path: input.path }, resources: [input.path] };
			}),
		]);

		expect(registry.toolNames()).toEqual(["stat"]);
		expect(registry.execution("stat")).toBe("resource_cached");
		expect(registry.reuse("stat")).toBe("shared_result");
		expect(registry.requiresRuntimeResourceVersion("stat")).toBe(true);
		expect(registry.watchesResourceVersion("stat")).toBe(true);
		expect(registry.resourceScope("stat")).toBe("content");
		expect(registry.buildKey("stat", { path: "a.ts" }, "/workspace", "schema")).toMatchObject({
			tool: "stat",
			input: { path: "a.ts" },
			resources: ["a.ts"],
			semanticsEpoch: "host.stat.v1",
		});
		expect(registry.buildKey("unknown", {}, "/workspace")).toBeUndefined();
	});

	it("fails closed when canonicalization rejects, throws, or returns malformed resources", () => {
		const registry = new ActionSemanticsRegistry([
			resourceDefinition("reject", "reject.v1", () => undefined),
			resourceDefinition("throw", "throw.v1", () => {
				throw new Error("bad normalizer");
			}),
			resourceDefinition(
				"malformed",
				"malformed.v1",
				() =>
					({ input: {}, resources: [42] }) as unknown as {
						input: Record<string, never>;
						resources: string[];
					},
			),
		]);

		expect(registry.buildKey("reject", {}, "/workspace")).toBeUndefined();
		expect(registry.buildKey("throw", {}, "/workspace")).toBeUndefined();
		expect(registry.buildKey("malformed", {}, "/workspace")).toBeUndefined();
	});

	it("rejects duplicate tools and incoherent execution policies", () => {
		const definition = resourceDefinition("read", "read.v1", () => ({ input: {}, resources: ["."] }));
		expect(() => new ActionSemanticsRegistry([definition, definition])).toThrow(
			"duplicate action semantics for read",
		);
		expect(() => new ActionSemanticsRegistry([{ ...definition, reuse: "exclusive_branch" }])).toThrow(
			"must use shared_result reuse",
		);
		expect(
			() =>
				new ActionSemanticsRegistry([
					{
						...definition,
						tool: "write",
						execution: "sandbox",
						reuse: "exclusive_branch",
						resourceVersion: "resources",
						sandboxMode: "file_mutation",
					},
				]),
		).toThrow("incoherent version or sandbox policy");
		expect(
			() =>
				new ActionSemanticsRegistry([
					{
						...definition,
						tool: "missing_scope",
						resourceScope: undefined,
					},
				]),
		).toThrow("incoherent version or sandbox policy");
		expect(
			() =>
				new ActionSemanticsRegistry([
					{
						...definition,
						tool: "bad_process",
						execution: "sandbox",
						reuse: "exclusive_branch",
						resourceVersion: "workspace",
						resourceScope: "content",
						sandboxMode: "workspace_snapshot",
					},
				]),
		).toThrow("incoherent version or sandbox policy");
	});

	it("rejects conflicting projector implementations with one identifier", () => {
		const first = projector("same");
		const second = projector("same");
		expect(
			() =>
				new ActionSemanticsRegistry([
					{ ...resourceDefinition("one", "one.v1", canonicalEmpty), projectors: [first] },
					{ ...resourceDefinition("two", "two.v1", canonicalEmpty), projectors: [second] },
				]),
		).toThrow("conflicting action projector same");
	});

	it("allows one projector instance to be shared and exposes only registered projector IDs", () => {
		const shared = projector("shared");
		const registry = new ActionSemanticsRegistry([
			{ ...resourceDefinition("one", "one.v1", canonicalEmpty), projectors: [shared] },
			{ ...resourceDefinition("two", "two.v1", canonicalEmpty), projectors: [shared] },
		]);

		expect(registry.projectors()).toEqual([shared]);
		expect(registry.supportsProjector("shared")).toBe(true);
		expect(registry.supportsProjector("unknown")).toBe(false);
	});

	it("defensively snapshots definitions, projector lists, and tool-name results", () => {
		const projectors = [projector("kept")];
		const source = { ...resourceDefinition("one", "one.v1", canonicalEmpty), projectors };
		const registry = new ActionSemanticsRegistry([source]);
		projectors.push(projector("late"));
		(source as { epoch: string }).epoch = "mutated";
		const names = registry.toolNames() as string[];
		names.push("outside");

		expect(registry.definition("one")?.epoch).toBe("one.v1");
		expect(registry.projectors().map((item) => item.id)).toEqual(["kept"]);
		expect(registry.toolNames()).toEqual(["one"]);
		expect(() =>
			(registry.definition("one")?.projectors as ActionKeyProjector[]).push(projector("blocked")),
		).toThrow();
	});

	it("distinguishes runtime-watched resources, workspace snapshots, and Actor-time validation", () => {
		expect(PI_ACTION_SEMANTICS.requiresRuntimeResourceVersion("read")).toBe(true);
		expect(PI_ACTION_SEMANTICS.watchesResourceVersion("read")).toBe(true);
		expect(PI_ACTION_SEMANTICS.requiresRuntimeResourceVersion("bash")).toBe(true);
		expect(PI_ACTION_SEMANTICS.watchesResourceVersion("bash")).toBe(false);
		expect(PI_ACTION_SEMANTICS.requiresRuntimeResourceVersion("write")).toBe(false);
		expect(PI_ACTION_SEMANTICS.watchesResourceVersion("write")).toBe(false);
	});
});

function resourceDefinition(
	tool: string,
	epoch: string,
	canonicalize: ActionSemanticsDefinition["canonicalize"],
): ActionSemanticsDefinition {
	return {
		tool,
		epoch,
		execution: "resource_cached",
		reuse: "shared_result",
		resourceVersion: "resources",
		resourceScope: "content",
		sandboxMode: "none",
		canonicalize,
	};
}

function canonicalEmpty() {
	return { input: {}, resources: ["."] };
}

function projector(id: string): ActionKeyProjector {
	return {
		id,
		partition: () => undefined,
		project: () => undefined,
	};
}
