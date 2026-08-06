import { describe, expect, it } from "vitest";
import { buildPiActionKey } from "../src/common.ts";
import { PATTERN_AWARE_DEFAULTS } from "../src/pattern-aware.ts";
import type {
	CandidatePreflight,
	SpeculativeActionEvent,
	SpeculativeActionSettings,
	SpeculativeCandidate,
	SpeculativeDraftCandidate,
	SpeculativePrediction,
} from "../src/runtime.ts";
import { makeSpeculativeActionRuntime } from "../src/runtime.ts";

interface StartInput {
	readonly sessionID: string;
	readonly turnID: string;
}

interface ConsumeInput extends StartInput {
	readonly tool: string;
	readonly input: Record<string, unknown>;
}

interface HarnessOptions {
	readonly settings?:
		| SpeculativeActionSettings
		| (() => SpeculativeActionSettings | Promise<SpeculativeActionSettings>);
	readonly predict: (input: StartInput, signal: AbortSignal) => Promise<SpeculativePrediction> | SpeculativePrediction;
	readonly predictPatternAware?: (
		input: StartInput,
		signal: AbortSignal,
	) => Promise<SpeculativePrediction> | SpeculativePrediction;
	readonly execute?: (candidate: SpeculativeDraftCandidate, signal: AbortSignal) => Promise<string> | string;
	readonly preflight?: (
		candidate: SpeculativeDraftCandidate,
		signal: AbortSignal,
	) => Promise<CandidatePreflight> | CandidatePreflight;
	readonly prepare?: (candidate: SpeculativeDraftCandidate, signal: AbortSignal) => Promise<void> | void;
	readonly actionKey?: (
		tool: string,
		input: unknown,
		context: { readonly type: "start" | "consume" },
	) => Promise<ReturnType<typeof buildPiActionKey>> | ReturnType<typeof buildPiActionKey>;
	readonly captureResourceVersion?: () => Promise<unknown> | unknown;
	readonly watchResourceVersion?: () => Promise<(() => void) | undefined> | (() => void) | undefined;
	readonly isResourceExpired?: (input: {
		readonly consumeInput?: ConsumeInput;
		readonly candidate: SpeculativeCandidate;
	}) => Promise<boolean> | boolean;
	readonly projectOutput?: (output: string) => Promise<string | undefined> | string | undefined;
	readonly adopt?: (output: string) => Promise<string | undefined> | string | undefined;
	readonly observerThrows?: boolean;
}

const enabledSettings: SpeculativeActionSettings = {
	enabled: true,
	mode: "predict_action_single_step",
	candidateLimit: 4,
	maxConcurrentActions: 4,
	resourceCacheMaxEntries: 512,
	predictionTimeoutMs: 250,
	tools: { resourceCached: ["read", "grep", "find"], sandbox: [] },
};

function createHarness(options: HarnessOptions) {
	const events: SpeculativeActionEvent<string>[] = [];
	let executions = 0;
	const runtime = makeSpeculativeActionRuntime<
		string,
		string,
		StartInput,
		ConsumeInput,
		ConsumeInput,
		{ readonly cwd: string }
	>({
		settings: () =>
			typeof options.settings === "function" ? options.settings() : (options.settings ?? enabledSettings),
		definitions: () => [
			{ name: "read", description: "Read files" },
			{ name: "grep", description: "Search files" },
			{ name: "find", description: "Find files" },
			{ name: "task", description: "Run a subagent" },
			{ name: "bash", description: "Run a command" },
		],
		stateData: () => ({ cwd: "/workspace" }),
		predict: (input, _settings, _definitions, _candidateNames, signal) => options.predict(input, signal),
		...(options.predictPatternAware
			? {
					predictPatternAware: (
						input: StartInput,
						_settings: unknown,
						_definitions: unknown,
						_names: unknown,
						signal: AbortSignal,
					) => options.predictPatternAware?.(input, signal) ?? prediction(),
				}
			: {}),
		actionKey: (tool, input, context) =>
			options.actionKey?.(tool, input, context) ?? buildPiActionKey(tool, input, "/workspace"),
		actual: (input) => ({ tool: input.tool, input: input.input }),
		preflightCandidate: ({ candidate, signal }) => options.preflight?.(candidate, signal) ?? { ok: true },
		...(options.prepare ? { prepareCandidate: ({ candidate, signal }) => options.prepare?.(candidate, signal) } : {}),
		executeCandidate: ({ candidate, signal }) => {
			executions++;
			return options.execute?.(candidate, signal) ?? "prefetched";
		},
		...(options.captureResourceVersion ? { captureResourceVersion: () => options.captureResourceVersion?.() } : {}),
		...(options.watchResourceVersion ? { watchResourceVersion: () => options.watchResourceVersion?.() } : {}),
		...(options.isResourceExpired
			? { isResourceExpired: (input) => options.isResourceExpired?.(input) ?? false }
			: {}),
		...(options.projectOutput ? { projectOutput: ({ output }) => options.projectOutput?.(output) } : {}),
		...(options.adopt ? { adoptCandidate: ({ output }) => options.adopt?.(output) } : {}),
		onEvent: (event) => {
			events.push(event);
			if (options.observerThrows) throw new Error("observer failed");
		},
	});
	return { runtime, events, executions: () => executions };
}

function readCandidate(path = "README.md", offset?: number, limit?: number): SpeculativeDraftCandidate {
	return { type: "tool_call", tool: "read", input: { path, offset, limit } };
}

function bashCandidate(command: string): SpeculativeDraftCandidate {
	return { type: "tool_call", tool: "bash", input: { command } };
}

function prediction(...candidates: SpeculativeDraftCandidate[]): SpeculativePrediction {
	return { candidates, draftTokens: 11 };
}

function consume(turnID: string, input: Record<string, unknown> = { path: "README.md" }): ConsumeInput {
	return { sessionID: "session", turnID, tool: "read", input };
}

function consumeTool(turnID: string, tool: string, input: Record<string, unknown>): ConsumeInput {
	return { sessionID: "session", turnID, tool, input };
}

describe("speculative action runtime", () => {
	it("adopts a matching candidate while pre-execution is still running", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => execution.promise,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		const result = harness.runtime.consume(consume("turn-1"));
		execution.resolve("running-prefetch");

		expect(await result).toBe("running-prefetch");
		expect(harness.executions()).toBe(1);
		expect(harness.events.map((event) => event.type)).toEqual(expect.arrayContaining(["started", "hit"]));
	});

	it("makes a sandbox candidate matchable while preparation is still running", async () => {
		const preparationStarted = deferred<void>();
		const releasePreparation = deferred<void>();
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: [], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("slow setup")),
			prepare: async () => {
				preparationStarted.resolve(undefined);
				await releasePreparation.promise;
			},
			execute: () => "prepared",
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-prepare" });
		await preparationStarted.promise;
		const result = harness.runtime.consume(consumeTool("turn-prepare", "bash", { command: "slow setup" }));
		releasePreparation.resolve(undefined);

		expect(await result).toBe("prepared");
		expect(harness.executions()).toBe(1);
	});

	it("interrupts sandbox preparation when its prediction expires", async () => {
		const preparationStarted = deferred<void>();
		const preparationInterrupted = deferred<void>();
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: [], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("never runs")),
			prepare: (_candidate, signal) =>
				new Promise<void>((_resolve, reject) => {
					preparationStarted.resolve(undefined);
					signal.addEventListener(
						"abort",
						() => {
							preparationInterrupted.resolve(undefined);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-expire-prepare" });
		await preparationStarted.promise;
		await harness.runtime.finishTurn(consumeTool("turn-expire-prepare", "bash", {}));

		await preparationInterrupted.promise;
		expect(harness.executions()).toBe(0);
	});

	it("keeps drafter candidates available for later calls in the same actor turn", async () => {
		const harness = createHarness({
			settings: {
				...enabledSettings,
				adaptiveDrafter: true,
				tools: { resourceCached: [], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("first"), bashCandidate("second")),
			execute: (candidate) => String((candidate.input as { command: string }).command),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-later" });
		await waitFor(() => harness.executions() === 2);

		expect(
			await harness.runtime.consume(consumeTool("turn-later", "bash", { command: "actor-first" })),
		).toBeUndefined();
		expect(await harness.runtime.consume(consumeTool("turn-later", "bash", { command: "second" }))).toBe("second");
		await harness.runtime.finishTurn(consumeTool("turn-later", "bash", {}));
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "key_mismatch")).toBe(false);
	});

	it("lets only one parallel actor call claim an exclusive sandbox job", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: [], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("slow")),
			execute: () => execution.promise,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-exclusive" });
		await waitFor(() => harness.executions() === 1);
		const results = [
			harness.runtime.consume(consumeTool("turn-exclusive", "bash", { command: "slow" })),
			harness.runtime.consume(consumeTool("turn-exclusive", "bash", { command: "slow" })),
		];
		execution.resolve("exclusive");
		const settled = await Promise.all(results);

		expect(settled.filter((result) => result === "exclusive")).toHaveLength(1);
		expect(settled.filter((result) => result === undefined)).toHaveLength(1);
		expect(harness.executions()).toBe(1);
	});

	it("lets parallel actor calls share one resource-cached in-flight job", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			predict: () => prediction(readCandidate("shared.txt")),
			execute: () => execution.promise,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-shared" });
		await waitFor(() => harness.executions() === 1);
		const results = [
			harness.runtime.consume(consume("turn-shared", { path: "shared.txt" })),
			harness.runtime.consume(consume("turn-shared", { path: "shared.txt" })),
		];
		execution.resolve("shared");

		expect(await Promise.all(results)).toEqual(["shared", "shared"]);
		expect(harness.executions()).toBe(1);
	});

	it("does not expire an earlier actor call while its action key is still resolving", async () => {
		const keyResolutionStarted = deferred<void>();
		const releaseKeyResolution = deferred<void>();
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: [], sandbox: ["bash"] },
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
			},
			predict: () => prediction(),
			predictPatternAware: () =>
				prediction({
					type: "tool_call",
					tool: "bash",
					input: { command: "target" },
					source: "pattern_aware",
					patternID: "target-pattern",
					horizon: 0,
				}),
			actionKey: async (tool, input, context) => {
				if (context.type === "consume" && (input as { command?: string }).command === "target") {
					keyResolutionStarted.resolve(undefined);
					await releaseKeyResolution.promise;
				}
				return buildPiActionKey(tool, input, "/workspace");
			},
			execute: () => "target-result",
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-key-order" });
		await waitFor(() => harness.executions() === 1);

		const earlier = harness.runtime.consume(consumeTool("turn-key-order", "bash", { command: "target" }));
		await keyResolutionStarted.promise;
		expect(
			await harness.runtime.consume(consumeTool("turn-key-order", "bash", { command: "unrelated" })),
		).toBeUndefined();
		releaseKeyResolution.resolve(undefined);

		expect(await earlier).toBe("target-result");
	});

	it("revalidates a resource result after an in-flight execution completes", async () => {
		const execution = deferred<string>();
		const firstValidation = deferred<void>();
		let validations = 0;
		const harness = createHarness({
			predict: () => prediction(readCandidate("stale.txt")),
			execute: () => execution.promise,
			captureResourceVersion: () => "v1",
			isResourceExpired: () => {
				validations++;
				if (validations === 1) firstValidation.resolve(undefined);
				return validations > 1;
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-revalidate" });
		await waitFor(() => harness.executions() === 1);
		const result = harness.runtime.consume(consume("turn-revalidate", { path: "stale.txt" }));
		await firstValidation.promise;
		execution.resolve("stale");

		expect(await result).toBeUndefined();
		expect(validations).toBe(2);
		expect(harness.events).toContainEqual(expect.objectContaining({ type: "miss", reason: "resource_expired" }));
	});

	it("rejects a completed sandbox bash result when its workspace snapshot expired", async () => {
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: [], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("stale bash")),
			captureResourceVersion: () => "snapshot",
			isResourceExpired: () => true,
			execute: () => "stale-result",
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-stale-bash" });
		await waitFor(() => harness.executions() === 1);

		expect(
			await harness.runtime.consume(consumeTool("turn-stale-bash", "bash", { command: "stale bash" })),
		).toBeUndefined();
		expect(harness.events).toContainEqual(expect.objectContaining({ type: "miss", reason: "resource_expired" }));
	});

	it("validates sandbox snapshots without installing a watcher on their own adoption", async () => {
		let watches = 0;
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: [], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("safe bash")),
			captureResourceVersion: () => "snapshot",
			isResourceExpired: () => false,
			watchResourceVersion: () => {
				watches++;
				return undefined;
			},
			execute: () => "safe-result",
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-no-watch" });
		await waitFor(() => harness.executions() === 1);

		expect(await harness.runtime.consume(consumeTool("turn-no-watch", "bash", { command: "safe bash" }))).toBe(
			"safe-result",
		);
		expect(watches).toBe(0);
	});

	it("adaptive drafter skips only for an immediate concrete PatternAware candidate", async () => {
		for (const horizon of [0, 1]) {
			let drafterCalls = 0;
			const harness = createHarness({
				settings: {
					...enabledSettings,
					adaptiveDrafter: true,
					patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
				},
				predict: () => {
					drafterCalls++;
					return prediction();
				},
				predictPatternAware: () =>
					prediction({
						type: "tool_call",
						tool: "read",
						input: { path: `pattern-${horizon}.txt` },
						source: "pattern_aware",
						patternID: `pattern-${horizon}`,
						horizon,
					}),
			});
			await harness.runtime.startTurn({ sessionID: "session", turnID: `turn-pattern-${horizon}` });
			await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

			expect(drafterCalls).toBe(horizon === 0 ? 0 : 1);
			await harness.runtime.disposeSession("session");
		}
	});

	it("can disable the drafter while PatternAware remains active", async () => {
		let drafterCalls = 0;
		const harness = createHarness({
			settings: {
				...enabledSettings,
				drafterEnabled: false,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
			},
			predict: () => {
				drafterCalls++;
				return prediction(readCandidate("drafter.txt"));
			},
			predictPatternAware: () =>
				prediction({
					type: "tool_call",
					tool: "read",
					input: { path: "pattern.txt" },
					source: "pattern_aware",
					patternID: "pattern-only",
					horizon: 0,
				}),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-pattern-only" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-pattern-only", { path: "pattern.txt" }))).toBe("prefetched");
		expect(drafterCalls).toBe(0);
	});

	it("shuts down all speculative work when the master switch turns off", async () => {
		let current = enabledSettings;
		let aborted = false;
		const harness = createHarness({
			settings: () => current,
			predict: () => prediction(readCandidate("running.txt")),
			execute: (_candidate, signal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-disable" });
		await waitFor(() => harness.executions() === 1);
		current = { ...enabledSettings, enabled: false };

		expect(await harness.runtime.consume(consume("turn-disable", { path: "running.txt" }))).toBeUndefined();
		expect(aborted).toBe(true);
		expect(harness.runtime.inspect("session").activeTurns).toBe(0);
	});

	it("interrupts predictions and executions as soon as disabled settings are notified", async () => {
		const predictionStarted = deferred<void>();
		const predictionAborted = deferred<void>();
		const executionAborted = deferred<void>();
		const harness = createHarness({
			predict: (input, signal) => {
				if (input.turnID !== "turn-predicting") return prediction(readCandidate("running.txt"));
				predictionStarted.resolve(undefined);
				return new Promise<SpeculativePrediction>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							predictionAborted.resolve(undefined);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
			execute: (_candidate, signal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							executionAborted.resolve(undefined);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		});
		await harness.runtime.startTurn({ sessionID: "executing", turnID: "turn-executing" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.startTurn({ sessionID: "predicting", turnID: "turn-predicting" });
		await predictionStarted.promise;

		await harness.runtime.settingsChanged({ ...enabledSettings, enabled: false });

		await Promise.all([predictionAborted.promise, executionAborted.promise]);
		expect(harness.runtime.inspect()).toEqual({
			activeTurns: 0,
			turnCandidates: 0,
			resourceCandidates: 0,
			pendingPredictions: 0,
		});
		expect(harness.events).toContainEqual(
			expect.objectContaining({ type: "cancelled", reason: "speculative_action_disabled" }),
		);
	});

	it("lets a disabled-settings notification win over a stale startTurn settings read", async () => {
		const staleSettings = deferred<SpeculativeActionSettings>();
		let predictions = 0;
		const harness = createHarness({
			settings: () => staleSettings.promise,
			predict: () => {
				predictions++;
				return prediction(readCandidate());
			},
		});
		const starting = harness.runtime.startTurn({ sessionID: "session", turnID: "turn-stale" });
		await Promise.resolve();
		await harness.runtime.settingsChanged({ ...enabledSettings, enabled: false });
		staleSettings.resolve(enabledSettings);
		await starting;

		expect(predictions).toBe(0);
		expect(harness.runtime.inspect("session").activeTurns).toBe(0);
	});

	it("separates per-turn candidate width from per-session execution concurrency", async () => {
		const executionsFor = async (candidateLimit: number, maxConcurrentActions: number): Promise<number> => {
			const harness = createHarness({
				settings: { ...enabledSettings, candidateLimit, maxConcurrentActions },
				predict: () => prediction(readCandidate("one.txt"), readCandidate("two.txt"), readCandidate("three.txt")),
				execute: () => new Promise<string>(() => {}),
			});
			await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-limits" });
			await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
			const executions = harness.executions();
			await harness.runtime.disposeSession("session");
			return executions;
		};

		expect(await executionsFor(3, 2)).toBe(2);
		expect(await executionsFor(1, 3)).toBe(1);
	});

	it("applies the per-turn candidate limit cumulatively across PatternAware and the drafter", async () => {
		const harness = createHarness({
			settings: {
				...enabledSettings,
				candidateLimit: 2,
				maxConcurrentActions: 4,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
			},
			predictPatternAware: () =>
				prediction({
					...readCandidate("pattern.txt"),
					source: "pattern_aware",
					patternID: "pattern-limit",
					horizon: 1,
				}),
			predict: () => prediction(readCandidate("draft-one.txt"), readCandidate("draft-two.txt")),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-cumulative-limit" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(harness.executions()).toBe(2);
	});

	it("carries a successful resource drafter batch and expires it after a whole uncovered turn", async () => {
		let drafterCalls = 0;
		const harness = createHarness({
			settings: { ...enabledSettings, adaptiveDrafter: true },
			predict: () => {
				drafterCalls++;
				return drafterCalls === 1 ? prediction(readCandidate("a.txt"), readCandidate("b.txt")) : prediction();
			},
			execute: (candidate) => String((candidate.input as { path: string }).path),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-batch-1" });
		await waitFor(() => harness.executions() === 2);
		expect(await harness.runtime.consume(consume("turn-batch-1", { path: "a.txt" }))).toBe("a.txt");
		await harness.runtime.finishTurn(consume("turn-batch-1", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-batch-2" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(drafterCalls).toBe(1);
		expect(await harness.runtime.consume(consume("turn-batch-2", { path: "unrelated.txt" }))).toBeUndefined();
		await harness.runtime.finishTurn(consume("turn-batch-2", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-batch-3" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(drafterCalls).toBe(2);
	});

	it("adopts an already completed candidate without executing it twice", async () => {
		const harness = createHarness({ predict: () => prediction(readCandidate()), execute: () => "ready-prefetch" });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.events.some((event) => event.type === "started"));

		expect(await harness.runtime.consume(consume("turn-1"))).toBe("ready-prefetch");
		expect(harness.executions()).toBe(1);
	});

	it("publishes running and completed cache snapshots before a hit", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			settings: { ...enabledSettings, resourceCacheMaxEntries: 7 },
			predict: () => prediction(readCandidate()),
			execute: () => execution.promise,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-cache" });
		await waitFor(() => harness.events.some((event) => event.type === "started"));

		const started = harness.events.find((event) => event.type === "started");
		expect(started).toMatchObject({
			cacheEntries: 1,
			cacheCapacity: 7,
			cacheRunning: 1,
			cacheCompleted: 0,
			activeCandidates: 1,
			turnCandidates: 0,
			resourceCandidates: 1,
			cacheTools: ["read"],
			cacheExecutions: ["resource_cached"],
		});
		const result = harness.runtime.consume(consume("turn-cache"));
		execution.resolve("cached");
		expect(await result).toBe("cached");

		const eventTypes = harness.events.map((event) => event.type);
		expect(eventTypes.indexOf("cache")).toBeGreaterThan(eventTypes.indexOf("started"));
		expect(eventTypes.indexOf("cache")).toBeLessThan(eventTypes.indexOf("hit"));
		expect(harness.events.find((event) => event.type === "cache")).toMatchObject({
			cacheEntries: 1,
			cacheRunning: 0,
			cacheCompleted: 1,
			activeCandidates: 0,
		});
	});

	it("refreshes cache telemetry when a candidate completes without an actor hit", async () => {
		const harness = createHarness({ predict: () => prediction(readCandidate()), execute: () => "ready" });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-background" });
		await waitFor(() => harness.events.some((event) => event.type === "cache"));

		expect(harness.events.some((event) => event.type === "hit")).toBe(false);
		expect(harness.events.find((event) => event.type === "cache")).toMatchObject({
			cacheCompleted: 1,
			cacheRunning: 0,
		});
	});

	it("publishes actual fallback duration without creating another speculative miss", async () => {
		const harness = createHarness({ predict: () => prediction() });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-actual" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-actual"))).toBeUndefined();
		const misses = harness.events.filter((event) => event.type === "miss").length;

		await harness.runtime.actual({ ...consume("turn-actual"), durationMs: 23 });

		expect(harness.events.filter((event) => event.type === "miss")).toHaveLength(misses);
		expect(harness.events.find((event) => event.type === "actual")).toMatchObject({
			type: "actual",
			tool: "read",
			execution: "resource_cached",
			actionKeyHash: expect.any(String),
			actualAction: expect.any(String),
			actualDurationMs: 23,
			cacheEntries: 0,
		});
	});

	it("never blocks the actor or starts a late drafter candidate after the actor call", async () => {
		const draft = deferred<SpeculativePrediction>();
		const harness = createHarness({ predict: () => draft.promise });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		const startedAt = Date.now();
		const result = await harness.runtime.consume(consume("turn-1"));

		expect(result).toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(50);
		draft.resolve(prediction(readCandidate()));
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(harness.executions()).toBe(0);
		expect(harness.events.some((event) => event.type === "hit")).toBe(false);
	});

	it("does not start a drafter candidate after the actor wins during asynchronous preflight", async () => {
		const preflight = deferred<CandidatePreflight>();
		let preflightStarted = false;
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			preflight: () => {
				preflightStarted = true;
				return preflight.promise;
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-preflight-race" });
		await waitFor(() => preflightStarted);

		expect(await harness.runtime.consume(consume("turn-preflight-race"))).toBeUndefined();
		preflight.resolve({ ok: true });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(harness.executions()).toBe(0);
		expect(harness.events.some((event) => event.type === "started")).toBe(false);
	});

	it("times out and falls back when the drafter never produces a candidate", async () => {
		const settings = { ...enabledSettings, predictionTimeoutMs: 20 };
		const harness = createHarness({
			settings,
			predict: () => new Promise<SpeculativePrediction>(() => {}),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });

		expect(await harness.runtime.consume(consume("turn-1"))).toBeUndefined();
		await waitFor(() =>
			harness.events.some((event) => event.type === "miss" && event.reason === "prediction_timeout"),
		);
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "prediction_timeout")).toBe(true);
		expect(harness.executions()).toBe(0);
	});

	it("reuses a resource candidate across turns until its version expires", async () => {
		let expired = false;
		const harness = createHarness({
			predict: (input) => (input.turnID === "turn-1" ? prediction(readCandidate()) : prediction()),
			captureResourceVersion: () => "v1",
			isResourceExpired: () => expired,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });

		expect(await harness.runtime.consume(consume("turn-2"))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
		await harness.runtime.finishTurn(consume("turn-2", {}));
		expired = true;
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-3" });
		expect(await harness.runtime.consume(consume("turn-3"))).toBeUndefined();
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "resource_expired")).toBe(true);
	});

	it("lets the drafter reuse an exact resource candidate without reporting no candidate", async () => {
		const harness = createHarness({ predict: () => prediction(readCandidate()) });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-2"))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
	});

	it("deduplicates exact draft candidates after one cache miss", async () => {
		const harness = createHarness({ predict: () => prediction(readCandidate(), readCandidate()) });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1"))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
	});

	it("reuses a containing read candidate from the same draft batch", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100), readCandidate("README.md", 1, 60)),
			execute: () => "lines-1-100",
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1", { path: "README.md", offset: 1, limit: 60 }))).toBe(
			"projected:lines-1-100",
		);
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
	});

	it("keeps containing reads separate when no safe projector is installed", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100), readCandidate("README.md", 1, 60)),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1", { path: "README.md", offset: 1, limit: 60 }))).toBe(
			"prefetched",
		);
		expect(harness.executions()).toBe(2);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("shares an in-flight resource job between the next drafter and actor", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => execution.promise,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		const result = harness.runtime.consume(consume("turn-2"));
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		execution.resolve("shared-prefetch");

		expect(await result).toBe("shared-prefetch");
		expect(harness.executions()).toBe(1);
	});

	it("expires a stale drafter cache entry before starting one replacement", async () => {
		let version = "v1";
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => `prefetched-${version}`,
			captureResourceVersion: () => version,
			isResourceExpired: ({ candidate }) => candidate.resourceVersion !== version,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		version = "v2";
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => harness.executions() === 2);

		expect(await harness.runtime.consume(consume("turn-2"))).toBe("prefetched-v2");
		expect(harness.executions()).toBe(2);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("does not charge reused candidates against the new execution limit", async () => {
		const harness = createHarness({
			settings: { ...enabledSettings, candidateLimit: 1 },
			predict: (input) =>
				input.turnID === "turn-1"
					? prediction(readCandidate("README.md"))
					: prediction(readCandidate("README.md"), readCandidate("CHANGELOG.md")),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-2", { path: "CHANGELOG.md" }))).toBe("prefetched");
		expect(harness.executions()).toBe(2);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("projects a containing speculative read and rejects uncovered reads", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100)),
			execute: () => "lines-1-100",
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-1", { path: "README.md", offset: 20, limit: 10 }))).toBe(
			"projected:lines-1-100",
		);

		await harness.runtime.startTurn({ sessionID: "other", turnID: "turn-2" });
		expect(
			await harness.runtime.consume({
				sessionID: "other",
				turnID: "turn-2",
				tool: "read",
				input: { path: "README.md", offset: 95, limit: 10 },
			}),
		).toBeUndefined();
	});

	it("applies the candidate limit after unsupported draft tools are skipped", async () => {
		const harness = createHarness({
			settings: { ...enabledSettings, candidateLimit: 1 },
			predict: () => prediction({ type: "tool_call", tool: "task", input: { prompt: "inspect" } }, readCandidate()),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1"))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
	});

	it("keeps an unfinished resource candidate alive after finishTurn", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			predict: (input) => (input.turnID === "turn-1" ? prediction(readCandidate()) : prediction()),
			execute: () => execution.promise,
			captureResourceVersion: () => "v1",
			isResourceExpired: () => false,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consume("turn-1", {}));
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		const result = harness.runtime.consume(consume("turn-2"));
		execution.resolve("late-prefetch");

		expect(await result).toBe("late-prefetch");
		expect(harness.executions()).toBe(1);
	});

	it("cancels unconsumed turn-scoped work when the turn finishes", async () => {
		let aborted = false;
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: [], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("never finishes")),
			execute: (_candidate, signal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.executions() === 1);
		await harness.runtime.finishTurn(consumeTool("turn-1", "bash", {}));

		expect(aborted).toBe(true);
		expect(
			harness.events.some((event) => event.type === "cancelled" && event.reason === "turn_finished_without_hit"),
		).toBe(true);
	});

	it("falls back when candidate execution fails", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => {
				throw new Error("candidate failed");
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1"))).toBeUndefined();
		expect(
			harness.events.some((event) => event.type === "cancelled" && event.reason === "candidate_execution_failed"),
		).toBe(true);
	});

	it("updates LRU order on access and evicts the oldest resource candidate", async () => {
		const paths: Record<string, string | undefined> = {
			"turn-a": "a.txt",
			"turn-b": "b.txt",
			"turn-c": "c.txt",
		};
		const harness = createHarness({
			settings: { ...enabledSettings, resourceCacheMaxEntries: 2 },
			predict: (input) => {
				const path = paths[input.turnID];
				return path ? prediction(readCandidate(path)) : prediction();
			},
			execute: (candidate) => String((candidate.input as { path: string }).path),
		});
		for (const turnID of ["turn-a", "turn-b"]) {
			await harness.runtime.startTurn({ sessionID: "session", turnID });
			await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
			await harness.runtime.finishTurn({ sessionID: "session", turnID, tool: "read", input: {} });
		}

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-touch" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-touch", { path: "a.txt" }))).toBe("a.txt");
		await harness.runtime.finishTurn(consume("turn-touch", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-c" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		await harness.runtime.finishTurn({ sessionID: "session", turnID: "turn-c", tool: "read", input: {} });
		expect(harness.runtime.inspect("session").resourceCandidates).toBe(2);

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-check-b" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-check-b", { path: "b.txt" }))).toBeUndefined();
		await harness.runtime.finishTurn(consume("turn-check-b", {}));
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-check-a" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-check-a", { path: "a.txt" }))).toBe("a.txt");
	});

	it("reports adoption failure and leaves the actor on the normal execution path", async () => {
		const harness = createHarness({
			settings: { ...enabledSettings, tools: { resourceCached: [], sandbox: ["write"] } },
			predict: () => prediction({ type: "tool_call", tool: "write", input: { path: "out.txt", content: "draft" } }),
			execute: () => "staged",
			adopt: () => undefined,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-write" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(
			await harness.runtime.consume({
				sessionID: "session",
				turnID: "turn-write",
				tool: "write",
				input: { path: "out.txt", content: "draft" },
			}),
		).toBeUndefined();
		expect(harness.events.some((event) => event.type === "miss" && event.reason === "adoption_failed")).toBe(true);
	});

	it("isolates observer failures from candidate settlement", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			observerThrows: true,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-observer" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-observer"))).toBe("prefetched");
		expect(harness.events.some((event) => event.type === "hit")).toBe(true);
	});

	it("publishes complete redacted lifecycle payloads with cumulative draft tokens", async () => {
		const harness = createHarness({
			predict: (input) => {
				const path = input.turnID === "turn-1" ? "README.md" : "CHANGELOG.md";
				const sensitive = {
					type: "tool_call" as const,
					tool: "read",
					input: { path, token: "top-secret", authorization: "Bearer private" },
					diagnostic: JSON.stringify({
						toolCallID: `draft-${input.turnID}`,
						tool: "read",
						input: { path, token: "top-secret", note: "sk-abcdefghijklmnop" },
					}),
				};
				return { candidates: [sensitive], draftTokens: input.turnID === "turn-1" ? 7 : 5 };
			},
		});

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-1"))).toBe("prefetched");
		await harness.runtime.finishTurn(consume("turn-1", {}));
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-2", { path: "CHANGELOG.md" }))).toBe("prefetched");

		const started = harness.events.filter((event) => event.type === "started");
		expect(started).toHaveLength(2);
		expect(started[0]).toMatchObject({
			type: "started",
			tool: "read",
			execution: "resource_cached",
			draftTokens: 7,
			totalDraftTokens: 7,
			predictionLatencyMs: expect.any(Number),
			actionKeyHash: expect.any(String),
		});
		expect(started[1]).toMatchObject({ draftTokens: 5, totalDraftTokens: 12 });
		if (started[0]?.type !== "started") throw new Error("Expected a started event");
		expect(started[0].draftCandidate).toContain("[redacted]");
		expect(started[0].draftCandidate).not.toContain("top-secret");
		expect(started[0].draftCandidate).not.toContain("sk-abcdefghijklmnop");
		expect(started[0].predictedAction).not.toContain("Bearer private");

		const hit = harness.events.find((event) => event.type === "hit");
		expect(hit).toMatchObject({
			type: "hit",
			tool: "read",
			draftTokens: 7,
			totalDraftTokens: 7,
			savedMs: expect.any(Number),
			waitedMs: expect.any(Number),
			actualAction: expect.any(String),
		});

		const missHarness = createHarness({
			predict: () => prediction(readCandidate("README.md")),
		});
		await missHarness.runtime.startTurn({ sessionID: "session", turnID: "turn-miss" });
		await waitFor(() => missHarness.runtime.inspect().pendingPredictions === 0);
		expect(await missHarness.runtime.consume(consume("turn-miss", { path: "CHANGELOG.md" }))).toBeUndefined();
		await missHarness.runtime.finishTurn(consume("turn-miss", {}));

		expect(missHarness.events.find((event) => event.type === "miss")).toMatchObject({
			type: "miss",
			reason: "key_mismatch",
			tool: "read",
			actionKeyHash: expect.any(String),
			predictedAction: expect.any(String),
			actualAction: expect.any(String),
		});
	});

	it("performs no prediction or background work while disabled", async () => {
		let predictions = 0;
		const harness = createHarness({
			settings: { ...enabledSettings, enabled: false },
			predict: () => {
				predictions++;
				return prediction(readCandidate());
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });

		expect(predictions).toBe(0);
		expect(harness.runtime.inspect()).toEqual({
			activeTurns: 0,
			turnCandidates: 0,
			resourceCandidates: 0,
			pendingPredictions: 0,
		});
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
