import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	applyBindings,
	inferBindings,
	PATTERN_AWARE_DEFAULTS,
	PatternAwareStore,
	patternAwareSettings,
} from "../src/pattern-aware.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })));
});

describe("PatternAware", () => {
	test("late-binds a target input from authoritative structured output paths", () => {
		const context = [
			event({
				sessionID: "one",
				tool: "grep",
				input: { pattern: "TODO" },
				outputPaths: ["src/a.ts"],
			}),
		];
		const bindings = inferBindings(context, { filePath: "src/a.ts", offset: 1 });

		expect(applyBindings(bindings, context)).toEqual({ filePath: "src/a.ts", offset: 1 });
		expect(bindings['["filePath"]']).toEqual({
			type: "event",
			relativeEvent: -1,
			field: "outputPaths",
			path: [0],
		});
		expect(bindings['["offset"]']).toEqual({ type: "constant", value: 1 });
	});

	test("derives adjacent paths and commands through bounded path templates", () => {
		const context = [event({ sessionID: "one", tool: "read", input: { filePath: "services/alpha/config.ts" } })];
		const bindings = inferBindings(context, {
			command: "bun test services/alpha/config.test.ts",
			workdir: "services/alpha",
		});

		expect(applyBindings(bindings, context)).toEqual({
			command: "bun test services/alpha/config.test.ts",
			workdir: "services/alpha",
		});
		const next = [event({ sessionID: "two", tool: "read", input: { filePath: "services/beta/config.ts" } })];
		expect(applyBindings(bindings, next)).toEqual({
			command: "bun test services/beta/config.test.ts",
			workdir: "services/beta",
		});
	});

	test("does not treat an opaque shell command as a filesystem path template", () => {
		const context = [
			event({
				sessionID: "one",
				tool: "bash",
				input: { command: '& "C:\\Users\\dev\\.bun\\bin\\bun.exe" test services/delta/config.test.ts' },
			}),
		];
		const target = { command: '& "C:\\Users\\dev\\.bun\\bin\\bun.exe" test services/epsilon/config.test.ts' };
		const bindings = inferBindings(context, target);

		expect(bindings['["command"]']).toEqual({ type: "constant", value: target.command });
		expect(
			applyBindings(bindings, [
				event({ sessionID: "two", tool: "bash", input: { command: "bun test services/gamma/config.test.ts" } }),
			]),
		).toEqual(target);
	});

	test("learns online after repeated authoritative chains and predicts without an LLM", () => {
		const store = new PatternAwareStore(settings());
		trainGrepRead(store, "one", "src/a.ts");
		trainGrepRead(store, "two", "src/b.ts");

		store.observe(input({ sessionID: "three", tool: "grep", input: { pattern: "TODO" }, outputPaths: ["src/c.ts"] }));
		const candidates = store.predict("three");

		expect(candidates).toContainEqual(
			expect.objectContaining({
				source: "pattern_aware",
				tool: "read",
				input: { filePath: "src/c.ts" },
			}),
		);
	});

	test("learns future gaps instead of expiring at the next unrelated event", () => {
		const store = new PatternAwareStore(settings({ maxFutureGap: 3 }));
		trainGappedRead(store, "one", "src/a.ts");
		trainGappedRead(store, "two", "src/b.ts");

		store.observe(input({ sessionID: "three", tool: "grep", input: { pattern: "TODO" }, outputPaths: ["src/c.ts"] }));
		const candidate = store.predict("three").find((item) => item.tool === "read");

		expect(candidate?.input).toEqual({ filePath: "src/c.ts" });
		expect(candidate?.horizon).toBeGreaterThanOrEqual(1);
	});

	test("does not expose a pattern until objective replay support is reached", () => {
		const store = new PatternAwareStore(settings({ minOccurrences: 2 }));
		trainGrepRead(store, "one", "src/a.ts");
		store.observe(input({ sessionID: "probe", tool: "grep", input: { pattern: "TODO" }, outputPaths: ["src/b.ts"] }));

		expect(store.predict("probe").filter((item) => item.tool === "read")).toHaveLength(0);
	});

	test("invalidates learned targets when their tool schema changes", () => {
		const store = new PatternAwareStore(settings());
		trainGrepRead(store, "one", "src/a.ts", "read-v1");
		trainGrepRead(store, "two", "src/b.ts", "read-v1");
		store.observe(input({ sessionID: "three", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));

		expect(store.predict("three", { read: "read-v2" }).filter((item) => item.tool === "read")).toHaveLength(0);
		expect(store.predict("three", { read: "read-v1" }).some((item) => item.tool === "read")).toBe(true);
	});

	test("persists compact learned patterns without persisting raw event history", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pattern-aware-"));
		temporary.push(directory);
		const file = path.join(directory, "patterns.json");
		const first = new PatternAwareStore(settings(), file);
		await first.load();
		trainGrepRead(first, "one", "src/a.ts");
		trainGrepRead(first, "two", "src/b.ts");
		await first.flush();

		const raw = await fs.readFile(file, "utf8");
		expect(raw).not.toContain('"history"');
		const second = new PatternAwareStore(settings(), file);
		await second.load();
		second.observe(input({ sessionID: "three", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));

		expect(second.predict("three").some((item) => item.tool === "read")).toBe(true);
	});

	test("normalizes partial PatternAware settings", () => {
		expect(patternAwareSettings({ maxContextLength: 3, maxFutureGap: 0 })).toEqual({
			...PATTERN_AWARE_DEFAULTS,
			maxContextLength: 3,
			maxFutureGap: 0,
		});
		expect(
			patternAwareSettings({
				maxContextLength: 0,
				maxFutureGap: -1,
				minOccurrences: Number.NaN,
				minEmpiricalProbability: 2,
				maxPatterns: -1,
			}),
		).toEqual(PATTERN_AWARE_DEFAULTS);
	});

	test("ignores corrupt persisted state instead of failing startup", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pattern-aware-corrupt-"));
		temporary.push(directory);
		const file = path.join(directory, "patterns.json");
		await fs.writeFile(file, "{not-json", "utf8");
		const store = new PatternAwareStore(settings(), file);

		await expect(store.load()).resolves.toBeUndefined();
		expect(store.snapshot()).toEqual([]);
	});

	test("evicts lower-value patterns at the configured capacity", () => {
		const learned = new PatternAwareStore(settings());
		trainGrepRead(learned, "one", "src/a.ts");
		trainGrepRead(learned, "two", "src/b.ts");
		const source = learned.snapshot().find((item) => item.targetTool === "read");
		expect(source).toBeDefined();
		const store = new PatternAwareStore(settings({ maxPatterns: 1 }));

		expect(store.registerValidatedPattern(source!)).toBe(true);
		expect(store.registerValidatedPattern({ ...source!, id: `${source!.id}-new`, lastSeenSequence: 999 })).toBe(true);
		expect(store.snapshot()).toHaveLength(1);
		expect(store.snapshot()[0]?.id).toBe(`${source!.id}-new`);
	});

	test("computes empirical probability from context opportunities and suppresses weak patterns", () => {
		const store = new PatternAwareStore(settings({ minEmpiricalProbability: 0.75 }));
		trainGrepRead(store, "one", "src/a.ts");
		trainGrepRead(store, "two", "src/b.ts");

		store.observe(input({ sessionID: "miss-one", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));
		store.finishSession("miss-one");
		store.observe(input({ sessionID: "miss-two", tool: "grep", input: {}, outputPaths: ["src/d.ts"] }));
		store.finishSession("miss-two");

		const pattern = store
			.snapshot()
			.find((item) => item.targetTool === "read" && item.context.at(-1)?.tool === "grep");
		expect(pattern?.historicalMatches).toBe(2);
		expect(pattern?.historicalOpportunities).toBe(4);
		expect(pattern?.empiricalProbability).toBe(0.5);
		expect(store.predict("miss-two").some((item) => item.tool === "read")).toBe(false);
	});

	test("emits preparation hints when control flow matches before all bound payloads are available", () => {
		const store = new PatternAwareStore(settings());
		trainGrepRead(store, "one", "src/a.ts");
		trainGrepRead(store, "two", "src/b.ts");

		store.observe(input({ sessionID: "probe", tool: "grep", input: { pattern: "TODO" } }));
		const hint = store.predict("probe").find((item) => item.tool === "read");

		expect(hint?.type).toBe("preparation_hint");
		expect(hint?.input).toEqual({});
		expect(hint?.missing).toEqual([["filePath"]]);
	});

	test("learns indexed field fallbacks across historical samples", () => {
		const store = new PatternAwareStore(settings());
		trainOutputRead(store, "one", { primary: "src/a.ts" }, "src/a.ts");
		trainOutputRead(store, "two", { fallback: "src/b.ts" }, "src/b.ts");

		store.observe(input({ sessionID: "probe", tool: "grep", input: {}, output: { fallback: "src/c.ts" } }));
		const candidate = store.predict("probe").find((item) => item.tool === "read");

		expect(candidate?.type).toBe("tool_call");
		expect(candidate?.input).toEqual({ filePath: "src/c.ts" });
	});

	test("records compact LLM turn metadata in the analyzer event stream", () => {
		const store = new PatternAwareStore(settings());
		store.observeTurn({
			sessionID: "session",
			turnID: "turn",
			phase: "start",
			agent: "build",
			model: "deepseek/deepseek-v4-pro",
		});

		expect(store.recent("session")).toContainEqual(
			expect.objectContaining({
				tool: "$llm",
				operation: "turn_start",
				input: expect.objectContaining({ agent: "build" }),
			}),
		);
	});

	test("validates overlapping occurrences of the same future pattern independently", () => {
		const store = new PatternAwareStore(settings({ maxFutureGap: 2 }));
		trainGappedRead(store, "one", "src/a.ts");
		trainGappedRead(store, "two", "src/b.ts");
		const before = store
			.snapshot()
			.find((item) => item.targetTool === "read" && item.context.length === 1 && item.context[0]?.tool === "grep");
		expect(before).toBeDefined();

		store.observe(input({ sessionID: "overlap", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));
		store.observe(input({ sessionID: "overlap", tool: "grep", input: {}, outputPaths: ["src/d.ts"] }));
		store.observe(input({ sessionID: "overlap", tool: "read", input: { filePath: "src/d.ts" } }));

		const after = store.snapshot().find((item) => item.id === before?.id);
		expect(after?.historicalOpportunities).toBe((before?.historicalOpportunities ?? 0) + 2);
		expect(after?.historicalMatches).toBe((before?.historicalMatches ?? 0) + 1);
	});

	test("releases bounded session history when a session finishes", () => {
		const store = new PatternAwareStore(settings());
		store.observe(input({ sessionID: "finished", tool: "read", input: { filePath: "README.md" } }));
		expect(store.recent("finished")).toHaveLength(1);

		store.finishSession("finished");

		expect(store.recent("finished")).toHaveLength(0);
	});

	test("accepts externally supplied patterns only after the same historical validation", () => {
		const learned = new PatternAwareStore(settings());
		trainGrepRead(learned, "one", "src/a.ts");
		trainGrepRead(learned, "two", "src/b.ts");
		const pattern = learned
			.snapshot()
			.find((item) => item.targetTool === "read" && item.context.length === 1 && item.context[0]?.tool === "grep");
		expect(pattern).toBeDefined();

		const imported = new PatternAwareStore(settings());
		expect(imported.registerValidatedPattern(pattern!)).toBe(true);
		expect(
			imported.registerValidatedPattern({
				...pattern!,
				id: `${pattern!.id}-weak`,
				historicalOpportunities: 10,
				historicalMatches: 1,
				empiricalProbability: 0.1,
			}),
		).toBe(false);
		imported.observe(input({ sessionID: "probe", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));
		expect(imported.predict("probe").some((item) => item.tool === "read" && item.type === "tool_call")).toBe(true);
	});
});

function trainGrepRead(store: PatternAwareStore, sessionID: string, filePath: string, schemaHash?: string) {
	store.observe(input({ sessionID, tool: "grep", input: { pattern: "TODO" }, outputPaths: [filePath] }));
	store.observe(
		input({
			sessionID,
			tool: "read",
			input: { filePath },
			output: { content: `contents of ${filePath}` },
			...(schemaHash ? { schemaHash } : {}),
		}),
	);
}

function trainGappedRead(store: PatternAwareStore, sessionID: string, filePath: string) {
	store.observe(input({ sessionID, tool: "grep", input: { pattern: "TODO" }, outputPaths: [filePath] }));
	store.observe(input({ sessionID, tool: "lsp", input: { operation: "symbols" } }));
	store.observe(input({ sessionID, tool: "read", input: { filePath } }));
}

function trainOutputRead(
	store: PatternAwareStore,
	sessionID: string,
	output: Record<string, unknown>,
	filePath: string,
) {
	store.observe(input({ sessionID, tool: "grep", input: { pattern: "TODO" }, output }));
	store.observe(input({ sessionID, tool: "read", input: { filePath } }));
}

function settings(overrides: Partial<typeof PATTERN_AWARE_DEFAULTS> = {}) {
	return { ...PATTERN_AWARE_DEFAULTS, ...overrides };
}

function input(
	overrides: Partial<Parameters<PatternAwareStore["observe"]>[0]> &
		Pick<Parameters<PatternAwareStore["observe"]>[0], "sessionID" | "tool" | "input">,
) {
	return {
		turnID: `${overrides.sessionID}:turn`,
		actionKey: JSON.stringify({ tool: overrides.tool, input: overrides.input }),
		outcome: "success" as const,
		durationMs: 10,
		...overrides,
	};
}

function event(overrides: Parameters<typeof input>[0]) {
	return { ...input(overrides), sequence: 1 };
}
