import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildActionKey, patternAwareInput } from "../src/common.ts";
import {
	applyBindings,
	inferBindings,
	PATTERN_AWARE_DEFAULTS,
	PatternAwareStore,
	patternAwareSettings,
	projectPatternAwareObservation,
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

	test("uses weighted gap coverage instead of the largest observed gap", () => {
		const store = new PatternAwareStore(settings({ maxFutureGap: 8, futureGapCoverage: 0.8 }));
		expect(store.registerValidatedPattern(validatedGapPattern({ "0": 9, "5": 1 }))).toBe(true);

		store.observe(input({ sessionID: "probe", tool: "grep", input: { pattern: "TODO" } }));

		expect(store.predict("probe").find((item) => item.tool === "read")?.horizon).toBe(0);
	});

	test("lets recent gap behavior replace stale high-volume history", () => {
		const store = new PatternAwareStore(
			settings({
				maxFutureGap: 8,
				futureGapCoverage: 0.9,
				decayHalfLifeEvents: 10,
			}),
		);
		expect(
			store.registerValidatedPattern(
				validatedGapPattern(
					{ "0": 1000, "3": 10 },
					{
						gapLastSeen: { "0": 0, "3": 1000 },
						lastSeenSequence: 1000,
						occurrences: 1010,
						replayMatches: 1010,
						historicalOpportunities: 1010,
						historicalMatches: 1010,
					},
				),
			),
		).toBe(true);

		store.observe(input({ sessionID: "probe", tool: "grep", input: { pattern: "TODO" } }));

		expect(store.predict("probe").find((item) => item.tool === "read")?.horizon).toBe(3);
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

	test("continues schema-versioned patterns immediately after an authoritative event", () => {
		const store = new PatternAwareStore(settings());
		trainGrepRead(store, "one", "src/a.ts", "read-v1");
		trainGrepRead(store, "two", "src/b.ts", "read-v1");

		const candidates = store.observe(
			input({ sessionID: "three", tool: "grep", input: { pattern: "TODO" }, outputPaths: ["src/c.ts"] }),
			{ read: "read-v1" },
		);

		expect(candidates).toContainEqual(
			expect.objectContaining({
				type: "tool_call",
				source: "pattern_aware",
				tool: "read",
				input: expect.objectContaining({ filePath: "src/c.ts" }),
			}),
		);
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
		expect(JSON.parse(raw).version).toBe(8);
		const second = new PatternAwareStore(settings(), file);
		await second.load();
		second.observe(input({ sessionID: "three", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));

		expect(second.predict("three").some((item) => item.tool === "read")).toBe(true);
	});

	test("discards persisted patterns from an incompatible analyzer version", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pattern-aware-version-"));
		temporary.push(directory);
		const file = path.join(directory, "patterns.json");
		await fs.writeFile(
			file,
			JSON.stringify({
				version: 7,
				patterns: [validatedGapPattern({ "0": 10 })],
				pools: [],
			}),
		);

		const store = new PatternAwareStore(settings(), file);
		await store.load();

		expect(store.snapshot()).toEqual([]);
	});

	test("persists bounded analyzer pools so patterns can form across processes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pattern-pool-"));
		temporary.push(directory);
		const file = path.join(directory, "patterns.json");
		const first = new PatternAwareStore(settings({ minOccurrences: 2 }), file);
		await first.load();
		trainGrepRead(first, "one", "src/a.ts");
		first.finishSession("one");
		await first.flush();

		const persisted = JSON.parse(await fs.readFile(file, "utf8"));
		expect(persisted.patterns).toHaveLength(0);
		expect(persisted.pools.length).toBeGreaterThan(0);

		const second = new PatternAwareStore(settings({ minOccurrences: 2 }), file);
		await second.load();
		trainGrepRead(second, "two", "src/b.ts");

		expect(second.snapshot().some((item) => item.targetTool === "read")).toBe(true);
	});

	test("normalizes partial PatternAware settings", () => {
		expect(patternAwareSettings({ maxContextLength: 3, maxFutureGap: 0 })).toEqual({
			...PATTERN_AWARE_DEFAULTS,
			maxContextLength: 3,
			maxFutureGap: 0,
		});
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

	test("retries negatively cached pools and learns after the recent samples become stable", () => {
		const store = new PatternAwareStore(settings({ maxContextLength: 1, maxFutureGap: 0 }));
		for (let index = 0; index < 4; index++) {
			trainOutputRead(store, `noise-${index}`, { path: `src/source-${index}.ts` }, `src/unrelated-${index}.ts`);
		}
		for (let index = 0; index < 32; index++) {
			const file = `src/stable-${index}.ts`;
			trainOutputRead(store, `stable-${index}`, { path: file }, file);
		}

		store.observe(input({ sessionID: "probe", tool: "grep", input: {}, output: { path: "src/result.ts" } }));
		expect(store.predict("probe").find((item) => item.tool === "read")?.input).toEqual({
			filePath: "src/result.ts",
		});
	});

	test("combines multiple structured fields instead of memorizing a concrete path", () => {
		const store = new PatternAwareStore(settings());
		trainJoinedRead(store, "one", "services/a", "alpha");
		trainJoinedRead(store, "two", "services/b", "beta");

		store.observe(
			input({
				sessionID: "probe",
				tool: "inspect",
				input: {},
				output: { root: "services/c", name: "gamma" },
			}),
		);

		expect(store.predict("probe").find((item) => item.tool === "read")?.input).toEqual({
			filePath: "services/c/gamma",
		});
	});

	test("does not compose presentation text into a path binding", () => {
		const store = new PatternAwareStore(settings());
		for (const [sessionID, root, preview] of [
			["one", "services/a", "alpha.ts"],
			["two", "services/b", "beta.ts"],
		]) {
			store.observe(
				input({
					sessionID,
					tool: "read",
					input: { filePath: root },
					output: { preview },
				}),
			);
			store.observe(input({ sessionID, tool: "read", input: { filePath: `${root}/${preview}` } }));
			store.finishSession(sessionID);
		}

		store.observe(
			input({
				sessionID: "probe",
				tool: "read",
				input: { filePath: "services/c" },
				output: { preview: "export const value = 1" },
			}),
		);

		expect(store.predict("probe").find((item) => item.tool === "read")).toBeUndefined();
	});

	test("matches learned contexts by semantic output kind", () => {
		const store = new PatternAwareStore(settings());
		for (const sessionID of ["one", "two"]) {
			store.observe(
				input({
					sessionID,
					tool: "inspect",
					input: { path: `src/${sessionID}.ts` },
					output: { kind: "path", value: `src/${sessionID}.test.ts` },
				}),
			);
			store.observe(input({ sessionID, tool: "read", input: { filePath: "README.md" } }));
			store.finishSession(sessionID);
		}

		store.observe(
			input({
				sessionID: "wrong-output",
				tool: "inspect",
				input: { path: "src/value.ts" },
				output: { kind: "text", value: "src/value.test.ts" },
			}),
		);
		expect(store.predict("wrong-output").find((item) => item.tool === "read")).toBeUndefined();
	});

	test("expands a structured collection when actor ordering varies", () => {
		const store = new PatternAwareStore(settings());
		trainResultReads(store, "one", ["src/a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"]);
		trainResultReads(store, "two", ["src/c.ts", "src/d.ts"], ["src/c.ts", "src/d.ts"]);

		store.observe(
			input({
				sessionID: "probe",
				tool: "grep",
				input: { pattern: "symbol" },
				output: { results: [{ path: "src/e.ts" }, { path: "src/f.ts" }] },
			}),
		);
		const paths = store
			.predict("probe")
			.filter((item) => item.tool === "read" && item.type === "tool_call")
			.map((item) => item.input.filePath);

		expect(paths).toContain("src/e.ts");
		expect(paths).toContain("src/f.ts");
	});

	test("learns a reusable read range from varying actor windows", () => {
		const store = new PatternAwareStore(settings());
		for (const [sessionID, filePath, offset, limit] of [
			["one", "src/a.ts", 320, 80],
			["two", "src/b.ts", 840, 120],
		] as const) {
			store.observe(
				input({
					sessionID,
					tool: "grep",
					input: { pattern: "symbol" },
					output: { results: [{ path: filePath, line: offset + 20 }] },
				}),
			);
			const action = buildActionKey({
				tool: "read",
				execution: "resource_cached",
				resources: [filePath],
				input: { path: filePath, offset, limit },
			});
			store.observe(input({ sessionID, tool: "read", input: patternAwareInput(action) }));
		}

		store.observe(
			input({
				sessionID: "probe",
				tool: "grep",
				input: { pattern: "symbol" },
				output: { results: [{ path: "src/c.ts", line: 1_200 }] },
			}),
		);

		expect(store.predict("probe").find((item) => item.tool === "read")?.input).toEqual({
			path: "src/c.ts",
			offset: 1,
			limit: 2000,
		});
	});

	test("backs off across matching suffix contexts", () => {
		const store = new PatternAwareStore(settings());
		for (const [sessionID, filePath] of [
			["one", "src/a.ts"],
			["two", "src/b.ts"],
		] as const) {
			store.observeTurn({ sessionID, turnID: `${sessionID}:turn`, phase: "start" });
			trainGrepRead(store, sessionID, filePath);
		}

		store.observeTurn({ sessionID: "probe", turnID: "probe:turn", phase: "start" });
		store.observe(input({ sessionID: "probe", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));
		const candidate = store.predict("probe").find((item) => item.tool === "read");

		expect(candidate?.conditionalProbability).toBeGreaterThan(0.8);
		expect(candidate?.input).toEqual({ filePath: "src/c.ts" });
	});

	test("unlocks a multi-step frontier from speculative structured outputs", () => {
		const store = new PatternAwareStore(settings());
		trainFrontier(store, "one", "src/a.ts", "tests/alpha.test.ts");
		trainFrontier(store, "two", "src/b.ts", "tests/beta.test.ts");

		store.observe(input({ sessionID: "probe", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));
		const read = store.predict("probe").find((item) => item.tool === "read");
		expect(read?.depth).toBe(1);

		const lsp = store
			.continue(
				read!.continuation,
				input({
					sessionID: "probe",
					tool: "read",
					input: { filePath: "src/c.ts" },
					output: { nextPath: "tests/gamma.test.ts" },
				}),
			)
			.find((item) => item.tool === "lsp");
		expect(lsp?.input).toEqual({ operation: "diagnostics", filePath: "tests/gamma.test.ts" });
		expect(lsp?.depth).toBe(2);

		const bash = store
			.continue(
				lsp!.continuation,
				input({
					sessionID: "probe",
					tool: "lsp",
					input: lsp!.input,
					output: { command: "bun test tests/gamma.test.ts" },
				}),
			)
			.find((item) => item.tool === "bash");
		expect(bash?.input).toEqual({ command: "bun test tests/gamma.test.ts" });
		expect(bash?.depth).toBe(3);
		expect(new Set(bash?.continuation.visitedPatternIDs).size).toBe(3);
	});

	test("keeps LLM turn boundaries transparent to multi-step continuation", () => {
		const store = new PatternAwareStore(settings());
		for (const [sessionID, sourcePath, testPath] of [
			["one", "src/a.ts", "tests/a.test.ts"],
			["two", "src/b.ts", "tests/b.test.ts"],
		] as const) {
			store.observeTurn({ sessionID, turnID: `${sessionID}:grep`, phase: "start" });
			store.observe(input({ sessionID, tool: "grep", input: {}, outputPaths: [sourcePath] }));
			store.observeTurn({ sessionID, turnID: `${sessionID}:grep`, phase: "finish" });
			store.observeTurn({ sessionID, turnID: `${sessionID}:read`, phase: "start" });
			store.observe(
				input({
					sessionID,
					tool: "read",
					input: { filePath: sourcePath },
					output: { nextPath: testPath },
				}),
			);
			store.observeTurn({ sessionID, turnID: `${sessionID}:read`, phase: "finish" });
			store.observeTurn({ sessionID, turnID: `${sessionID}:lsp`, phase: "start" });
			store.observe(
				input({
					sessionID,
					tool: "lsp",
					input: { operation: "diagnostics", filePath: testPath },
				}),
			);
		}

		store.observeTurn({ sessionID: "probe", turnID: "probe:grep", phase: "start" });
		store.observe(input({ sessionID: "probe", tool: "grep", input: {}, outputPaths: ["src/c.ts"] }));
		const read = store.predict("probe").find((item) => item.tool === "read");
		const lsp = store
			.continue(
				read!.continuation,
				input({
					sessionID: "probe",
					tool: "read",
					input: { filePath: "src/c.ts" },
					output: { nextPath: "tests/c.test.ts" },
				}),
			)
			.find((item) => item.tool === "lsp");

		expect(read?.depth).toBe(1);
		expect(lsp?.depth).toBe(2);
		expect(lsp?.input).toEqual({ operation: "diagnostics", filePath: "tests/c.test.ts" });
		expect(
			store
				.snapshot()
				.flatMap((pattern) => pattern.context)
				.some((event) => event.tool === "$llm"),
		).toBe(false);
	});

	test("projects native and legacy tool outputs without parsing display text", () => {
		expect(
			projectPatternAwareObservation({
				output: {
					structured: [{ entry: { path: "src/a.ts" }, line: 3, text: "TODO" }],
					content: [{ type: "text", text: "ignored display text" }],
				},
			}),
		).toEqual({
			output: [{ entry: { path: "src/a.ts" }, line: 3, text: "TODO" }],
			outputPaths: ["src/a.ts"],
		});
		expect(
			projectPatternAwareObservation({
				metadata: { results: [{ path: "C:/repo/src/b.ts", line: 4 }] },
				output: "ignored display text",
			}),
		).toEqual({
			output: { results: [{ path: "C:/repo/src/b.ts", line: 4 }] },
			outputPaths: ["C:/repo/src/b.ts"],
		});
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
		expect(store.hasObservedAction("session")).toBe(false);

		store.observe(input({ sessionID: "session", tool: "read", input: { filePath: "src/index.ts" } }));

		expect(store.hasObservedAction("session")).toBe(true);
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

	test("keeps waiting through a different invocation of the target tool while the gap remains", () => {
		const store = new PatternAwareStore(settings({ maxFutureGap: 2 }));
		const pattern = validatedGapPattern(
			{ "1": 10 },
			{
				id: "same-tool-gap",
				bindings: { '["filePath"]': { type: "constant", value: "src/target.ts" } },
			},
		);
		expect(store.registerValidatedPattern(pattern)).toBe(true);

		store.observe(input({ sessionID: "same-tool", tool: "grep", input: { pattern: "TODO" } }));
		store.observe(input({ sessionID: "same-tool", tool: "read", input: { filePath: "src/intermediate.ts" } }));
		store.observe(input({ sessionID: "same-tool", tool: "read", input: { filePath: "src/target.ts" } }));

		const after = store.snapshot().find((item) => item.id === pattern.id);
		expect(after?.historicalOpportunities).toBe(pattern.historicalOpportunities + 1);
		expect(after?.historicalMatches).toBe(pattern.historicalMatches + 1);
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

function trainJoinedRead(store: PatternAwareStore, sessionID: string, root: string, name: string) {
	store.observe(input({ sessionID, tool: "inspect", input: {}, output: { root, name } }));
	store.observe(input({ sessionID, tool: "read", input: { filePath: `${root}/${name}` } }));
}

function trainFrontier(store: PatternAwareStore, sessionID: string, sourcePath: string, testPath: string) {
	store.observe(input({ sessionID, tool: "grep", input: {}, outputPaths: [sourcePath] }));
	store.observe(
		input({
			sessionID,
			tool: "read",
			input: { filePath: sourcePath },
			output: { nextPath: testPath },
		}),
	);
	store.observe(
		input({
			sessionID,
			tool: "lsp",
			input: { operation: "diagnostics", filePath: testPath },
			output: { command: `bun test ${testPath}` },
		}),
	);
	store.observe(input({ sessionID, tool: "bash", input: { command: `bun test ${testPath}` } }));
}

function trainResultReads(
	store: PatternAwareStore,
	sessionID: string,
	results: ReadonlyArray<string>,
	reads: ReadonlyArray<string>,
) {
	store.observe(
		input({
			sessionID,
			tool: "grep",
			input: { pattern: "symbol" },
			output: { results: results.map((filePath) => ({ path: filePath })) },
		}),
	);
	for (const filePath of reads) store.observe(input({ sessionID, tool: "read", input: { filePath } }));
}

function settings(overrides: Partial<typeof PATTERN_AWARE_DEFAULTS> = {}) {
	return { ...PATTERN_AWARE_DEFAULTS, ...overrides };
}

function validatedGapPattern(
	gapCounts: Readonly<Record<string, number>>,
	overrides: Partial<Parameters<PatternAwareStore["registerValidatedPattern"]>[0]> = {},
): Parameters<PatternAwareStore["registerValidatedPattern"]>[0] {
	return {
		id: "gap-pattern",
		context: [{ tool: "grep", outcome: "success" }],
		targetTool: "read",
		bindings: { '["path"]': { type: "constant", value: "README.md" } },
		gapCounts,
		gapLastSeen: Object.fromEntries(Object.keys(gapCounts).map((gap) => [gap, 1])),
		occurrences: 10,
		replayMatches: 10,
		historicalOpportunities: 10,
		historicalMatches: 10,
		empiricalProbability: 1,
		opportunities: 0,
		consumed: 0,
		unused: 0,
		averageDurationMs: 100,
		lastSeenSequence: 1,
		...overrides,
	};
}

function input(
	overrides: Partial<Parameters<PatternAwareStore["observe"]>[0]> &
		Pick<Parameters<PatternAwareStore["observe"]>[0], "sessionID" | "tool" | "input">,
) {
	return {
		turnID: `${overrides.sessionID}:turn`,
		outcome: "success" as const,
		durationMs: 10,
		...overrides,
	};
}

function event(overrides: Parameters<typeof input>[0]) {
	return { ...input(overrides), sequence: 1 };
}
