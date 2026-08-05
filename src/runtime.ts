import type { ActionKey, CandidateLifetime, DrafterToolDefinition, SpeculativeExecution } from "./common.ts";
import { actionKeyMatches, actionLifetime, clampMaxCandidates, inferredExecution, KEYABLE_TOOLS } from "./common.ts";

export interface SpeculativeActionSettings {
	readonly enabled: boolean;
	readonly mode: "predict_action_single_step";
	readonly maxCandidates: number;
	readonly resourceCacheMaxEntries: number;
	readonly predictionTimeoutMs: number;
	readonly tools: {
		readonly liveReadonly: readonly string[];
		readonly sandbox: readonly string[];
	};
}

export interface SpeculativeDraftCandidate {
	readonly type: "tool_call";
	readonly tool: string;
	readonly input: unknown;
	readonly execution?: SpeculativeExecution;
	readonly diagnostic?: string;
}

export interface SpeculativePrediction {
	readonly candidates: readonly SpeculativeDraftCandidate[];
	readonly draftTokens: number;
}

export interface CandidatePreflightAllowed {
	readonly ok: true;
}

export interface CandidatePreflightRejected {
	readonly ok: false;
	readonly reason: string;
	readonly detail?: string;
}

export type CandidatePreflight = CandidatePreflightAllowed | CandidatePreflightRejected;

export interface SpeculativeCandidate {
	readonly key: ActionKey;
	readonly lifetime: CandidateLifetime;
	readonly resourceVersion?: unknown;
	readonly draftCandidate: string;
	readonly predictedAction: string;
	readonly startedAt: number;
	readonly predictionLatencyMs: number;
	readonly draftTokens: number;
	readonly totalDraftTokens: number;
	completedAt?: number;
	executionMs?: number;
	consumed: boolean;
}

interface SpeculativeEventBase<SessionID> {
	readonly sessionID: SessionID;
	readonly turnID: string;
	readonly timestamp: number;
}

export type SpeculativeActionEvent<SessionID> =
	| (SpeculativeEventBase<SessionID> & {
			type: "started";
			tool: string;
			actionKeyHash: string;
			execution: SpeculativeExecution;
			predictionLatencyMs: number;
			draftTokens: number;
			totalDraftTokens: number;
			draftCandidate: string;
			predictedAction: string;
	  })
	| (SpeculativeEventBase<SessionID> & {
			type: "hit";
			tool: string;
			actionKeyHash: string;
			savedMs: number;
			waitedMs: number;
			predictionLatencyMs: number;
			draftTokens: number;
			totalDraftTokens: number;
			draftCandidate: string;
			predictedAction: string;
			actualAction: string;
	  })
	| (SpeculativeEventBase<SessionID> & {
			type: "miss";
			reason: string;
			tool?: string;
			actionKeyHash?: string;
			detail?: string;
			draftCandidate?: string;
			predictedAction?: string;
			actualAction?: string;
	  })
	| (SpeculativeEventBase<SessionID> & {
			type: "cancelled";
			reason: string;
			tool: string;
			actionKeyHash: string;
			detail?: string;
			draftCandidate: string;
			predictedAction: string;
	  });

interface TurnInput<SessionID> {
	readonly sessionID: SessionID;
	readonly turnID: string;
}

interface ActualToolCall {
	readonly tool: string;
	readonly input: unknown;
}

type MaybePromise<T> = T | Promise<T>;

export interface SpeculativeActionRuntimeAdapter<
	SessionID,
	Output,
	StartInput extends TurnInput<SessionID>,
	ConsumeInput extends TurnInput<SessionID>,
	StateData,
> {
	readonly settings: () => MaybePromise<SpeculativeActionSettings>;
	readonly definitions: (input: StartInput) => readonly DrafterToolDefinition[];
	readonly stateData: (input: StartInput) => MaybePromise<StateData>;
	readonly predict: (
		input: StartInput,
		settings: SpeculativeActionSettings,
		definitions: readonly DrafterToolDefinition[],
		candidateNames: readonly string[],
		signal: AbortSignal,
	) => MaybePromise<SpeculativePrediction>;
	readonly actionKey: (
		tool: string,
		input: unknown,
		context:
			| { readonly type: "start"; readonly startInput: StartInput; readonly data: StateData }
			| { readonly type: "consume"; readonly consumeInput: ConsumeInput },
	) => MaybePromise<ActionKey | undefined>;
	readonly actual: (input: ConsumeInput) => ActualToolCall;
	readonly preflightCandidate: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeDraftCandidate;
		readonly tool: string;
		readonly concrete: Record<string, unknown>;
		readonly action: ActionKey;
		readonly callID: string;
		readonly index: number;
		readonly signal: AbortSignal;
	}) => MaybePromise<CandidatePreflight>;
	readonly executeCandidate: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly candidate: SpeculativeDraftCandidate;
		readonly tool: string;
		readonly concrete: Record<string, unknown>;
		readonly action: ActionKey;
		readonly callID: string;
		readonly index: number;
		readonly signal: AbortSignal;
	}) => MaybePromise<Output>;
	readonly candidateLifetime?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeDraftCandidate;
		readonly tool: string;
		readonly concrete: Record<string, unknown>;
		readonly action: ActionKey;
		readonly callID: string;
		readonly index: number;
	}) => CandidateLifetime;
	readonly captureResourceVersion?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeDraftCandidate;
		readonly tool: string;
		readonly concrete: Record<string, unknown>;
		readonly action: ActionKey;
		readonly callID: string;
		readonly index: number;
	}) => MaybePromise<unknown>;
	readonly isResourceExpired?: (input: {
		readonly stateData: StateData;
		readonly consumeInput?: ConsumeInput;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
	}) => MaybePromise<boolean>;
	readonly projectOutput?: (input: {
		readonly stateData: StateData;
		readonly consumeInput: ConsumeInput;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
		readonly output: Output;
	}) => MaybePromise<Output | undefined>;
	readonly adoptCandidate?: (input: {
		readonly stateData: StateData;
		readonly consumeInput: ConsumeInput;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
		readonly output: Output;
	}) => MaybePromise<Output | undefined>;
	readonly onEvent?: (event: SpeculativeActionEvent<SessionID>) => MaybePromise<void>;
}

export interface SpeculativeRuntimeInspection {
	readonly activeTurns: number;
	readonly turnCandidates: number;
	readonly resourceCandidates: number;
	readonly pendingPredictions: number;
}

export interface SpeculativeActionRuntime<SessionID, Output, StartInput, ConsumeInput, FinishInput> {
	readonly startTurn: (input: StartInput, signal?: AbortSignal) => Promise<void>;
	readonly consume: (input: ConsumeInput, signal?: AbortSignal) => Promise<Output | undefined>;
	readonly finishTurn: (input: FinishInput) => Promise<void>;
	readonly disposeSession: (sessionID: SessionID) => Promise<void>;
	readonly dispose: () => Promise<void>;
	readonly inspect: (sessionID?: SessionID) => SpeculativeRuntimeInspection;
}

interface DeferredState<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly done: () => boolean;
}

type CandidateExecution<Output> =
	| { readonly ok: true; readonly output: Output }
	| { readonly ok: false; readonly error: unknown };

interface RuntimeCandidate<Output> extends SpeculativeCandidate {
	readonly execution: DeferredState<CandidateExecution<Output>>;
	readonly controller: AbortController;
}

interface TurnState<SessionID, Output, StateData> {
	readonly sessionID: SessionID;
	readonly turnID: string;
	readonly ready: DeferredState<void>;
	readonly candidates: Map<string, RuntimeCandidate<Output>>;
	readonly data: StateData;
	readonly predictionController: AbortController;
	finished: boolean;
	noCandidateReported: boolean;
	predictionTimedOut: boolean;
	predictionPending: boolean;
}

class PredictionTimeoutError extends Error {
	constructor() {
		super("Speculative prediction timed out");
		this.name = "PredictionTimeoutError";
	}
}

export function makeSpeculativeActionRuntime<
	SessionID,
	Output,
	StartInput extends TurnInput<SessionID>,
	ConsumeInput extends TurnInput<SessionID>,
	FinishInput extends TurnInput<SessionID>,
	StateData,
>(
	adapter: SpeculativeActionRuntimeAdapter<SessionID, Output, StartInput, ConsumeInput, StateData>,
): SpeculativeActionRuntime<SessionID, Output, StartInput, ConsumeInput, FinishInput> {
	const turns = new Map<string, TurnState<SessionID, Output, StateData>>();
	const resourceCandidates = new Map<string, RuntimeCandidate<Output>>();
	const tokenTotals = new Map<SessionID, number>();

	const turnKey = (input: TurnInput<SessionID>): string => `${String(input.sessionID)}:${input.turnID}`;
	const resourceKey = (sessionID: SessionID, key: ActionKey): string => `${String(sessionID)}:${key.key}`;
	const sessionPrefix = (sessionID: SessionID): string => `${String(sessionID)}:`;
	const resourceCacheLimit = (settings: SpeculativeActionSettings): number =>
		Number.isFinite(settings.resourceCacheMaxEntries) ? Math.max(1, Math.floor(settings.resourceCacheMaxEntries)) : 1;
	const touchResourceCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): void => {
		if (candidate.lifetime !== "resource") return;
		const key = resourceKey(state.sessionID, candidate.key);
		if (!resourceCandidates.has(key)) return;
		resourceCandidates.delete(key);
		resourceCandidates.set(key, candidate);
	};
	const trimResourceCandidates = (settings: SpeculativeActionSettings): void => {
		const limit = resourceCacheLimit(settings);
		while (resourceCandidates.size > limit) {
			const oldest = resourceCandidates.keys().next().value;
			if (oldest === undefined) return;
			resourceCandidates.delete(oldest);
		}
	};

	const emit = async (event: SpeculativeActionEvent<SessionID>): Promise<void> => {
		try {
			await adapter.onEvent?.(event);
		} catch {
			// Observability must never change tool execution semantics.
		}
	};

	const publishMiss = async (
		state: TurnState<SessionID, Output, StateData>,
		reason: string,
		key?: ActionKey,
		detail?: string,
		diagnostics: { draftCandidate?: string; predictedAction?: string; actualAction?: string } = {},
	): Promise<void> => {
		await emit({
			type: "miss",
			sessionID: state.sessionID,
			turnID: state.turnID,
			timestamp: Date.now(),
			reason,
			...(key ? { tool: key.tool, actionKeyHash: key.hash } : {}),
			...(detail ? { detail } : {}),
			...diagnostics,
		});
	};

	const publishCancelled = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason: string,
		detail?: string,
	): Promise<void> => {
		await emit({
			type: "cancelled",
			sessionID: state.sessionID,
			turnID: state.turnID,
			timestamp: Date.now(),
			reason,
			tool: candidate.key.tool,
			actionKeyHash: candidate.key.hash,
			draftCandidate: candidate.draftCandidate,
			predictedAction: candidate.predictedAction,
			...(detail ? { detail } : {}),
		});
	};

	const sessionResourceCandidates = (sessionID: SessionID): RuntimeCandidate<Output>[] => {
		const prefix = sessionPrefix(sessionID);
		return [...resourceCandidates.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, candidate]) => candidate);
	};

	const availableCandidates = (
		state: TurnState<SessionID, Output, StateData>,
	): Map<string, RuntimeCandidate<Output>> => {
		const candidates = new Map(state.candidates);
		for (const candidate of sessionResourceCandidates(state.sessionID)) candidates.set(candidate.key.key, candidate);
		return candidates;
	};

	const findCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		actual: ActionKey,
	): RuntimeCandidate<Output> | undefined => {
		const exact = state.candidates.get(actual.key) ?? resourceCandidates.get(resourceKey(state.sessionID, actual));
		if (exact) {
			touchResourceCandidate(state, exact);
			return exact;
		}
		if (!adapter.projectOutput) return undefined;
		for (const candidate of availableCandidates(state).values()) {
			if (candidate.consumed && candidate.lifetime === "turn") continue;
			if (actionKeyMatches(candidate.key, actual)) {
				touchResourceCandidate(state, candidate);
				return candidate;
			}
		}
		return undefined;
	};

	const cancelCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason: string,
		detail?: string,
	): Promise<void> => {
		candidate.consumed = true;
		state.candidates.delete(candidate.key.key);
		if (candidate.lifetime === "resource") resourceCandidates.delete(resourceKey(state.sessionID, candidate.key));
		candidate.controller.abort();
		await publishCancelled(state, candidate, reason, detail);
	};

	const cancelUnmatchedTurnCandidates = async (
		state: TurnState<SessionID, Output, StateData>,
		actual: ActionKey | undefined,
		reason: string,
	): Promise<void> => {
		for (const candidate of [...state.candidates.values()]) {
			if (candidate.consumed || candidate.lifetime === "resource") continue;
			if (actual && candidate.key.key === actual.key) continue;
			await cancelCandidate(state, candidate, reason);
		}
	};

	const expireCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): void => {
		candidate.consumed = true;
		state.candidates.delete(candidate.key.key);
		if (candidate.lifetime === "resource") resourceCandidates.delete(resourceKey(state.sessionID, candidate.key));
		candidate.controller.abort();
	};

	const findReusableDraftCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		action: ActionKey,
	): Promise<RuntimeCandidate<Output> | undefined> => {
		for (const candidate of availableCandidates(state).values()) {
			if (candidate.consumed && candidate.lifetime === "turn") continue;
			const matches =
				candidate.key.key === action.key ||
				(adapter.projectOutput !== undefined && actionKeyMatches(candidate.key, action));
			if (!matches) continue;
			if (await isExpired(adapter, state, undefined, action, candidate)) {
				expireCandidate(state, candidate);
				continue;
			}
			touchResourceCandidate(state, candidate);
			return candidate;
		}
		return undefined;
	};

	const runPrediction = async (
		input: StartInput,
		settings: SpeculativeActionSettings,
		definitions: readonly DrafterToolDefinition[],
		candidateNames: readonly string[],
		state: TurnState<SessionID, Output, StateData>,
	): Promise<void> => {
		let accepted = 0;
		let started = 0;
		const candidateLimit = clampMaxCandidates(settings.maxCandidates);
		const predictionStarted = Date.now();
		try {
			const prediction = await withTimeout(
				Promise.resolve(
					adapter.predict(input, settings, definitions, candidateNames, state.predictionController.signal),
				),
				Math.max(0, settings.predictionTimeoutMs),
				() => state.predictionController.abort(),
			);
			const predictionLatencyMs = Math.max(0, Date.now() - predictionStarted);
			const totalDraftTokens = (tokenTotals.get(input.sessionID) ?? 0) + prediction.draftTokens;
			tokenTotals.set(input.sessionID, totalDraftTokens);

			for (const [index, draft] of prediction.candidates.entries()) {
				if (state.finished || started >= candidateLimit) break;
				const concrete = asConcreteInput(draft.input);
				const draftCandidate = draftCandidateDiagnostic(draft);
				if (!concrete) {
					await publishMiss(state, "invalid_tool_call_input", undefined, undefined, { draftCandidate });
					continue;
				}
				if (!candidateNames.includes(draft.tool)) continue;
				const action = await adapter.actionKey(draft.tool, concrete, {
					type: "start",
					startInput: input,
					data: state.data,
				});
				const predictedAction = diagnosticAction(draft.tool, concrete, action);
				if (!action) {
					await publishMiss(state, "unsupported_tool_or_input", undefined, undefined, {
						draftCandidate,
						predictedAction,
					});
					continue;
				}
				const callID = `spec_${fastCandidateID(`${input.turnID}:${index}:${action.key}`)}`;
				const lifetime =
					adapter.candidateLifetime?.({
						startInput: input,
						data: state.data,
						settings,
						candidate: draft,
						tool: draft.tool,
						concrete,
						action,
						callID,
						index,
					}) ?? actionLifetime(action.tool);
				if (await findReusableDraftCandidate(state, action)) {
					accepted++;
					continue;
				}
				const execution = draft.execution ?? inferredExecution(draft.tool);
				if (execution !== action.execution) {
					await publishMiss(state, "execution_mismatch", action, undefined, { draftCandidate, predictedAction });
					continue;
				}

				const candidateController = new AbortController();
				const preflight = await adapter.preflightCandidate({
					startInput: input,
					data: state.data,
					settings,
					candidate: draft,
					tool: draft.tool,
					concrete,
					action,
					callID,
					index,
					signal: candidateController.signal,
				});
				if (!preflight.ok) {
					await publishMiss(state, preflight.reason, action, preflight.detail, {
						draftCandidate,
						predictedAction,
					});
					continue;
				}
				const resourceVersion = adapter.captureResourceVersion
					? await adapter.captureResourceVersion({
							startInput: input,
							data: state.data,
							settings,
							candidate: draft,
							tool: draft.tool,
							concrete,
							action,
							callID,
							index,
						})
					: undefined;
				if (state.finished) {
					candidateController.abort();
					break;
				}

				const executionState = deferred<CandidateExecution<Output>>();
				const candidate: RuntimeCandidate<Output> = {
					key: action,
					lifetime,
					resourceVersion,
					draftCandidate,
					predictedAction,
					startedAt: Date.now(),
					predictionLatencyMs,
					draftTokens: prediction.draftTokens,
					totalDraftTokens,
					consumed: false,
					execution: executionState,
					controller: candidateController,
				};
				state.candidates.set(action.key, candidate);
				if (lifetime === "resource") {
					const key = resourceKey(input.sessionID, action);
					resourceCandidates.delete(key);
					resourceCandidates.set(key, candidate);
					trimResourceCandidates(settings);
				}
				accepted++;
				started++;
				await emit({
					type: "started",
					sessionID: state.sessionID,
					turnID: state.turnID,
					timestamp: Date.now(),
					tool: action.tool,
					actionKeyHash: action.hash,
					execution: action.execution,
					predictionLatencyMs,
					draftTokens: prediction.draftTokens,
					totalDraftTokens,
					draftCandidate,
					predictedAction,
				});
				const executionStarted = Date.now();
				void Promise.resolve()
					.then(() =>
						adapter.executeCandidate({
							startInput: input,
							data: state.data,
							candidate: draft,
							tool: draft.tool,
							concrete,
							action,
							callID,
							index,
							signal: candidateController.signal,
						}),
					)
					.then(
						(output) => {
							candidate.completedAt = Date.now();
							candidate.executionMs = Math.max(0, candidate.completedAt - executionStarted);
							executionState.resolve({ ok: true, output });
						},
						(error: unknown) => {
							candidate.completedAt = Date.now();
							candidate.executionMs = Math.max(0, candidate.completedAt - executionStarted);
							executionState.resolve({ ok: false, error });
						},
					);
			}

			if (!prediction.candidates.length || accepted === 0) {
				state.noCandidateReported = true;
				await publishMiss(
					state,
					"no_candidate",
					undefined,
					prediction.candidates.length
						? "No drafter candidate passed validation, policy, and permission checks."
						: "Drafter returned no tool-call candidates.",
				);
			}
		} catch (error) {
			if (state.finished) return;
			if (error instanceof PredictionTimeoutError) state.predictionTimedOut = true;
			await publishMiss(
				state,
				error instanceof PredictionTimeoutError ? "prediction_timeout" : "drafter_error",
				undefined,
				errorDetail(error),
			);
		} finally {
			state.predictionPending = false;
			state.ready.resolve(undefined);
		}
	};

	const startTurn = async (input: StartInput, signal?: AbortSignal): Promise<void> => {
		const settings = await adapter.settings();
		const definitions = adapter.definitions(input);
		const candidateNames = candidateToolNames(settings);
		if (!settings.enabled || settings.mode !== "predict_action_single_step") return;
		if (!definitions.length || !candidateNames.length || signal?.aborted) return;

		const existing = turns.get(turnKey(input));
		if (existing) await finishState(existing);
		const state: TurnState<SessionID, Output, StateData> = {
			sessionID: input.sessionID,
			turnID: input.turnID,
			ready: deferred<void>(),
			candidates: new Map(),
			data: await adapter.stateData(input),
			predictionController: new AbortController(),
			finished: false,
			noCandidateReported: false,
			predictionTimedOut: false,
			predictionPending: true,
		};
		turns.set(turnKey(input), state);
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					void abortState(state, "turn_aborted");
				},
				{ once: true },
			);
		}
		void runPrediction(input, settings, definitions, candidateNames, state);
	};

	const consume = async (input: ConsumeInput, signal?: AbortSignal): Promise<Output | undefined> => {
		const state = turns.get(turnKey(input));
		if (!state || signal?.aborted) return undefined;
		const actualCall = adapter.actual(input);
		const actual = await adapter.actionKey(actualCall.tool, actualCall.input, {
			type: "consume",
			consumeInput: input,
		});
		const actualAction = diagnosticAction(actualCall.tool, actualCall.input, actual);
		if (!actual) {
			await publishMiss(
				state,
				(KEYABLE_TOOLS as readonly string[]).includes(actualCall.tool)
					? "unsupported_actual_input"
					: "unsupported_actual_tool",
				undefined,
				undefined,
				{ actualAction },
			);
			await cancelUnmatchedTurnCandidates(state, undefined, "explicit_miss");
			return undefined;
		}

		let candidate = findCandidate(state, actual);
		if (!candidate) {
			const settings = await adapter.settings();
			const deadline = Date.now() + Math.max(0, settings.predictionTimeoutMs);
			while (!candidate && !state.ready.done() && Date.now() < deadline && !signal?.aborted) {
				await delay(Math.min(25, Math.max(1, deadline - Date.now())), signal);
				candidate = findCandidate(state, actual);
			}
			candidate = findCandidate(state, actual);
		}

		if (!candidate) {
			const available = availableCandidates(state);
			if (available.size === 0) {
				if (!state.noCandidateReported && !state.predictionTimedOut) {
					state.noCandidateReported = true;
					await publishMiss(state, state.ready.done() ? "no_candidate" : "prediction_timeout", actual, undefined, {
						actualAction,
					});
				}
			} else {
				await publishMiss(state, "key_mismatch", actual, undefined, {
					actualAction,
					predictedAction: candidatesDiagnostic(available),
				});
			}
			await cancelUnmatchedTurnCandidates(state, actual, "explicit_miss");
			return undefined;
		}

		if (await isExpired(adapter, state, input, actual, candidate)) {
			await cancelCandidate(state, candidate, "resource_expired");
			await publishMiss(state, "resource_expired", actual, undefined, {
				actualAction,
				draftCandidate: candidate.draftCandidate,
				predictedAction: candidate.predictedAction,
			});
			return undefined;
		}

		const waitStarted = Date.now();
		const execution = await waitForCandidate(candidate.execution.promise, signal);
		if (!execution || signal?.aborted) return undefined;
		if (!execution.ok) {
			await cancelCandidate(state, candidate, "candidate_execution_failed", errorDetail(execution.error));
			await publishMiss(state, "candidate_execution_failed", actual, errorDetail(execution.error), {
				actualAction,
				draftCandidate: candidate.draftCandidate,
				predictedAction: candidate.predictedAction,
			});
			return undefined;
		}
		if (await isExpired(adapter, state, input, actual, candidate)) {
			await cancelCandidate(state, candidate, "resource_expired");
			await publishMiss(state, "resource_expired", actual, "Resource changed before result adoption.", {
				actualAction,
				draftCandidate: candidate.draftCandidate,
				predictedAction: candidate.predictedAction,
			});
			return undefined;
		}

		candidate.consumed = true;
		if (candidate.lifetime === "turn") state.candidates.delete(candidate.key.key);
		let output = execution.output;
		if (adapter.adoptCandidate) {
			const adopted = await adapter.adoptCandidate({
				stateData: state.data,
				consumeInput: input,
				action: actual,
				candidate,
				output,
			});
			if (adopted === undefined) {
				await publishMiss(state, "adoption_failed", actual, undefined, {
					actualAction,
					draftCandidate: candidate.draftCandidate,
					predictedAction: candidate.predictedAction,
				});
				return undefined;
			}
			output = adopted;
		}
		if (candidate.key.key !== actual.key) {
			const projected = await adapter.projectOutput?.({
				stateData: state.data,
				consumeInput: input,
				action: actual,
				candidate,
				output,
			});
			if (projected === undefined) {
				await publishMiss(state, "projection_failed", actual, undefined, {
					actualAction,
					draftCandidate: candidate.draftCandidate,
					predictedAction: candidate.predictedAction,
				});
				return undefined;
			}
			output = projected;
		}

		const waitedMs = Math.max(0, Date.now() - waitStarted);
		const executionMs = candidate.executionMs ?? Math.max(0, Date.now() - candidate.startedAt);
		await emit({
			type: "hit",
			sessionID: state.sessionID,
			turnID: state.turnID,
			timestamp: Date.now(),
			tool: actual.tool,
			actionKeyHash: actual.hash,
			savedMs: Math.max(0, executionMs - waitedMs),
			waitedMs,
			predictionLatencyMs: candidate.predictionLatencyMs,
			draftTokens: candidate.draftTokens,
			totalDraftTokens: candidate.totalDraftTokens,
			draftCandidate: candidate.draftCandidate,
			predictedAction: candidate.predictedAction,
			actualAction,
		});
		return output;
	};

	const finishState = async (state: TurnState<SessionID, Output, StateData>): Promise<void> => {
		if (state.finished) return;
		state.finished = true;
		state.predictionController.abort();
		turns.delete(turnKey(state));
		for (const candidate of [...state.candidates.values()]) {
			if (candidate.consumed || candidate.lifetime === "resource") continue;
			await cancelCandidate(state, candidate, "turn_finished_without_hit");
		}
	};

	const abortState = async (state: TurnState<SessionID, Output, StateData>, reason: string): Promise<void> => {
		if (state.finished) return;
		state.finished = true;
		state.predictionController.abort();
		turns.delete(turnKey(state));
		for (const candidate of [...state.candidates.values()]) {
			if (candidate.consumed) continue;
			await cancelCandidate(state, candidate, reason);
		}
	};

	const finishTurn = async (input: FinishInput): Promise<void> => {
		const state = turns.get(turnKey(input));
		if (state) await finishState(state);
	};

	const disposeSession = async (sessionID: SessionID): Promise<void> => {
		for (const state of [...turns.values()].filter((item) => item.sessionID === sessionID)) {
			await abortState(state, "session_disposed");
		}
		const stateForEvents = createDisposalState<SessionID, Output, StateData>(sessionID);
		for (const candidate of sessionResourceCandidates(sessionID)) {
			await cancelCandidate(stateForEvents, candidate, "session_disposed");
		}
		tokenTotals.delete(sessionID);
	};

	const dispose = async (): Promise<void> => {
		const sessions = new Set<SessionID>();
		for (const state of turns.values()) sessions.add(state.sessionID);
		for (const key of resourceCandidates.keys()) {
			for (const sessionID of tokenTotals.keys()) {
				if (key.startsWith(sessionPrefix(sessionID))) sessions.add(sessionID);
			}
		}
		for (const sessionID of sessions) await disposeSession(sessionID);
	};

	const inspect = (sessionID?: SessionID): SpeculativeRuntimeInspection => {
		const states = [...turns.values()].filter((state) => sessionID === undefined || state.sessionID === sessionID);
		const resources =
			sessionID === undefined
				? resourceCandidates.size
				: [...resourceCandidates.keys()].filter((key) => key.startsWith(sessionPrefix(sessionID))).length;
		return {
			activeTurns: states.length,
			turnCandidates: states.reduce((count, state) => count + state.candidates.size, 0),
			resourceCandidates: resources,
			pendingPredictions: states.filter((state) => state.predictionPending).length,
		};
	};

	return { startTurn, consume, finishTurn, disposeSession, dispose, inspect };
}

export function candidateToolNames(settings: SpeculativeActionSettings): readonly string[] {
	const liveReadonly = new Set(settings.tools.liveReadonly);
	const sandbox = new Set(settings.tools.sandbox);
	return KEYABLE_TOOLS.filter((tool) =>
		inferredExecution(tool) === "sandbox" ? sandbox.has(tool) : liveReadonly.has(tool),
	);
}

export function diagnosticAction(tool: string, input: unknown, key?: ActionKey): string {
	return diagnosticJson({
		tool,
		input,
		...(key
			? { actionKey: key.key, actionKeyHash: key.hash, execution: key.execution, resources: key.resources }
			: {}),
	});
}

export function diagnosticJson(value: unknown): string {
	try {
		return JSON.stringify(redactDiagnostics(value), null, 2).slice(0, 6000);
	} catch {
		return String(value).slice(0, 6000);
	}
}

function draftCandidateDiagnostic(candidate: SpeculativeDraftCandidate): string {
	if (candidate.diagnostic === undefined) return diagnosticJson(candidate);
	try {
		return diagnosticJson(JSON.parse(candidate.diagnostic) as unknown);
	} catch {
		return diagnosticJson(candidate.diagnostic);
	}
}

export function redactDiagnostics(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactDiagnostics);
	if (!value || typeof value !== "object") {
		return typeof value === "string" ? value.replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***") : value;
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			/api[_-]?key|token|secret|password|authorization/i.test(key) ? "[redacted]" : redactDiagnostics(item),
		]),
	);
}

async function isExpired<
	SessionID,
	Output,
	StartInput extends TurnInput<SessionID>,
	ConsumeInput extends TurnInput<SessionID>,
	StateData,
>(
	adapter: SpeculativeActionRuntimeAdapter<SessionID, Output, StartInput, ConsumeInput, StateData>,
	state: TurnState<SessionID, Output, StateData>,
	consumeInput: ConsumeInput | undefined,
	action: ActionKey,
	candidate: RuntimeCandidate<Output>,
): Promise<boolean> {
	if (!adapter.isResourceExpired || candidate.lifetime !== "resource") return false;
	try {
		return await adapter.isResourceExpired({
			stateData: state.data,
			...(consumeInput === undefined ? {} : { consumeInput }),
			action,
			candidate,
		});
	} catch {
		return true;
	}
}

function createDisposalState<SessionID, Output, StateData>(
	sessionID: SessionID,
): TurnState<SessionID, Output, StateData> {
	return {
		sessionID,
		turnID: "<dispose>",
		ready: deferred<void>(),
		candidates: new Map(),
		data: undefined as StateData,
		predictionController: new AbortController(),
		finished: true,
		noCandidateReported: false,
		predictionTimedOut: false,
		predictionPending: false,
	};
}

function deferred<T>(): DeferredState<T> {
	let resolvePromise: (value: T) => void = () => {};
	let complete = false;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => {
			if (complete) return;
			complete = true;
			resolvePromise(value);
		},
		done: () => complete,
	};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
	if (timeoutMs <= 0) {
		onTimeout();
		throw new PredictionTimeoutError();
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			onTimeout();
			reject(new PredictionTimeoutError());
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function waitForCandidate<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
	if (!signal) return promise;
	if (signal.aborted) return undefined;
	return new Promise<T | undefined>((resolve) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		});
	});
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(resolve, milliseconds);
		if (!signal) return;
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}

function asConcreteInput(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return {};
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	return undefined;
}

function candidatesDiagnostic<Output>(candidates: Map<string, RuntimeCandidate<Output>>): string {
	return diagnosticJson(
		[...candidates.values()].map((candidate) => ({
			tool: candidate.key.tool,
			actionKey: candidate.key.key,
			actionKeyHash: candidate.key.hash,
		})),
	);
}

function errorDetail(error: unknown): string {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	return `${name}: ${message}`.slice(0, 2000);
}

function fastCandidateID(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
