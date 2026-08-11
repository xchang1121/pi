import { describe, expect, it, vi } from "vitest";
import {
	type ActionProjectionRule,
	READ_RANGE_ACTION_KEY_PROJECTOR,
	readRangesShareInFlight,
} from "../src/action-key-projection.ts";
import type { ActionKey, ProjectedActionKeyMatch } from "../src/common.ts";
import { asRecord, buildPiActionKey, readActionRange } from "../src/common.ts";
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
	readonly id?: string;
	readonly tool: string;
	readonly input: Record<string, unknown>;
	readonly terminal?: boolean;
}

interface HarnessOptions {
	readonly settings?:
		| SpeculativeActionSettings
		| (() => SpeculativeActionSettings | Promise<SpeculativeActionSettings>);
	readonly predict: (
		input: StartInput,
		signal: AbortSignal,
		settings: SpeculativeActionSettings,
	) => Promise<SpeculativePrediction> | SpeculativePrediction;
	readonly predictPatternAware?: (
		input: StartInput,
		signal: AbortSignal,
	) => Promise<SpeculativePrediction> | SpeculativePrediction;
	readonly execute?: (candidate: SpeculativeDraftCandidate, signal: AbortSignal) => Promise<string> | string;
	readonly preflight?: (
		candidate: SpeculativeDraftCandidate,
		signal: AbortSignal,
	) => Promise<CandidatePreflight> | CandidatePreflight;
	readonly authorize?: (
		candidate: SpeculativeCandidate,
		input: ConsumeInput,
	) => Promise<CandidatePreflight> | CandidatePreflight;
	readonly prepare?: (candidate: SpeculativeDraftCandidate, signal: AbortSignal) => Promise<void> | void;
	readonly actionKey?: (
		tool: string,
		input: unknown,
		context: { readonly type: "start" | "consume" },
	) => Promise<ReturnType<typeof buildPiActionKey>> | ReturnType<typeof buildPiActionKey>;
	readonly captureResourceVersion?: () => Promise<unknown> | unknown;
	readonly releaseResourceVersion?: (version: unknown) => void;
	readonly watchResourceVersion?: () => Promise<(() => void) | undefined> | (() => void) | undefined;
	readonly isResourceExpired?: (input: {
		readonly consumeInput?: ConsumeInput;
		readonly candidate: SpeculativeCandidate;
	}) => Promise<boolean> | boolean;
	readonly projectOutput?: (
		output: string,
		keyMatch: ProjectedActionKeyMatch,
	) => Promise<string | undefined> | string | undefined;
	readonly captureProjectionCoverage?: (action: ActionKey, output: string) => unknown | undefined;
	readonly rejectCandidateOutput?: (output: string) => string | undefined;
	readonly adopt?: (output: string) => Promise<string | undefined> | string | undefined;
	readonly recordAuthoritative?: () => Promise<SpeculativePrediction | undefined> | SpeculativePrediction | undefined;
	readonly continuePatternAware?: (
		parentConfirmed: boolean,
	) => Promise<SpeculativePrediction | undefined> | SpeculativePrediction | undefined;
	readonly onPatternResolved?: (outcome: string) => void;
	readonly flushPatternStore?: () => Promise<void> | void;
	readonly candidateSizeBytes?: () => number;
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
	const projectionRules: readonly ActionProjectionRule<string>[] = options.projectOutput
		? [
				{
					...READ_RANGE_ACTION_KEY_PROJECTOR,
					captureCoverage: (action, output) =>
						options.captureProjectionCoverage !== undefined
							? options.captureProjectionCoverage(action, output)
							: { end: readActionRange(action)?.end, complete: false },
					projectOutput: ({ actor, output, coverage, keyMatch }) => {
						const actorRange = readActionRange(actor);
						const realized = asRecord(coverage);
						if (!actorRange || !realized || typeof realized.end !== "number") return undefined;
						if (
							actorRange.offset > realized.end ||
							(realized.complete !== true && actorRange.end > realized.end)
						) {
							return undefined;
						}
						return options.projectOutput?.(output, keyMatch);
					},
					canShareInFlight: readRangesShareInFlight,
				},
			]
		: [];
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
			{ name: "write", description: "Write a file" },
		],
		stateData: () => ({ cwd: "/workspace" }),
		predict: (input, settings, _definitions, _candidateNames, signal) => options.predict(input, signal, settings),
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
		actual: (input) => ({ id: input.id, tool: input.tool, input: input.input }),
		preflightCandidate: ({ candidate, signal }) => options.preflight?.(candidate, signal) ?? { ok: true },
		...(options.authorize
			? {
					authorizeCandidate: ({ candidate, consumeInput }) =>
						options.authorize?.(candidate, consumeInput) ?? { ok: true },
				}
			: {}),
		...(options.prepare ? { prepareCandidate: ({ candidate, signal }) => options.prepare?.(candidate, signal) } : {}),
		executeCandidate: ({ candidate, signal }) => {
			executions++;
			return options.execute?.(candidate, signal) ?? "prefetched";
		},
		...(options.captureResourceVersion ? { captureResourceVersion: () => options.captureResourceVersion?.() } : {}),
		...(options.releaseResourceVersion
			? { releaseResourceVersion: (version: unknown) => options.releaseResourceVersion?.(version) }
			: {}),
		...(options.watchResourceVersion ? { watchResourceVersion: () => options.watchResourceVersion?.() } : {}),
		...(options.isResourceExpired
			? { isResourceExpired: (input) => options.isResourceExpired?.(input) ?? false }
			: {}),
		projectionRules,
		...(options.rejectCandidateOutput
			? { rejectCandidateOutput: ({ output }) => options.rejectCandidateOutput?.(output) }
			: {}),
		...(options.adopt ? { adoptCandidate: ({ output }) => options.adopt?.(output) } : {}),
		...(options.recordAuthoritative ? { recordAuthoritative: () => options.recordAuthoritative?.() } : {}),
		...(options.continuePatternAware
			? { continuePatternAware: ({ parentConfirmed }) => options.continuePatternAware?.(parentConfirmed) }
			: {}),
		...(options.onPatternResolved
			? { onPatternResolved: (_patternID, outcome) => options.onPatternResolved?.(outcome) }
			: {}),
		...(options.flushPatternStore ? { flushPatternStore: () => options.flushPatternStore?.() } : {}),
		...(options.candidateSizeBytes ? { candidateSizeBytes: () => options.candidateSizeBytes?.() ?? 0 } : {}),
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

	it("runs preparation hints without delaying the drafter", async () => {
		const preparationStarted = deferred<void>();
		const releasePreparation = deferred<void>();
		let drafterCalls = 0;
		const harness = createHarness({
			settings: {
				...enabledSettings,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
				tools: { resourceCached: ["read"], sandbox: ["bash"] },
			},
			predictPatternAware: () =>
				prediction({
					type: "preparation_hint",
					tool: "bash",
					input: {},
					missing: [["command"]],
					source: "pattern_aware",
					empiricalProbability: 1,
				}),
			prepare: async () => {
				preparationStarted.resolve(undefined);
				await releasePreparation.promise;
			},
			predict: () => {
				drafterCalls++;
				return prediction();
			},
		});

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-hint-background" });
		await preparationStarted.promise;
		await waitFor(() => drafterCalls === 1);
		releasePreparation.resolve(undefined);

		expect(harness.executions()).toBe(0);
	});

	it("interrupts unfinished preparation hints when the turn closes", async () => {
		const preparationStarted = deferred<void>();
		const preparationInterrupted = deferred<void>();
		const harness = createHarness({
			settings: {
				...enabledSettings,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
				tools: { resourceCached: ["read"], sandbox: ["bash"] },
			},
			predictPatternAware: () =>
				prediction({
					type: "preparation_hint",
					tool: "bash",
					input: {},
					missing: [["command"]],
					source: "pattern_aware",
					empiricalProbability: 1,
				}),
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
			predict: () => prediction(),
		});

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-hint-cancel" });
		await preparationStarted.promise;
		await harness.runtime.finishTurn(consumeTool("turn-hint-cancel", "bash", {}));

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
		let releases = 0;
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: [], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("safe bash")),
			captureResourceVersion: () => "snapshot",
			releaseResourceVersion: () => {
				releases++;
			},
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
		expect(releases).toBe(1);
	});

	it("keeps one drafter challenger when PatternAware has an immediate candidate", async () => {
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

			expect(drafterCalls).toBe(1);
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

	it("offers each predictor the full proposal width while enforcing one top-k pool", async () => {
		let drafterCandidateLimit = 0;
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
					empiricalProbability: 1,
				}),
			predict: (_input, _signal, settings) => {
				drafterCandidateLimit = settings.candidateLimit ?? 0;
				return prediction(readCandidate("draft-one.txt"), readCandidate("draft-two.txt"));
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-cumulative-limit" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(harness.executions()).toBe(2);
		expect(drafterCandidateLimit).toBe(2);
	});

	it("lets a higher-utility drafter action replace a weaker PatternAware action", async () => {
		const executed: string[] = [];
		const harness = createHarness({
			settings: {
				...enabledSettings,
				candidateLimit: 1,
				maxConcurrentActions: 2,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
			},
			predictPatternAware: () =>
				prediction({
					...readCandidate("pattern.txt"),
					source: "pattern_aware",
					patternID: "weak-pattern",
					horizon: 0,
					empiricalProbability: 0.2,
					expectedDurationMs: 10,
				}),
			predict: () => prediction({ ...readCandidate("draft.txt"), expectedDurationMs: 100 }),
			execute: (candidate, signal) => {
				const candidatePath = String((candidate.input as { path: string }).path);
				if (candidatePath === "draft.txt") {
					executed.push(candidatePath);
					return candidatePath;
				}
				return new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("preempted")), { once: true });
				});
			},
		});

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-utility-arbitration" });
		await waitFor(() => executed.includes("draft.txt"));

		expect(executed).toEqual(["draft.txt"]);
		expect(harness.events).toContainEqual(
			expect.objectContaining({
				type: "cancelled",
				tool: "read",
				reason: "candidate_budget_preempted",
			}),
		);
	});

	it("keeps the unified proposal width finite when PatternAware reports malformed probability", async () => {
		let drafterCandidateLimit: number | undefined;
		const harness = createHarness({
			settings: {
				...enabledSettings,
				candidateLimit: 3,
				maxConcurrentActions: 3,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
			},
			predictPatternAware: () =>
				prediction({
					...readCandidate("pattern.txt"),
					source: "pattern_aware",
					patternID: "malformed-pattern",
					horizon: 0,
					empiricalProbability: Number.NaN,
				}),
			predict: (_input, _signal, settings) => {
				drafterCandidateLimit = settings.candidateLimit;
				return prediction();
			},
		});

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-malformed-coverage" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(drafterCandidateLimit).toBe(3);
		expect(Number.isFinite(drafterCandidateLimit)).toBe(true);
	});

	it("shares actor lead time across predictors and prioritizes latency that can be hidden", async () => {
		let now = 1_000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const seedExecution = deferred<string>();
		const executed: string[] = [];
		const harness = createHarness({
			settings: {
				...enabledSettings,
				candidateLimit: 2,
				maxConcurrentActions: 1,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: true },
				tools: { resourceCached: ["read"], sandbox: ["bash"] },
			},
			predictPatternAware: (input) =>
				input.turnID === "turn-lead-seed"
					? prediction({
							...bashCandidate("seed"),
							source: "pattern_aware",
							patternID: "lead-seed",
							horizon: 0,
							empiricalProbability: 1,
							expectedDurationMs: 100,
						})
					: prediction(),
			predict: (input) =>
				input.turnID === "turn-lead-seed"
					? prediction()
					: prediction(
							{ ...bashCandidate("late"), expectedDurationMs: 100 },
							{ ...readCandidate("hideable.txt"), expectedDurationMs: 90 },
						),
			execute: (candidate) => {
				const input = candidate.input as Record<string, unknown>;
				const identifier = candidate.tool === "bash" ? String(input.command) : String(input.path);
				executed.push(`${candidate.tool}:${identifier}`);
				return identifier === "seed" ? seedExecution.promise : candidate.tool;
			},
		});

		try {
			await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-lead-seed" });
			await waitFor(() => executed.length === 1);
			now = 1_010;
			const seedResult = harness.runtime.consume(consumeTool("turn-lead-seed", "bash", { command: "seed" }));
			now = 1_100;
			seedExecution.resolve("bash");
			expect(await seedResult).toBe("bash");
			await harness.runtime.finishTurn(consumeTool("turn-lead-seed", "bash", {}));

			now = 1_200;
			await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-lead-rank" });
			await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

			expect(executed).toEqual(["bash:seed", "read:hideable.txt"]);
			expect(harness.events).toContainEqual(
				expect.objectContaining({ type: "hit", actorLeadMs: 10, source: "pattern_aware" }),
			);
			expect(harness.events).toContainEqual(
				expect.objectContaining({
					type: "cancelled",
					tool: "bash",
					expectedLeadMs: 10,
					reason: "scheduler_budget_exhausted",
				}),
			);
		} finally {
			await harness.runtime.releaseSession("session");
			nowSpy.mockRestore();
		}
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

	it("publishes separate in-flight job and completed result snapshots before a hit", async () => {
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
			cacheEntries: 0,
			cacheCapacity: 7,
			cacheRunning: 0,
			cacheCompleted: 0,
			cacheProbation: 0,
			cacheProtected: 0,
			inFlightJobs: 1,
			resultEntries: 0,
			branchEntries: 0,
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
			cacheProbation: 1,
			cacheProtected: 0,
			inFlightJobs: 0,
			resultEntries: 1,
			branchEntries: 0,
			activeCandidates: 0,
		});
		expect(harness.events.find((event) => event.type === "hit")).toMatchObject({
			cacheProbation: 0,
			cacheProtected: 1,
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
			cacheProbation: 1,
			cacheProtected: 0,
		});
	});

	it("moves an exclusive turn job into the branch store without cache probation", async () => {
		const harness = createHarness({
			settings: {
				...enabledSettings,
				tools: { resourceCached: ["read"], sandbox: ["bash"] },
			},
			predict: () => prediction(bashCandidate("echo ready")),
			execute: () => "ready",
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-sandbox-cache" });
		await waitFor(() => harness.events.some((event) => event.type === "started"));

		expect(harness.events.find((event) => event.type === "started")).toMatchObject({
			cacheEntries: 0,
			cacheProbation: 0,
			cacheProtected: 0,
			inFlightJobs: 1,
			branchEntries: 0,
			turnCandidates: 1,
			resourceCandidates: 0,
		});
		await waitFor(() => harness.events.some((event) => event.type === "completed"));
		expect(harness.events.find((event) => event.type === "completed")).toMatchObject({
			cacheEntries: 0,
			cacheProbation: 0,
			inFlightJobs: 0,
			branchEntries: 1,
			turnCandidates: 1,
		});
		await harness.runtime.finishTurn(consume("turn-sandbox-cache", {}));
	});

	it("keeps a completed sandbox branch independent from a capacity-one result cache", async () => {
		const harness = createHarness({
			settings: {
				...enabledSettings,
				candidateLimit: 2,
				maxConcurrentActions: 2,
				resourceCacheMaxEntries: 1,
				tools: { resourceCached: ["read"], sandbox: ["bash"] },
			},
			predict: () => prediction(readCandidate("a.ts"), bashCandidate("echo staged")),
			execute: (candidate) => candidate.tool,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "separate-stores" });
		await waitFor(() => harness.events.filter((event) => event.type === "completed").length === 2);

		const completed = harness.events.filter((event) => event.type === "completed").at(-1);
		expect(completed).toMatchObject({
			cacheEntries: 1,
			resultEntries: 1,
			branchEntries: 1,
			inFlightJobs: 0,
			cacheProbation: 1,
			turnCandidates: 1,
			resourceCandidates: 1,
		});
		expect(harness.runtime.inspect("session")).toMatchObject({ turnCandidates: 1, resourceCandidates: 1 });
		await harness.runtime.finishTurn(consume("separate-stores", {}));
	});

	it("evicts unconsumed probation before an actor-validated protected result", async () => {
		const harness = createHarness({
			settings: {
				...enabledSettings,
				adaptiveDrafter: false,
				resourceCacheMaxEntries: 2,
				// Keep package-suite scheduling delays from turning an eviction test into a timeout test.
				predictionTimeoutMs: 5_000,
			},
			predict: (input) => {
				if (input.turnID === "seed-protected") return prediction(readCandidate("a.txt"));
				if (input.turnID === "seed-probation") return prediction(readCandidate("b.txt"));
				if (input.turnID === "apply-pressure") return prediction(readCandidate("c.txt"));
				return prediction();
			},
			execute: (candidate) => String((candidate.input as { path: string }).path),
		});

		await harness.runtime.startTurn({ sessionID: "session", turnID: "seed-protected" });
		await waitFor(() => harness.events.filter((event) => event.type === "completed").length >= 1);
		expect(harness.events.filter((event) => event.type === "completed")).toHaveLength(1);
		// Give the actor a deterministic lead interval so adaptive scheduling does not
		// classify the following cache candidates as zero-benefit on a fast clock.
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(await harness.runtime.consume(consume("seed-protected", { path: "a.txt" }))).toBe("a.txt");
		await harness.runtime.finishTurn(consume("seed-protected", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "seed-probation" });
		await waitFor(() => harness.events.filter((event) => event.type === "completed").length >= 2);
		expect(harness.events.filter((event) => event.type === "completed")).toHaveLength(2);
		await harness.runtime.finishTurn(consume("seed-probation", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "apply-pressure" });
		await waitFor(() => harness.events.filter((event) => event.type === "completed").length >= 3);
		expect(harness.events.filter((event) => event.type === "completed")).toHaveLength(3);
		await harness.runtime.finishTurn(consume("apply-pressure", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "check-protected" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("check-protected", { path: "a.txt" }))).toBe("a.txt");
		await harness.runtime.finishTurn(consume("check-protected", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "check-probation" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("check-probation", { path: "b.txt" }))).toBeUndefined();
		expect(harness.executions()).toBe(3);
		expect(harness.events).toContainEqual(
			expect.objectContaining({ type: "cancelled", reason: "resource_cache_evicted" }),
		);
	});

	it("does not promote or refresh a candidate reused only by later predictions", async () => {
		const harness = createHarness({
			settings: { ...enabledSettings, adaptiveDrafter: false, resourceCacheMaxEntries: 1 },
			predict: (input) => {
				if (input.turnID === "seed") return prediction(readCandidate("a.txt"));
				if (input.turnID === "prediction-reuse") return prediction(readCandidate("a.txt"));
				if (input.turnID === "pressure") return prediction(readCandidate("b.txt"));
				return prediction();
			},
			execute: (candidate) => String((candidate.input as { path: string }).path),
		});

		for (const turnID of ["seed", "prediction-reuse", "pressure"]) {
			await harness.runtime.startTurn({ sessionID: "session", turnID });
			await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);
			await harness.runtime.finishTurn(consume(turnID, {}));
		}
		await harness.runtime.startTurn({ sessionID: "session", turnID: "check" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("check", { path: "a.txt" }))).toBeUndefined();
		expect(harness.executions()).toBe(2);
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

	it("registers one single-flight job when concurrent turns finish preflight together", async () => {
		const releasePreflight = deferred<CandidatePreflight>();
		let preflights = 0;
		const harness = createHarness({
			predict: () => prediction(readCandidate("shared-race.txt")),
			preflight: async () => {
				preflights++;
				return releasePreflight.promise;
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-race-a" });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-race-b" });
		await waitFor(() => preflights === 2);
		releasePreflight.resolve({ ok: true });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-race-b", { path: "shared-race.txt" }))).toBe("prefetched");
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
	});

	it("atomically coalesces a narrower turn onto a broader read after concurrent preflight", async () => {
		const releasePreflight = deferred<CandidatePreflight>();
		const broadExecution = deferred<string>();
		let preflights = 0;
		const harness = createHarness({
			predict: (input) =>
				input.turnID === "turn-broad-race"
					? prediction(readCandidate("race.txt", 1, 200))
					: input.turnID === "turn-narrow-race"
						? prediction(readCandidate("race.txt", 100, 10))
						: prediction(),
			preflight: async () => {
				preflights++;
				return releasePreflight.promise;
			},
			execute: () => broadExecution.promise,
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-broad-race" });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-narrow-race" });
		await waitFor(() => preflights === 2);
		releasePreflight.resolve({ ok: true });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);
		await waitFor(() => harness.executions() >= 1);

		const result = harness.runtime.consume(consume("turn-narrow-race", { path: "race.txt", offset: 100, limit: 10 }));
		broadExecution.resolve("broad-result");
		expect(await result).toBe("projected:broad-result");
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
	});

	it("never coalesces a broader read onto a narrower concurrent in-flight job", async () => {
		const releasePreflight = deferred<CandidatePreflight>();
		const narrowExecution = deferred<string>();
		const broadExecution = deferred<string>();
		const startedLimits: number[] = [];
		let preflights = 0;
		const harness = createHarness({
			predict: (input) =>
				input.turnID === "turn-narrow-first"
					? prediction(readCandidate("race.txt", 100, 10))
					: input.turnID === "turn-broad-second"
						? prediction(readCandidate("race.txt", 1, 200))
						: prediction(),
			preflight: async () => {
				preflights++;
				return releasePreflight.promise;
			},
			execute: (candidate) => {
				const limit = (candidate.input as { limit: number }).limit;
				startedLimits.push(limit);
				return limit === 10 ? narrowExecution.promise : broadExecution.promise;
			},
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-narrow-first" });
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-broad-second" });
		await waitFor(() => preflights === 2);
		releasePreflight.resolve({ ok: true });
		await waitFor(() => harness.executions() >= 2);

		const result = harness.runtime.consume(consume("turn-broad-second", { path: "race.txt", offset: 1, limit: 200 }));
		narrowExecution.resolve("narrow-result");
		broadExecution.resolve("broad-result");
		expect(await result).toBe("broad-result");
		expect(startedLimits).toEqual([10, 200]);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("does not coalesce onto a completed read whose realized coverage rejects projection", async () => {
		const harness = createHarness({
			predict: (input) =>
				input.turnID === "turn-short-coverage"
					? prediction(readCandidate("partial.txt", 1, 200))
					: input.turnID === "turn-uncovered-request"
						? prediction(readCandidate("partial.txt", 100, 10))
						: prediction(),
			execute: (candidate) => {
				const input = candidate.input as { offset: number; limit: number };
				return `${input.offset}:${input.limit}`;
			},
			captureProjectionCoverage: () => ({ end: 50, complete: false }),
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-short-coverage" });
		await waitFor(() => harness.events.filter((event) => event.type === "completed").length === 1);
		await harness.runtime.finishTurn(consume("turn-short-coverage", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-uncovered-request" });
		await waitFor(() => harness.executions() >= 2);
		expect(
			await harness.runtime.consume(
				consume("turn-uncovered-request", { path: "partial.txt", offset: 100, limit: 10 }),
			),
		).toBe("100:10");
		expect(harness.executions()).toBe(2);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("reuses a containing read candidate from the same draft batch", async () => {
		let projector: string | undefined;
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100), readCandidate("README.md", 1, 60)),
			execute: () => "lines-1-100",
			projectOutput: (output, keyMatch) => {
				projector = keyMatch.projector;
				return `projected:${output}`;
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(await harness.runtime.consume(consume("turn-1", { path: "README.md", offset: 1, limit: 60 }))).toBe(
			"projected:lines-1-100",
		);
		expect(projector).toBe("read.range");
		expect(harness.executions()).toBe(1);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(1);
	});

	it("chooses the tightest cached read that contains the actor range", async () => {
		const harness = createHarness({
			predict: (input) => {
				if (input.turnID === "turn-wide") return prediction(readCandidate("README.md", 1, 200));
				if (input.turnID === "turn-tight") return prediction(readCandidate("README.md", 100, 110));
				return prediction();
			},
			execute: (candidate) => {
				const input = candidate.input as { offset: number; limit: number };
				return `${input.offset}:${input.limit}`;
			},
			projectOutput: (output) => output,
		});
		for (const turnID of ["turn-wide", "turn-tight"]) {
			await harness.runtime.startTurn({ sessionID: "session", turnID });
			await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);
			await harness.runtime.finishTurn(consume(turnID, {}));
		}
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-project" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);

		expect(
			await harness.runtime.consume(consume("turn-project", { path: "README.md", offset: 120, limit: 10 })),
		).toBe("100:110");
		expect(harness.executions()).toBe(2);
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

	it("rejects a projected hit when execution produced no coverage proof", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100)),
			execute: () => "lines-1-100",
			captureProjectionCoverage: () => undefined,
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-no-coverage" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(
			await harness.runtime.consume(consume("turn-no-coverage", { path: "README.md", offset: 20, limit: 10 })),
		).toBeUndefined();
		expect(harness.events).toContainEqual(expect.objectContaining({ type: "miss", reason: "projection_failed" }));
	});

	it("fails closed when a projection rule cannot reconstruct the actor output", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100)),
			execute: () => "lines-1-100",
			projectOutput: () => undefined,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-reconstruction-fails" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(
			await harness.runtime.consume(
				consume("turn-reconstruction-fails", { path: "README.md", offset: 20, limit: 10 }),
			),
		).toBeUndefined();
		expect(harness.events).toContainEqual(expect.objectContaining({ type: "miss", reason: "projection_failed" }));
	});

	it("uses realized complete coverage beyond the speculative request boundary", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100)),
			execute: () => "complete-file",
			captureProjectionCoverage: () => ({ end: 80, complete: true }),
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-complete-coverage" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(
			await harness.runtime.consume(consume("turn-complete-coverage", { path: "README.md", offset: 1, limit: 200 })),
		).toBe("projected:complete-file");
		expect(harness.executions()).toBe(1);
	});

	it("does not coalesce a running read that only completed coverage could prove", async () => {
		const release = deferred<string>();
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 100), readCandidate("README.md", 1, 200)),
			execute: () => release.promise,
			captureProjectionCoverage: () => ({ end: 80, complete: true }),
			projectOutput: (output) => output,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-directed-running" });
		await waitFor(() => harness.executions() === 2);
		release.resolve("complete-file");
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);

		expect(harness.executions()).toBe(2);
		expect(harness.events.filter((event) => event.type === "started")).toHaveLength(2);
	});

	it("falls through a failed tight projection to a broader valid candidate", async () => {
		let draftCalls = 0;
		const projectionOrder: string[] = [];
		const harness = createHarness({
			predict: () =>
				draftCalls++ === 0
					? prediction(readCandidate("README.md", 1, 200), readCandidate("README.md", 100, 110))
					: prediction(),
			execute: async (candidate) => {
				const limit = (candidate.input as { limit: number }).limit;
				if (limit === 110) await new Promise((resolve) => setTimeout(resolve, 10));
				return limit === 110 ? "tight-invalid" : "broad-valid";
			},
			projectOutput: (output) => {
				projectionOrder.push(output);
				return output === "tight-invalid" ? undefined : `projected:${output}`;
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-cascade-projection" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);

		expect(
			await harness.runtime.consume(
				consume("turn-cascade-projection", { path: "README.md", offset: 120, limit: 10 }),
			),
		).toBe("projected:broad-valid");
		expect(projectionOrder).toEqual(["tight-invalid", "broad-valid"]);
		expect(harness.events.filter((event) => event.type === "miss")).toHaveLength(0);
		expect(harness.events.find((event) => event.type === "hit")).toMatchObject({
			lookup: {
				candidateCount: 2,
				compatibleCount: 2,
				rejections: [{ reason: "view_not_covered", count: 1 }],
			},
		});
		await harness.runtime.finishTurn(consume("turn-cascade-projection", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-exact-after-projection" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);
		expect(
			await harness.runtime.consume(
				consume("turn-exact-after-projection", { path: "README.md", offset: 100, limit: 110 }),
			),
		).toBe("tight-invalid");
		expect(harness.executions()).toBe(2);
	});

	it("falls through a stale tight candidate to a fresh broader candidate", async () => {
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 200), readCandidate("README.md", 100, 110)),
			execute: async (candidate) => {
				const limit = (candidate.input as { limit: number }).limit;
				if (limit === 110) await new Promise((resolve) => setTimeout(resolve, 10));
				return limit === 110 ? "stale-tight" : "fresh-broad";
			},
			captureResourceVersion: () => "v1",
			isResourceExpired: ({ candidate }) => (candidate.input as { limit: number }).limit === 110,
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-cascade-stale" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);

		expect(
			await harness.runtime.consume(consume("turn-cascade-stale", { path: "README.md", offset: 120, limit: 10 })),
		).toBe("projected:fresh-broad");
		expect(harness.events.filter((event) => event.type === "hit")).toHaveLength(1);
		expect(harness.events.filter((event) => event.type === "miss")).toHaveLength(0);
		expect(harness.events.find((event) => event.type === "hit")).toMatchObject({
			lookup: { candidateCount: 2, compatibleCount: 2, rejections: [{ reason: "resource_expired", count: 1 }] },
		});
	});

	it("falls through a rejected candidate without deleting a reusable result", async () => {
		let draftCalls = 0;
		const harness = createHarness({
			predict: () =>
				draftCalls++ === 0
					? prediction(readCandidate("README.md", 1, 200), readCandidate("README.md", 100, 110))
					: prediction(),
			execute: async (candidate) => {
				const limit = (candidate.input as { limit: number }).limit;
				if (limit === 110) await new Promise((resolve) => setTimeout(resolve, 10));
				return limit === 110 ? "tight" : "broad";
			},
			authorize: (candidate, input) =>
				(candidate.input as { limit: number }).limit === 110 && input.input.offset === 120
					? { ok: false, reason: "candidate_permission_rejected" }
					: { ok: true },
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-cascade-authorization" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);

		expect(
			await harness.runtime.consume(
				consume("turn-cascade-authorization", { path: "README.md", offset: 120, limit: 10 }),
			),
		).toBe("projected:broad");
		expect(harness.events.find((event) => event.type === "hit")).toMatchObject({
			lookup: {
				candidateCount: 2,
				compatibleCount: 2,
				rejections: [{ reason: "candidate_permission_rejected", count: 1 }],
			},
		});
		await harness.runtime.finishTurn(consume("turn-cascade-authorization", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-authorized-exact" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);
		expect(
			await harness.runtime.consume(
				consume("turn-authorized-exact", { path: "README.md", offset: 100, limit: 110 }),
			),
		).toBe("tight");
		expect(harness.executions()).toBe(2);
	});

	it("falls through an in-flight execution failure to a ready candidate", async () => {
		const tightExecution = deferred<string>();
		const harness = createHarness({
			predict: () =>
				prediction(readCandidate("README.md", 1, 200), {
					...readCandidate("README.md", 100, 110),
					expectedDurationMs: 100,
				}),
			execute: (candidate) =>
				(candidate.input as { limit: number }).limit === 110 ? tightExecution.promise : "ready-broad",
			projectOutput: (output) => `projected:${output}`,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-cascade-execution" });
		await waitFor(() => harness.executions() === 2);
		const result = harness.runtime.consume(
			consume("turn-cascade-execution", { path: "README.md", offset: 120, limit: 10 }),
		);
		await Promise.resolve();
		tightExecution.reject(new Error("tight failed"));

		expect(await result).toBe("projected:ready-broad");
		expect(harness.events.filter((event) => event.type === "miss")).toHaveLength(0);
		expect(harness.events.find((event) => event.type === "hit")).toMatchObject({
			lookup: {
				candidateCount: 2,
				compatibleCount: 2,
				rejections: [{ reason: "candidate_execution_failed", count: 1 }],
			},
		});
	});

	it("reports aggregate K(a) mismatch reasons without copying action inputs into lookup telemetry", async () => {
		let draftCalls = 0;
		const harness = createHarness({
			predict: () =>
				draftCalls++ === 0
					? prediction(readCandidate("secret-name.ts", 20, 10), readCandidate("other.ts", 1, 100), {
							type: "tool_call",
							tool: "grep",
							input: { pattern: "private-pattern", path: "." },
						})
					: prediction(),
			execute: () => "cached",
			projectOutput: (output) => output,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-lookup-miss" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);

		expect(
			await harness.runtime.consume(consume("turn-lookup-miss", { path: "secret-name.ts", offset: 1, limit: 100 })),
		).toBeUndefined();
		await harness.runtime.finishTurn(consume("turn-lookup-miss", {}));

		const miss = harness.events.find((event) => event.type === "miss" && event.reason === "key_mismatch");
		expect(miss).toMatchObject({
			lookup: {
				candidateCount: 3,
				compatibleCount: 0,
				rejections: [
					{ reason: "different_core", count: 1 },
					{ reason: "different_tool", count: 1 },
					{ reason: "projection_not_applicable", count: 1 },
				],
			},
		});
		const lookup = miss && "lookup" in miss ? miss.lookup : undefined;
		expect(JSON.stringify(lookup)).not.toContain("secret-name");
		expect(JSON.stringify(lookup)).not.toContain("private-pattern");
	});

	it("discards a completed output rejected by the adapter before it enters the cache", async () => {
		let draftCalls = 0;
		const harness = createHarness({
			predict: () => (draftCalls++ === 0 ? prediction(readCandidate()) : prediction()),
			execute: () => "tool-error",
			rejectCandidateOutput: (output) => (output === "tool-error" ? "tool_error_result" : undefined),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-rejected-output" });
		await waitFor(() =>
			harness.events.some((event) => event.type === "cancelled" && event.reason === "tool_error_result"),
		);

		expect(await harness.runtime.consume(consume("turn-rejected-output"))).toBeUndefined();
		expect(harness.events.some((event) => event.type === "completed")).toBe(false);
		expect(harness.events.some((event) => event.type === "hit")).toBe(false);
		expect(harness.runtime.inspect("session").resourceCandidates).toBe(0);
		await harness.runtime.finishTurn(consume("turn-rejected-output", {}));

		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-after-rejected-output" });
		await waitFor(() => harness.runtime.inspect("session").pendingPredictions === 0);
		expect(await harness.runtime.consume(consume("turn-after-rejected-output"))).toBeUndefined();
		expect(harness.executions()).toBe(1);
	});

	it("wakes an actor waiting on an output that becomes non-cacheable and records the rejection", async () => {
		const execution = deferred<string>();
		const harness = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => execution.promise,
			rejectCandidateOutput: () => "tool_error_result",
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-running-rejected-output" });
		await waitFor(() => harness.executions() === 1);
		const result = harness.runtime.consume(consume("turn-running-rejected-output"));
		execution.resolve("tool-error");

		expect(await result).toBeUndefined();
		expect(harness.events.find((event) => event.type === "miss")).toMatchObject({
			reason: "tool_error_result",
			lookup: {
				candidateCount: 1,
				compatibleCount: 1,
				rejections: [{ reason: "tool_error_result", count: 1 }],
			},
		});
		expect(harness.events.some((event) => event.type === "hit")).toBe(false);
	});

	it("fails closed when output validation throws but accepts an output with no rejection reason", async () => {
		const rejected = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => "candidate",
			rejectCandidateOutput: () => {
				throw new Error("validator failed");
			},
		});
		await rejected.runtime.startTurn({ sessionID: "session", turnID: "turn-validator-error" });
		await waitFor(() =>
			rejected.events.some(
				(event) => event.type === "cancelled" && event.reason === "candidate_output_validation_failed",
			),
		);
		expect(await rejected.runtime.consume(consume("turn-validator-error"))).toBeUndefined();

		const accepted = createHarness({
			predict: () => prediction(readCandidate()),
			execute: () => "candidate",
			rejectCandidateOutput: () => undefined,
		});
		await accepted.runtime.startTurn({ sessionID: "session", turnID: "turn-validator-accepts" });
		await waitFor(() => accepted.executions() === 1);
		expect(await accepted.runtime.consume(consume("turn-validator-accepts"))).toBe("candidate");
	});

	it("prefers a completed high-value candidate over a just-started tighter candidate", async () => {
		const broadExecution = deferred<string>();
		const tightPreflight = deferred<CandidatePreflight>();
		const tightExecution = deferred<string>();
		const harness = createHarness({
			predict: () => prediction(readCandidate("README.md", 1, 200), readCandidate("README.md", 100, 110)),
			preflight: (candidate) =>
				(candidate.input as { limit: number }).limit === 110 ? tightPreflight.promise : { ok: true },
			execute: (candidate) =>
				(candidate.input as { limit: number }).limit === 110 ? tightExecution.promise : broadExecution.promise,
			projectOutput: (output) => output,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-rank-ready" });
		await waitFor(() => harness.executions() === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		broadExecution.resolve("broad-ready");
		await waitFor(() => harness.events.some((event) => event.type === "cache"));
		tightPreflight.resolve({ ok: true });
		await waitFor(() => harness.executions() === 2);

		expect(
			await harness.runtime.consume(consume("turn-rank-ready", { path: "README.md", offset: 120, limit: 10 })),
		).toBe("broad-ready");
		tightExecution.resolve("tight-late");
	});

	it("prefers a nearly completed high-value job over a cheap ready alternative", async () => {
		const tightExecution = deferred<string>();
		const broadPreflight = deferred<CandidatePreflight>();
		let actorSettled = false;
		const harness = createHarness({
			predict: () =>
				prediction(
					{ ...readCandidate("README.md", 100, 110), expectedDurationMs: 100 },
					readCandidate("README.md", 1, 200),
				),
			preflight: (candidate) =>
				(candidate.input as { offset: number }).offset === 1 ? broadPreflight.promise : { ok: true },
			execute: (candidate) =>
				(candidate.input as { offset: number }).offset === 100 ? tightExecution.promise : "broad-ready",
			projectOutput: (output) => output,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-rank-running" });
		await waitFor(() => harness.executions() === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		broadPreflight.resolve({ ok: true });
		await waitFor(() => harness.executions() === 2);
		await waitFor(() => harness.events.some((event) => event.type === "cache"));

		const result = harness.runtime
			.consume(consume("turn-rank-running", { path: "README.md", offset: 120, limit: 10 }))
			.then((output) => {
				actorSettled = true;
				return output;
			});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(actorSettled).toBe(false);
		tightExecution.resolve("tight-running");

		expect(await result).toBe("tight-running");
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
		await new Promise((resolve) => setTimeout(resolve, 5));
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

	it("drops late PatternAware hints after a terminal turn finishes", async () => {
		const late = deferred<SpeculativePrediction>();
		let preparations = 0;
		const harness = createHarness({
			settings: {
				...enabledSettings,
				drafterEnabled: false,
				patternAware: PATTERN_AWARE_DEFAULTS,
			},
			predict: () => prediction(),
			predictPatternAware: () => late.promise,
			prepare: () => {
				preparations++;
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "late-pattern" });
		await harness.runtime.finishTurn({
			sessionID: "session",
			turnID: "late-pattern",
			tool: "read",
			input: {},
			terminal: true,
		});

		late.resolve(
			prediction({
				type: "preparation_hint",
				tool: "read",
				input: { path: "late.ts" },
				missing: [["path"]],
				patternID: "late-hint",
			}),
		);
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		await Promise.resolve();

		expect(preparations).toBe(0);
		expect(harness.executions()).toBe(0);
		expect(harness.runtime.inspect("session").resourceCandidates).toBe(0);
	});

	it("closes a carried exclusive PatternAware candidate when a later terminal event has no turn state", async () => {
		const resolutions: string[] = [];
		let flushes = 0;
		const harness = createHarness({
			settings: {
				...enabledSettings,
				drafterEnabled: false,
				patternAware: PATTERN_AWARE_DEFAULTS,
				tools: { resourceCached: ["read"], sandbox: ["bash"] },
			},
			predict: () => prediction(),
			predictPatternAware: () =>
				prediction({
					...bashCandidate("printf ready"),
					patternID: "carried-bash",
					horizon: 2,
				}),
			onPatternResolved: (outcome) => resolutions.push(outcome),
			flushPatternStore: () => {
				flushes++;
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "carry-source" });
		await waitFor(() => harness.events.some((event) => event.type === "completed"));
		await harness.runtime.finishTurn(consumeTool("carry-source", "bash", {}));
		expect(harness.events.some((event) => event.type === "cancelled")).toBe(false);

		await harness.runtime.finishTurn({
			sessionID: "session",
			turnID: "later-terminal",
			tool: "read",
			input: {},
			terminal: true,
		});

		expect(harness.runtime.inspect("session").resourceCandidates).toBe(0);
		expect(resolutions).toEqual(["actor_miss"]);
		expect(flushes).toBe(1);
		expect(
			harness.events.some((event) => event.type === "cancelled" && event.reason === "request_finished_without_hit"),
		).toBe(true);
	});

	it("keeps an adopted hit authoritative when PatternAware bookkeeping throws", async () => {
		const harness = createHarness({
			settings: { ...enabledSettings, patternAware: PATTERN_AWARE_DEFAULTS },
			predict: () => prediction(readCandidate("README.md")),
			recordAuthoritative: () => {
				throw new Error("analyzer failed");
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "bookkeeping-failure" });
		await waitFor(() => harness.executions() === 1);

		await expect(harness.runtime.consume(consume("bookkeeping-failure", { path: "README.md" }))).resolves.toBe(
			"prefetched",
		);
		expect(harness.events.some((event) => event.type === "hit")).toBe(true);
	});

	it("contains continuation admission failures after a confirmed PatternAware hit", async () => {
		const confirmations: boolean[] = [];
		const harness = createHarness({
			settings: {
				...enabledSettings,
				drafterEnabled: false,
				patternAware: PATTERN_AWARE_DEFAULTS,
			},
			predict: () => prediction(),
			predictPatternAware: () =>
				prediction({ ...readCandidate("parent.ts"), patternID: "parent-pattern", horizon: 1 }),
			continuePatternAware: (parentConfirmed) => {
				confirmations.push(parentConfirmed);
				return parentConfirmed
					? prediction({ ...readCandidate("explode.ts"), patternID: "child-pattern", horizon: 0 })
					: undefined;
			},
			actionKey: (tool, input, _context) => {
				if (asRecord(input)?.path === "explode.ts") throw new Error("child key failed");
				return buildPiActionKey(tool, input, "/workspace");
			},
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "continuation-failure" });
		await waitFor(() => harness.executions() === 1);

		await expect(harness.runtime.consume(consume("continuation-failure", { path: "parent.ts" }))).resolves.toBe(
			"prefetched",
		);
		expect(confirmations).toEqual([false, true]);
	});

	it("invalidates overlapping shared results after sandbox adoption without relying on commit metrics", async () => {
		const harness = createHarness({
			settings: {
				...enabledSettings,
				patternAware: { ...PATTERN_AWARE_DEFAULTS, enabled: false },
				tools: { resourceCached: ["read"], sandbox: ["write"] },
			},
			predict: (input) => {
				if (input.turnID === "seed-read") return prediction(readCandidate("target.ts"));
				if (input.turnID === "adopt-write") {
					return prediction({ type: "tool_call", tool: "write", input: { path: "target.ts", content: "new" } });
				}
				return prediction();
			},
			adopt: (output) => output,
		});

		await harness.runtime.startTurn({ sessionID: "session", turnID: "seed-read" });
		await waitFor(() => harness.events.some((event) => event.type === "completed"));
		await harness.runtime.finishTurn(consume("seed-read", {}));
		expect(harness.runtime.inspect("session").resourceCandidates).toBe(1);

		await harness.runtime.startTurn({ sessionID: "session", turnID: "adopt-write" });
		await waitFor(() => harness.executions() === 2);
		await expect(
			harness.runtime.consume(consumeTool("adopt-write", "write", { path: "target.ts", content: "new" })),
		).resolves.toBe("prefetched");
		expect(harness.runtime.inspect("session").resourceCandidates).toBe(0);

		await harness.runtime.startTurn({ sessionID: "session", turnID: "verify-read" });
		await waitFor(() => harness.runtime.inspect().pendingPredictions === 0);
		await expect(harness.runtime.consume(consume("verify-read", { path: "target.ts" }))).resolves.toBeUndefined();
	});

	it("normalizes non-finite prediction metadata and cache accounting", async () => {
		const malformed: SpeculativeDraftCandidate = {
			...readCandidate("numbers.ts"),
			empiricalProbability: Number.NaN,
			conditionalProbability: Number.POSITIVE_INFINITY,
			expectedDurationMs: Number.NaN,
			expectedLatencyBenefitMs: Number.POSITIVE_INFINITY,
			resourceDemand: Number.NaN,
			horizon: Number.NaN,
			depth: Number.NaN,
		};
		const harness = createHarness({
			predict: () => ({ candidates: [malformed], draftTokens: Number.NaN }),
			candidateSizeBytes: () => Number.NaN,
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "non-finite" });
		await waitFor(() => harness.events.some((event) => event.type === "completed"));

		const started = harness.events.find((event) => event.type === "started");
		expect(started).toMatchObject({
			type: "started",
			draftTokens: 0,
			totalDraftTokens: 0,
			expectedDurationMs: expect.any(Number),
			expectedBenefitMs: expect.any(Number),
			resourceUnits: expect.any(Number),
			schedulerUtility: expect.any(Number),
		});
		if (started?.type !== "started") throw new Error("expected started event");
		for (const value of [
			started.expectedDurationMs,
			started.expectedBenefitMs,
			started.resourceUnits,
			started.schedulerUtility,
			started.cacheBytes,
		]) {
			expect(Number.isFinite(value)).toBe(true);
		}
		expect(started.empiricalProbability).toBeUndefined();
		expect(started.conditionalProbability).toBeUndefined();
		expect(started.patternDepth).toBeUndefined();
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

	it("preserves provider call order when authoritative tools finish out of order", async () => {
		const observed: Array<{ id: string | undefined; order: number }> = [];
		const runtime = makeSpeculativeActionRuntime<
			string,
			string,
			StartInput,
			ConsumeInput,
			ConsumeInput,
			{ readonly cwd: string }
		>({
			settings: () => ({ ...enabledSettings, patternAware: PATTERN_AWARE_DEFAULTS }),
			definitions: () => [{ name: "read" }],
			stateData: () => ({ cwd: "." }),
			predict: () => prediction(),
			actionKey: (tool, input) => buildPiActionKey(tool, input, "/workspace"),
			actual: (input) => ({ id: input.id, tool: input.tool, input: input.input }),
			preflightCandidate: () => ({ ok: true }),
			executeCandidate: () => "unused",
			recordAuthoritative: ({ consumeInput, order }) => {
				observed.push({ id: consumeInput.id, order });
				return prediction();
			},
		});

		await runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await runtime.consume({
			sessionID: "session",
			turnID: "turn",
			id: "first",
			tool: "read",
			input: { path: "a.ts" },
		});
		await runtime.consume({
			sessionID: "session",
			turnID: "turn",
			id: "second",
			tool: "read",
			input: { path: "b.ts" },
		});
		await runtime.actual({
			sessionID: "session",
			turnID: "turn",
			id: "second",
			tool: "read",
			input: { path: "b.ts" },
			durationMs: 1,
			output: "b",
		});
		await runtime.actual({
			sessionID: "session",
			turnID: "turn",
			id: "first",
			tool: "read",
			input: { path: "a.ts" },
			durationMs: 1,
			output: "a",
		});

		expect(observed).toEqual([
			{ id: "second", order: 2 },
			{ id: "first", order: 1 },
		]);
	});

	it("releases a deleted session without publishing stale lifecycle events", async () => {
		let releases = 0;
		const harness = createHarness({
			predict: () => prediction(readCandidate("session.txt")),
			captureResourceVersion: () => ({ version: 1 }),
			releaseResourceVersion: () => {
				releases++;
			},
			execute: () => new Promise<string>(() => {}),
		});
		await harness.runtime.startTurn({ sessionID: "session", turnID: "turn-delete" });
		await waitFor(() => harness.executions() === 1);

		await harness.runtime.releaseSession("session");

		expect(releases).toBe(1);
		expect(harness.events.filter((event) => event.type === "cancelled")).toHaveLength(0);
		expect(harness.runtime.inspect("session")).toEqual({
			activeTurns: 0,
			turnCandidates: 0,
			resourceCandidates: 0,
			pendingPredictions: 0,
		});
	});
});

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
} {
	let resolvePromise: (value: T) => void = () => {};
	let rejectPromise: (reason: unknown) => void = () => {};
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
