import type { ActionKey, CandidateLifetime, DrafterToolDefinition, SpeculativeExecution } from "./common.ts";
import { actionKeyMatches, actionLifetime, clampMaxCandidates, inferredExecution, KEYABLE_TOOLS } from "./common.ts";
import type { PatternAwareSettings } from "./pattern-aware.ts";
import {
	expectedUtility,
	resourceProfile,
	type SpeculativeResourceProfile,
	type SpeculativeSchedulingMetadata,
	speculativeResourceBudget,
	ToolSpeculationScheduler,
} from "./tool-speculation-scheduler.ts";

export interface SpeculativeActionSettings {
	readonly enabled: boolean;
	readonly mode: "predict_action_single_step";
	readonly maxCandidates: number;
	readonly resourceCacheMaxEntries: number;
	readonly predictionTimeoutMs: number;
	readonly patternAware?: PatternAwareSettings;
	readonly tools: {
		readonly resourceCached: readonly string[];
		readonly sandbox: readonly string[];
	};
}

export interface SpeculativeDraftCandidate {
	readonly type: "tool_call" | "preparation_hint";
	readonly tool: string;
	readonly input: unknown;
	readonly missing?: readonly (readonly (string | number)[])[];
	readonly execution?: SpeculativeExecution;
	readonly diagnostic?: string;
	readonly source?: "drafter" | "pattern_aware";
	readonly patternID?: string;
	readonly patternContext?: unknown;
	readonly horizon?: number;
	readonly empiricalProbability?: number;
	readonly expectedDurationMs?: number;
	readonly expectedLatencyBenefitMs?: number;
	readonly resourceDemand?: number;
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

export interface PredictionLease {
	readonly source: "drafter" | "pattern_aware";
	readonly patternID?: string;
	readonly patternContext?: unknown;
	remainingHorizon?: number;
	active: boolean;
	outcome?: "consumed" | "unused";
}

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
	readonly source: "drafter" | "pattern_aware";
	empiricalProbability?: number;
	scheduling: SpeculativeSchedulingMetadata;
	utility: number;
	readonly patternID?: string;
	remainingHorizon?: number;
	predictionActive: boolean;
	readonly leases: PredictionLease[];
	completedAt?: number;
	executionMs?: number;
	consumed: boolean;
	hits: number;
	promoted: boolean;
	schedulerOutcome?: "reused" | "promoted" | "discarded" | "preempted";
}

interface SpeculativeEventBase<SessionID> {
	readonly sessionID: SessionID;
	readonly turnID: string;
	readonly timestamp: number;
}

export interface SpeculativeCacheSnapshot {
	readonly cacheEntries: number;
	readonly cacheCapacity: number;
	readonly cacheRunning: number;
	readonly cacheCompleted: number;
	readonly activeCandidates: number;
	readonly turnCandidates: number;
	readonly resourceCandidates: number;
	readonly cacheTools: readonly string[];
	readonly cacheExecutions: readonly SpeculativeExecution[];
}

interface SpeculativeSchedulingEventFields {
	readonly source: "drafter" | "pattern_aware" | "cache";
	readonly patternID?: string;
	readonly futureHorizon?: number;
	readonly empiricalProbability?: number;
	readonly expectedDurationMs: number;
	readonly expectedBenefitMs: number;
	readonly schedulerUtility: number;
	readonly resourceClass: SpeculativeResourceProfile["class"];
	readonly resourceUnits: number;
	readonly schedulerOutcome?: SpeculativeCandidate["schedulerOutcome"];
}

export type SpeculativeActionEvent<SessionID> = SpeculativeCacheSnapshot &
	(
		| (SpeculativeEventBase<SessionID> &
				SpeculativeSchedulingEventFields & {
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
		| (SpeculativeEventBase<SessionID> &
				SpeculativeSchedulingEventFields & {
					type: "completed";
					tool: string;
					actionKeyHash: string;
					execution: SpeculativeExecution;
					executionMs: number;
				})
		| (SpeculativeEventBase<SessionID> & {
				type: "cache";
		  })
		| (SpeculativeEventBase<SessionID> & {
				type: "actual";
				tool: string;
				actionKeyHash?: string;
				execution?: SpeculativeExecution;
				actualAction: string;
				actualDurationMs: number;
		  })
		| (SpeculativeEventBase<SessionID> &
				SpeculativeSchedulingEventFields & {
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
		| (SpeculativeEventBase<SessionID> &
				SpeculativeSchedulingEventFields & {
					type: "cancelled";
					reason: string;
					tool: string;
					actionKeyHash: string;
					detail?: string;
					draftCandidate: string;
					predictedAction: string;
				})
	);

interface TurnInput<SessionID> {
	readonly sessionID: SessionID;
	readonly turnID: string;
	readonly terminal?: boolean;
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
	readonly predictPatternAware?: (
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
	readonly prepareCandidate?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeDraftCandidate;
		readonly signal: AbortSignal;
	}) => MaybePromise<void>;
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
	readonly recordAuthoritative?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly consumeInput: ConsumeInput;
		readonly action?: ActionKey;
		readonly tool: string;
		readonly concrete: Record<string, unknown>;
		readonly output?: Output;
		readonly durationMs: number;
		readonly speculativeHit: boolean;
	}) => MaybePromise<SpeculativePrediction | undefined>;
	readonly onPatternLaunched?: (patternID: string, context?: unknown) => MaybePromise<void>;
	readonly onPatternResolved?: (
		patternID: string,
		outcome: "consumed" | "unused",
		context?: unknown,
	) => MaybePromise<void>;
	readonly flushPatternStore?: () => MaybePromise<void>;
	readonly onTurnStarted?: (input: {
		readonly startInput: StartInput;
		readonly settings: SpeculativeActionSettings;
		readonly definitions: readonly DrafterToolDefinition[];
		readonly candidateNames: readonly string[];
	}) => MaybePromise<void>;
	readonly onTurnFinished?: (input: {
		readonly startInput: StartInput;
		readonly settings: SpeculativeActionSettings;
		readonly terminal: boolean;
		readonly durationMs: number;
	}) => MaybePromise<void>;
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
	readonly actual: (input: ConsumeInput & { readonly durationMs: number; readonly output?: Output }) => Promise<void>;
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
	readonly startInput: TurnInput<SessionID>;
	readonly startedAt: number;
	readonly ready: DeferredState<void>;
	readonly candidates: Map<string, RuntimeCandidate<Output>>;
	readonly data: StateData;
	readonly settings: SpeculativeActionSettings;
	readonly predictionController: AbortController;
	readonly actorKeys: Set<string>;
	readonly preparedHints: Set<string>;
	readonly candidateFailures: Map<string, string>;
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
	const persistentCandidates = new Map<string, RuntimeCandidate<Output>>();
	const tokenTotals = new Map<SessionID, number>();
	const scheduler = new ToolSpeculationScheduler<RuntimeCandidate<Output>>();
	const candidateOwners = new WeakMap<RuntimeCandidate<Output>, TurnState<SessionID, Output, StateData>>();
	const serviceTimes = new Map<string, { count: number; averageMs: number }>();

	const turnKey = (input: TurnInput<SessionID>): string => `${String(input.sessionID)}:${input.turnID}`;
	const persistentKey = (sessionID: SessionID, key: ActionKey): string => `${String(sessionID)}:${key.key}`;
	const sessionPrefix = (sessionID: SessionID): string => `${String(sessionID)}:`;
	const resourceCacheLimit = (settings: SpeculativeActionSettings): number =>
		Number.isFinite(settings.resourceCacheMaxEntries) ? Math.max(1, Math.floor(settings.resourceCacheMaxEntries)) : 1;

	const observeServiceTime = (tool: string, durationMs: number): void => {
		const duration = Math.max(0, durationMs);
		const current = serviceTimes.get(tool) ?? { count: 0, averageMs: 0 };
		const count = current.count + 1;
		serviceTimes.set(tool, { count, averageMs: current.averageMs + (duration - current.averageMs) / count });
	};

	const schedulingMetadata = (draft: SpeculativeDraftCandidate, action: ActionKey): SpeculativeSchedulingMetadata => {
		const empiricalProbability =
			typeof draft.empiricalProbability === "number" && Number.isFinite(draft.empiricalProbability)
				? Math.max(0, Math.min(1, draft.empiricalProbability))
				: undefined;
		const measured = serviceTimes.get(action.tool)?.averageMs;
		const expectedDurationMs = Math.max(1, draft.expectedDurationMs ?? measured ?? 1);
		const expectedBenefitMs = Math.max(
			0,
			Math.min(
				expectedDurationMs,
				draft.expectedLatencyBenefitMs ??
					(empiricalProbability === undefined ? expectedDurationMs : empiricalProbability * expectedDurationMs),
			),
		);
		const base = resourceProfile(action.tool, action.execution);
		return {
			expectedDurationMs,
			expectedBenefitMs,
			resource: {
				...base,
				units: Math.max(1, Math.floor(draft.resourceDemand ?? base.units)),
			},
		};
	};

	const emit = async (event: SpeculativeActionEvent<SessionID>): Promise<void> => {
		try {
			await adapter.onEvent?.(event);
		} catch {
			// Observability must never change tool execution semantics.
		}
	};

	const sessionPersistentCandidates = (sessionID: SessionID): RuntimeCandidate<Output>[] => {
		const prefix = sessionPrefix(sessionID);
		return [...persistentCandidates.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, candidate]) => candidate);
	};

	const cachedCandidates = (state: TurnState<SessionID, Output, StateData>): RuntimeCandidate<Output>[] => {
		const candidates = new Map<string, RuntimeCandidate<Output>>();
		for (const candidate of sessionPersistentCandidates(state.sessionID))
			candidates.set(candidate.key.key, candidate);
		for (const candidate of state.candidates.values()) {
			if (candidate.consumed && candidate.lifetime === "turn") continue;
			candidates.set(candidate.key.key, candidate);
		}
		return [...candidates.values()];
	};

	const cacheSnapshot = (state: TurnState<SessionID, Output, StateData>): SpeculativeCacheSnapshot => {
		const candidates = cachedCandidates(state);
		const running = candidates.filter((candidate) => candidate.completedAt === undefined).length;
		return {
			cacheEntries: candidates.length,
			cacheCapacity: state.settings.resourceCacheMaxEntries,
			cacheRunning: running,
			cacheCompleted: candidates.length - running,
			activeCandidates: running,
			turnCandidates: candidates.filter((candidate) => candidate.lifetime === "turn").length,
			resourceCandidates: candidates.filter((candidate) => candidate.lifetime === "resource").length,
			cacheTools: [...new Set(candidates.map((candidate) => candidate.key.tool))].sort(),
			cacheExecutions: [...new Set(candidates.map((candidate) => candidate.key.execution))].sort(),
		};
	};

	const schedulingEventFields = (
		candidate: RuntimeCandidate<Output>,
		source: SpeculativeSchedulingEventFields["source"] = candidate.source,
	): SpeculativeSchedulingEventFields => ({
		source,
		...(candidate.patternID ? { patternID: candidate.patternID } : {}),
		...(candidate.remainingHorizon !== undefined ? { futureHorizon: candidate.remainingHorizon } : {}),
		...(candidate.empiricalProbability !== undefined ? { empiricalProbability: candidate.empiricalProbability } : {}),
		expectedDurationMs: candidate.scheduling.expectedDurationMs,
		expectedBenefitMs: candidate.scheduling.expectedBenefitMs,
		schedulerUtility: candidate.utility,
		resourceClass: candidate.scheduling.resource.class,
		resourceUnits: candidate.scheduling.resource.units,
		...(candidate.schedulerOutcome ? { schedulerOutcome: candidate.schedulerOutcome } : {}),
	});

	const publishCache = async (state: TurnState<SessionID, Output, StateData>): Promise<void> => {
		await emit({
			type: "cache",
			sessionID: state.sessionID,
			turnID: state.turnID,
			timestamp: Date.now(),
			...cacheSnapshot(state),
		});
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
			...cacheSnapshot(state),
		});
	};

	const publishStarted = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): Promise<void> => {
		await emit({
			type: "started",
			sessionID: state.sessionID,
			turnID: state.turnID,
			timestamp: Date.now(),
			tool: candidate.key.tool,
			actionKeyHash: candidate.key.hash,
			execution: candidate.key.execution,
			predictionLatencyMs: candidate.predictionLatencyMs,
			draftTokens: candidate.draftTokens,
			totalDraftTokens: candidate.totalDraftTokens,
			draftCandidate: candidate.draftCandidate,
			predictedAction: candidate.predictedAction,
			...schedulingEventFields(candidate),
			...cacheSnapshot(state),
		});
	};

	const publishCompleted = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): Promise<void> => {
		await emit({
			type: "completed",
			sessionID: state.sessionID,
			turnID: state.turnID,
			timestamp: Date.now(),
			tool: candidate.key.tool,
			actionKeyHash: candidate.key.hash,
			execution: candidate.key.execution,
			executionMs: candidate.executionMs ?? 0,
			...schedulingEventFields(candidate),
			...cacheSnapshot(state),
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
			...schedulingEventFields(candidate),
			...cacheSnapshot(state),
		});
	};

	const availableCandidates = (
		state: TurnState<SessionID, Output, StateData>,
	): Map<string, RuntimeCandidate<Output>> => {
		const candidates = new Map(state.candidates);
		for (const candidate of sessionPersistentCandidates(state.sessionID))
			candidates.set(candidate.key.key, candidate);
		return candidates;
	};

	const removePersistentCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): boolean => {
		const key = persistentKey(state.sessionID, candidate.key);
		if (persistentCandidates.get(key) !== candidate) return false;
		return persistentCandidates.delete(key);
	};

	const touchPersistentCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): void => {
		const key = persistentKey(state.sessionID, candidate.key);
		if (!persistentCandidates.has(key)) return;
		persistentCandidates.delete(key);
		persistentCandidates.set(key, candidate);
	};

	const addPersistentCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): RuntimeCandidate<Output>[] => {
		persistentCandidates.set(persistentKey(state.sessionID, candidate.key), candidate);
		const prefix = sessionPrefix(state.sessionID);
		const evicted: RuntimeCandidate<Output>[] = [];
		while (
			[...persistentCandidates.keys()].filter((key) => key.startsWith(prefix)).length >
			resourceCacheLimit(state.settings)
		) {
			const oldest = [...persistentCandidates.keys()].find((key) => key.startsWith(prefix));
			if (!oldest) break;
			const stale = persistentCandidates.get(oldest);
			persistentCandidates.delete(oldest);
			if (stale) evicted.push(stale);
		}
		return evicted;
	};

	const resolvePatternLeases = async (
		candidate: RuntimeCandidate<Output>,
		outcome: "consumed" | "unused",
	): Promise<void> => {
		for (const lease of candidate.leases) {
			if (!lease.active || lease.source !== "pattern_aware") continue;
			lease.active = false;
			lease.outcome = outcome;
			if (!lease.patternID || !adapter.onPatternResolved) continue;
			try {
				await adapter.onPatternResolved(lease.patternID, outcome, lease.patternContext);
			} catch {
				// Pattern feedback must not alter tool semantics.
			}
		}
		candidate.predictionActive = candidate.leases.some((lease) => lease.active);
	};

	const preemptCandidate = async (
		candidate: RuntimeCandidate<Output>,
		reason = "scheduler_preempted",
		outcome: "preempted" | "discarded" = "preempted",
	): Promise<void> => {
		const owner = candidateOwners.get(candidate);
		scheduler.discard(candidate);
		candidate.schedulerOutcome = outcome;
		candidate.consumed = true;
		await resolvePatternLeases(candidate, "unused");
		if (owner) {
			owner.candidates.delete(candidate.key.key);
			removePersistentCandidate(owner, candidate);
		}
		candidate.controller.abort();
		candidate.execution.resolve({ ok: false, error: new Error(reason) });
		if (owner) {
			await publishCancelled(owner, candidate, reason);
			await publishCache(owner);
		}
	};

	const preemptForAuthoritative = async (resource: SpeculativeResourceProfile): Promise<void> => {
		for (const candidate of scheduler.preemptForAuthoritative(resource)) await preemptCandidate(candidate);
	};

	const cancelCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason: string,
		detail?: string,
	): Promise<void> => {
		for (const lease of candidate.leases) {
			if (lease.source === "drafter") lease.active = false;
		}
		candidate.predictionActive = candidate.leases.some((lease) => lease.active);
		if (!candidate.predictionActive && candidate.lifetime !== "resource") {
			candidate.schedulerOutcome = "discarded";
			scheduler.discard(candidate);
			candidate.consumed = true;
			state.candidates.delete(candidate.key.key);
			removePersistentCandidate(state, candidate);
			candidate.controller.abort();
			candidate.execution.resolve({ ok: false, error: new Error(reason) });
		}
		await publishCancelled(state, candidate, reason, detail);
	};

	const cancelUnmatchedTurnCandidates = async (
		state: TurnState<SessionID, Output, StateData>,
		actual: ActionKey | undefined,
		reason: string,
	): Promise<void> => {
		for (const candidate of [...state.candidates.values()]) {
			if (candidate.consumed || candidate.lifetime === "resource") continue;
			if (candidate.leases.some((lease) => lease.active && lease.source === "pattern_aware")) continue;
			if (actual && candidate.key.key === actual.key) continue;
			await cancelCandidate(state, candidate, reason);
		}
	};

	const expireCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason = "resource_expired",
	): Promise<void> => {
		await resolvePatternLeases(candidate, "unused");
		candidate.schedulerOutcome = "discarded";
		scheduler.discard(candidate);
		candidate.consumed = true;
		state.candidates.delete(candidate.key.key);
		removePersistentCandidate(state, candidate);
		candidate.controller.abort();
		candidate.execution.resolve({ ok: false, error: new Error(reason) });
	};

	const advancePatternLeases = async (
		state: TurnState<SessionID, Output, StateData>,
		matched?: RuntimeCandidate<Output>,
	): Promise<void> => {
		for (const candidate of availableCandidates(state).values()) {
			if (candidate === matched) continue;
			let expired = false;
			for (const lease of candidate.leases) {
				if (!lease.active || lease.source !== "pattern_aware") continue;
				lease.remainingHorizon = (lease.remainingHorizon ?? 0) - 1;
				if (lease.remainingHorizon >= 0) continue;
				lease.active = false;
				lease.outcome = "unused";
				expired = true;
				if (lease.patternID && adapter.onPatternResolved) {
					try {
						await adapter.onPatternResolved(lease.patternID, "unused", lease.patternContext);
					} catch {
						// Pattern feedback must not alter tool semantics.
					}
				}
			}
			candidate.predictionActive = candidate.leases.some((lease) => lease.active);
			if (!expired || candidate.predictionActive || candidate.lifetime === "resource") continue;
			candidate.schedulerOutcome = "discarded";
			scheduler.discard(candidate);
			state.candidates.delete(candidate.key.key);
			removePersistentCandidate(state, candidate);
			candidate.controller.abort();
			candidate.execution.resolve({ ok: false, error: new Error("pattern_horizon_expired") });
			await publishCancelled(state, candidate, "pattern_horizon_expired");
		}
	};

	const findCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		actual: ActionKey,
	): RuntimeCandidate<Output> | undefined => {
		const exact =
			state.candidates.get(actual.key) ?? persistentCandidates.get(persistentKey(state.sessionID, actual));
		if (exact) {
			touchPersistentCandidate(state, exact);
			return exact;
		}
		if (!adapter.projectOutput) return undefined;
		for (const candidate of availableCandidates(state).values()) {
			if (candidate.consumed && candidate.lifetime === "turn") continue;
			if (!actionKeyMatches(candidate.key, actual)) continue;
			touchPersistentCandidate(state, candidate);
			return candidate;
		}
		return undefined;
	};

	const findReusableCandidate = async (
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
				await expireCandidate(state, candidate);
				continue;
			}
			touchPersistentCandidate(state, candidate);
			return candidate;
		}
		return undefined;
	};

	const attachPatternLease = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		draft: SpeculativeDraftCandidate,
	): Promise<void> => {
		if (draft.source !== "pattern_aware" || !draft.patternID) return;
		if (candidate.leases.some((lease) => lease.active && lease.patternID === draft.patternID)) return;
		candidate.leases.push({
			source: "pattern_aware",
			patternID: draft.patternID,
			...(draft.patternContext !== undefined ? { patternContext: draft.patternContext } : {}),
			remainingHorizon: Math.max(0, Math.floor(draft.horizon ?? 0)),
			active: true,
		});
		candidate.predictionActive = true;
		const scheduling = schedulingMetadata(draft, candidate.key);
		if (expectedUtility(scheduling) > candidate.utility) {
			candidate.empiricalProbability = draft.empiricalProbability;
			candidate.scheduling = scheduling;
			candidate.utility = expectedUtility(scheduling);
			scheduler.update(candidate, scheduling);
		}
		if (!persistentCandidates.has(persistentKey(state.sessionID, candidate.key))) {
			for (const evicted of addPersistentCandidate(state, candidate)) {
				await preemptCandidate(evicted, "resource_cache_evicted", "discarded");
			}
		}
		try {
			await adapter.onPatternLaunched?.(draft.patternID, draft.patternContext);
		} catch {
			// Pattern feedback must not alter tool semantics.
		}
	};

	const admitPredictions = async (
		state: TurnState<SessionID, Output, StateData>,
		input: StartInput,
		drafts: readonly SpeculativeDraftCandidate[],
		predictionLatencyMs: number,
		draftTokens: number,
		totalDraftTokens: number,
		batchSource: "drafter" | "pattern_aware",
		candidateNames: readonly string[],
	): Promise<number> => {
		let accepted = 0;
		let started = 0;
		const candidateLimit = clampMaxCandidates(state.settings.maxCandidates);
		const ordered = [...drafts].sort(
			(left, right) =>
				(right.expectedLatencyBenefitMs ?? 0) - (left.expectedLatencyBenefitMs ?? 0) ||
				(right.empiricalProbability ?? 0) - (left.empiricalProbability ?? 0),
		);
		for (const [index, draft] of ordered.entries()) {
			if (draft.type === "preparation_hint") {
				if (!candidateNames.includes(draft.tool)) continue;
				if (
					draft.source === "pattern_aware" &&
					(draft.empiricalProbability ?? 0) < (state.settings.patternAware?.minEmpiricalProbability ?? 0)
				) {
					continue;
				}
				const hintKey = diagnosticJson({ tool: draft.tool, input: draft.input, missing: draft.missing });
				if (state.preparedHints.has(hintKey) || state.preparedHints.size >= candidateLimit) continue;
				state.preparedHints.add(hintKey);
				if (adapter.prepareCandidate) {
					try {
						await adapter.prepareCandidate({
							startInput: input,
							data: state.data,
							settings: state.settings,
							candidate: draft,
							signal: state.predictionController.signal,
						});
					} catch {
						// Preparation is best-effort and never executes the hinted action.
					}
				}
				continue;
			}
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
			const source = draft.source ?? batchSource;
			const callID = `spec_${fastCandidateID(`${input.turnID}:${source}:${index}:${action.key}`)}`;
			const lifetime =
				adapter.candidateLifetime?.({
					startInput: input,
					data: state.data,
					settings: state.settings,
					candidate: draft,
					tool: draft.tool,
					concrete,
					action,
					callID,
					index,
				}) ?? actionLifetime(action.tool);
			const reusable = await findReusableCandidate(state, action);
			if (reusable) {
				await attachPatternLease(state, reusable, draft);
				accepted++;
				continue;
			}
			if (source === "drafter" && state.actorKeys.has(action.key)) continue;
			const execution = draft.execution ?? inferredExecution(draft.tool);
			if (execution !== action.execution) {
				await publishMiss(state, "execution_mismatch", action, undefined, { draftCandidate, predictedAction });
				continue;
			}
			const candidateController = new AbortController();
			const preflight = await adapter.preflightCandidate({
				startInput: input,
				data: state.data,
				settings: state.settings,
				candidate: draft,
				tool: draft.tool,
				concrete,
				action,
				callID,
				index,
				signal: candidateController.signal,
			});
			if (!preflight.ok) {
				await publishMiss(state, preflight.reason, action, preflight.detail, { draftCandidate, predictedAction });
				continue;
			}
			const resourceVersion = adapter.captureResourceVersion
				? await adapter.captureResourceVersion({
						startInput: input,
						data: state.data,
						settings: state.settings,
						candidate: draft,
						tool: draft.tool,
						concrete,
						action,
						callID,
						index,
					})
				: undefined;
			if (source === "drafter" && state.actorKeys.has(action.key)) {
				candidateController.abort();
				continue;
			}
			if (state.finished) {
				candidateController.abort();
				break;
			}
			const sourceLease: PredictionLease = {
				source,
				...(draft.patternID ? { patternID: draft.patternID } : {}),
				...(draft.patternContext !== undefined ? { patternContext: draft.patternContext } : {}),
				...(source === "pattern_aware" ? { remainingHorizon: Math.max(0, Math.floor(draft.horizon ?? 0)) } : {}),
				active: true,
			};
			const scheduling = schedulingMetadata(draft, action);
			const candidate: RuntimeCandidate<Output> = {
				key: action,
				lifetime,
				resourceVersion,
				draftCandidate,
				predictedAction,
				startedAt: Date.now(),
				predictionLatencyMs,
				draftTokens,
				totalDraftTokens,
				source,
				...(typeof draft.empiricalProbability === "number"
					? { empiricalProbability: Math.max(0, Math.min(1, draft.empiricalProbability)) }
					: {}),
				scheduling,
				utility: expectedUtility(scheduling),
				...(draft.patternID ? { patternID: draft.patternID } : {}),
				...(sourceLease.remainingHorizon !== undefined ? { remainingHorizon: sourceLease.remainingHorizon } : {}),
				predictionActive: true,
				leases: [sourceLease],
				execution: deferred<CandidateExecution<Output>>(),
				controller: candidateController,
				consumed: false,
				hits: 0,
				promoted: false,
			};
			const admission = scheduler.admit(
				candidate,
				scheduling,
				speculativeResourceBudget(state.settings.maxCandidates),
			);
			if (!admission.admitted) {
				candidate.schedulerOutcome = "discarded";
				await publishCancelled(state, candidate, `scheduler_${admission.reason}`);
				continue;
			}
			for (const victim of admission.preempted) await preemptCandidate(victim);
			state.candidates.set(action.key, candidate);
			candidateOwners.set(candidate, state);
			if (lifetime === "resource" || source === "pattern_aware") {
				for (const evicted of addPersistentCandidate(state, candidate)) {
					await preemptCandidate(evicted, "resource_cache_evicted", "discarded");
				}
			}
			accepted++;
			started++;
			if (source === "pattern_aware" && draft.patternID) {
				try {
					await adapter.onPatternLaunched?.(draft.patternID, draft.patternContext);
				} catch {
					// Pattern feedback must not alter tool semantics.
				}
			}
			await publishStarted(state, candidate);
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
					async (output) => {
						if (candidate.schedulerOutcome === "preempted" || candidate.schedulerOutcome === "discarded") {
							candidate.execution.resolve({
								ok: false,
								error: new Error(`speculative_${candidate.schedulerOutcome}`),
							});
							return;
						}
						candidate.completedAt = Date.now();
						candidate.executionMs = Math.max(0, candidate.completedAt - executionStarted);
						scheduler.complete(candidate);
						await publishCache(state);
						await publishCompleted(state, candidate);
						candidate.execution.resolve({ ok: true, output });
					},
					async (error: unknown) => {
						if (candidate.schedulerOutcome === "preempted" || candidate.schedulerOutcome === "discarded") {
							candidate.execution.resolve({ ok: false, error });
							return;
						}
						candidate.completedAt = Date.now();
						candidate.executionMs = Math.max(0, candidate.completedAt - executionStarted);
						scheduler.complete(candidate);
						if (!candidate.promoted) {
							state.candidateFailures.set(candidate.key.key, errorDetail(error));
							candidate.schedulerOutcome = "discarded";
							candidate.consumed = true;
							await resolvePatternLeases(candidate, "unused");
							state.candidates.delete(candidate.key.key);
							removePersistentCandidate(state, candidate);
							await publishCancelled(state, candidate, "candidate_execution_failed", errorDetail(error));
							await publishCache(state);
						}
						candidate.execution.resolve({ ok: false, error });
					},
				);
		}
		return accepted;
	};

	const recordAndPredict = async (
		state: TurnState<SessionID, Output, StateData>,
		consumeInput: ConsumeInput,
		actualCall: ActualToolCall,
		action: ActionKey | undefined,
		output: Output | undefined,
		durationMs: number,
		speculativeHit: boolean,
	): Promise<void> => {
		if (!adapter.recordAuthoritative || !state.settings.patternAware?.enabled || state.finished) return;
		const concrete = asConcreteInput(actualCall.input);
		if (!concrete) return;
		const prediction = await adapter.recordAuthoritative({
			startInput: state.startInput as StartInput,
			data: state.data,
			settings: state.settings,
			consumeInput,
			action,
			tool: actualCall.tool,
			concrete,
			output,
			durationMs: Math.max(0, durationMs),
			speculativeHit,
		});
		if (!prediction?.candidates.length || state.finished) return;
		await admitPredictions(
			state,
			state.startInput as StartInput,
			prediction.candidates,
			0,
			0,
			tokenTotals.get(state.sessionID) ?? 0,
			"pattern_aware",
			candidateToolNames(state.settings),
		);
	};

	const runPrediction = async (
		input: StartInput,
		definitions: readonly DrafterToolDefinition[],
		candidateNames: readonly string[],
		state: TurnState<SessionID, Output, StateData>,
	): Promise<void> => {
		let accepted = 0;
		try {
			if (adapter.predictPatternAware && state.settings.patternAware?.enabled) {
				try {
					const patternPrediction = await adapter.predictPatternAware(
						input,
						state.settings,
						definitions,
						candidateNames,
						state.predictionController.signal,
					);
					accepted += await admitPredictions(
						state,
						input,
						patternPrediction.candidates,
						0,
						0,
						tokenTotals.get(input.sessionID) ?? 0,
						"pattern_aware",
						candidateNames,
					);
				} catch {
					// Learned predictions are optional; drafter prediction remains available.
				}
			}

			const predictionStarted = Date.now();
			const prediction = await withTimeout(
				Promise.resolve(
					adapter.predict(input, state.settings, definitions, candidateNames, state.predictionController.signal),
				),
				Math.max(0, state.settings.predictionTimeoutMs),
				() => state.predictionController.abort(),
			);
			const predictionLatencyMs = Math.max(0, Date.now() - predictionStarted);
			const totalDraftTokens = (tokenTotals.get(input.sessionID) ?? 0) + prediction.draftTokens;
			tokenTotals.set(input.sessionID, totalDraftTokens);
			if (state.finished) return;
			if (!prediction.candidates.length) {
				if (!accepted) {
					state.noCandidateReported = true;
					await publishMiss(state, "no_candidate", undefined, "Drafter returned no tool-call candidates.");
				}
				return;
			}
			accepted += await admitPredictions(
				state,
				input,
				prediction.candidates,
				predictionLatencyMs,
				prediction.draftTokens,
				totalDraftTokens,
				"drafter",
				candidateNames,
			);
			if (!accepted && !state.noCandidateReported) {
				state.noCandidateReported = true;
				await publishMiss(
					state,
					"no_candidate",
					undefined,
					"No drafter candidate passed validation, policy, and permission checks.",
				);
			}
		} catch (error) {
			if (state.finished) return;
			if (error instanceof PredictionTimeoutError) state.predictionTimedOut = true;
			state.noCandidateReported = true;
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
		if (existing) await finishState(existing, false);
		try {
			await adapter.onTurnStarted?.({ startInput: input, settings, definitions, candidateNames });
		} catch {
			// Analyzer metadata must not alter actor semantics.
		}
		const state: TurnState<SessionID, Output, StateData> = {
			sessionID: input.sessionID,
			turnID: input.turnID,
			startInput: input,
			startedAt: Date.now(),
			ready: deferred<void>(),
			candidates: new Map(),
			data: await adapter.stateData(input),
			settings,
			predictionController: new AbortController(),
			actorKeys: new Set(),
			preparedHints: new Set(),
			candidateFailures: new Map(),
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
		void runPrediction(input, definitions, candidateNames, state);
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
			await preemptForAuthoritative({ class: "global", units: 1 });
			await advancePatternLeases(state);
			await cancelUnmatchedTurnCandidates(state, undefined, "explicit_miss");
			return undefined;
		}

		state.actorKeys.add(actual.key);
		const candidate = findCandidate(state, actual);
		if (!candidate) {
			const candidateFailure = state.candidateFailures.get(actual.key);
			if (candidateFailure) {
				state.candidateFailures.delete(actual.key);
				await publishMiss(state, "candidate_execution_failed", actual, candidateFailure, { actualAction });
				return undefined;
			}
			const immediate = new Map(
				[...availableCandidates(state)].filter(([, item]) =>
					item.leases.some((lease) => lease.active && lease.source === "drafter"),
				),
			);
			if (immediate.size > 0) {
				await publishMiss(state, "key_mismatch", actual, undefined, {
					actualAction,
					predictedAction: candidatesDiagnostic(immediate),
				});
			}
			await preemptForAuthoritative(resourceProfile(actual.tool, actual.execution));
			await advancePatternLeases(state);
			await cancelUnmatchedTurnCandidates(state, actual, "explicit_miss");
			return undefined;
		}

		await advancePatternLeases(state, candidate);
		if (await isExpired(adapter, state, input, actual, candidate)) {
			await expireCandidate(state, candidate);
			await publishMiss(state, "resource_expired", actual, undefined, {
				actualAction,
				draftCandidate: candidate.draftCandidate,
				predictedAction: candidate.predictedAction,
			});
			return undefined;
		}

		if (candidate.completedAt === undefined) {
			scheduler.promote(candidate);
			candidate.promoted = true;
			candidate.schedulerOutcome = "promoted";
		} else {
			candidate.schedulerOutcome = "reused";
		}
		const waitStarted = Date.now();
		const execution = await waitForCandidate(candidate.execution.promise, signal);
		if (!execution || signal?.aborted) return undefined;
		if (!execution.ok) {
			await resolvePatternLeases(candidate, "unused");
			candidate.schedulerOutcome = "discarded";
			candidate.consumed = true;
			state.candidates.delete(candidate.key.key);
			removePersistentCandidate(state, candidate);
			await publishMiss(state, "candidate_execution_failed", actual, errorDetail(execution.error), {
				actualAction,
				draftCandidate: candidate.draftCandidate,
				predictedAction: candidate.predictedAction,
			});
			return undefined;
		}
		if (await isExpired(adapter, state, input, actual, candidate)) {
			await expireCandidate(state, candidate);
			await publishMiss(state, "resource_expired", actual, "Resource changed before result adoption.", {
				actualAction,
				draftCandidate: candidate.draftCandidate,
				predictedAction: candidate.predictedAction,
			});
			return undefined;
		}

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
				await expireCandidate(state, candidate, "adoption_failed");
				await publishMiss(state, "adoption_failed", actual, undefined, {
					actualAction,
					draftCandidate: candidate.draftCandidate,
					predictedAction: candidate.predictedAction,
				});
				return undefined;
			}
			output = adopted;
		}
		if (candidate.key.key !== actual.key && adapter.projectOutput) {
			const projected = await adapter.projectOutput({
				stateData: state.data,
				consumeInput: input,
				action: actual,
				candidate,
				output,
			});
			if (projected === undefined) {
				await expireCandidate(state, candidate, "projection_failed");
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
		observeServiceTime(actual.tool, executionMs);
		await resolvePatternLeases(candidate, "consumed");
		candidate.consumed = true;
		candidate.hits++;
		if (candidate.lifetime === "turn") {
			state.candidates.delete(candidate.key.key);
			removePersistentCandidate(state, candidate);
		}
		const patternLease = candidate.leases.find(
			(lease) => lease.source === "pattern_aware" && lease.outcome === "consumed",
		);
		const eventSource: SpeculativeSchedulingEventFields["source"] =
			candidate.hits > 1 || (!patternLease && !candidate.predictionActive)
				? "cache"
				: patternLease
					? "pattern_aware"
					: candidate.source;
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
			...schedulingEventFields(candidate, eventSource),
			...cacheSnapshot(state),
		});
		await recordAndPredict(state, input, actualCall, actual, output, executionMs, true);
		return output;
	};

	const actual = async (
		input: ConsumeInput & { readonly durationMs: number; readonly output?: Output },
	): Promise<void> => {
		const state = turns.get(turnKey(input));
		if (!state) return;
		const actualCall = adapter.actual(input);
		const key = await adapter.actionKey(actualCall.tool, actualCall.input, {
			type: "consume",
			consumeInput: input,
		});
		const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
		observeServiceTime(actualCall.tool, durationMs);
		await emit({
			type: "actual",
			sessionID: state.sessionID,
			turnID: state.turnID,
			timestamp: Date.now(),
			tool: actualCall.tool,
			...(key ? { actionKeyHash: key.hash, execution: key.execution } : {}),
			actualAction: diagnosticAction(actualCall.tool, actualCall.input, key),
			actualDurationMs: durationMs,
			...cacheSnapshot(state),
		});
		await recordAndPredict(state, input, actualCall, key, input.output, durationMs, false);
	};

	const finishState = async (state: TurnState<SessionID, Output, StateData>, terminal: boolean): Promise<void> => {
		if (state.finished) return;
		state.finished = true;
		state.predictionController.abort();
		turns.delete(turnKey(state));
		try {
			await adapter.onTurnFinished?.({
				startInput: state.startInput as StartInput,
				settings: state.settings,
				terminal,
				durationMs: Math.max(0, Date.now() - state.startedAt),
			});
		} catch {
			// Analyzer lifecycle must not alter actor semantics.
		}
		const candidates = terminal
			? new Set([...state.candidates.values(), ...sessionPersistentCandidates(state.sessionID)])
			: new Set(state.candidates.values());
		for (const candidate of candidates) {
			if (candidate.consumed && candidate.lifetime !== "resource") continue;
			if (terminal) {
				await resolvePatternLeases(candidate, "unused");
				for (const lease of candidate.leases) {
					if (!lease.active) continue;
					lease.active = false;
					lease.outcome = "unused";
				}
				candidate.predictionActive = false;
				if (candidate.lifetime === "resource") continue;
				candidate.consumed = true;
				state.candidates.delete(candidate.key.key);
				removePersistentCandidate(state, candidate);
				scheduler.discard(candidate);
				candidate.schedulerOutcome = "discarded";
				candidate.controller.abort();
				candidate.execution.resolve({
					ok: false,
					error: new Error("request_finished_without_hit"),
				});
				await publishCancelled(state, candidate, "request_finished_without_hit");
				continue;
			}
			if (candidate.lifetime === "resource") continue;
			if (candidate.leases.some((lease) => lease.active && lease.source === "pattern_aware")) continue;
			await cancelCandidate(state, candidate, "turn_finished_without_hit");
		}
		try {
			await adapter.flushPatternStore?.();
		} catch {
			// Persistence is best-effort.
		}
	};

	const finishTerminalSession = async (sessionID: SessionID): Promise<void> => {
		const candidates = sessionPersistentCandidates(sessionID);
		if (!candidates.length) return;
		for (const candidate of candidates) {
			await resolvePatternLeases(candidate, "unused");
			if (candidate.lifetime === "resource") continue;
			await preemptCandidate(candidate, "request_finished_without_hit", "discarded");
		}
		try {
			await adapter.flushPatternStore?.();
		} catch {
			// Persistence is best-effort.
		}
	};

	const abortState = async (state: TurnState<SessionID, Output, StateData>, reason: string): Promise<void> => {
		if (state.finished) return;
		state.finished = true;
		state.predictionController.abort();
		turns.delete(turnKey(state));
		for (const candidate of [...state.candidates.values()]) {
			if (candidate.consumed) continue;
			await resolvePatternLeases(candidate, "unused");
			await preemptCandidate(candidate, reason, "discarded");
		}
	};

	const finishTurn = async (input: FinishInput): Promise<void> => {
		const state = turns.get(turnKey(input));
		if (state) await finishState(state, input.terminal === true);
		else if (input.terminal === true) await finishTerminalSession(input.sessionID);
	};

	const disposeSession = async (sessionID: SessionID): Promise<void> => {
		for (const state of [...turns.values()].filter((item) => item.sessionID === sessionID)) {
			await abortState(state, "session_disposed");
		}
		const settings = await adapter.settings();
		const stateForEvents = createDisposalState<SessionID, Output, StateData>(sessionID, settings);
		for (const candidate of sessionPersistentCandidates(sessionID)) {
			await resolvePatternLeases(candidate, "unused");
			scheduler.discard(candidate);
			candidate.schedulerOutcome = "discarded";
			candidate.consumed = true;
			removePersistentCandidate(stateForEvents, candidate);
			candidate.controller.abort();
			candidate.execution.resolve({ ok: false, error: new Error("session_disposed") });
			await publishCancelled(stateForEvents, candidate, "session_disposed");
		}
		tokenTotals.delete(sessionID);
		try {
			await adapter.flushPatternStore?.();
		} catch {
			// Persistence is best-effort.
		}
	};

	const dispose = async (): Promise<void> => {
		const sessions = new Set<SessionID>();
		for (const state of turns.values()) sessions.add(state.sessionID);
		for (const sessionID of tokenTotals.keys()) sessions.add(sessionID);
		for (const sessionID of sessions) await disposeSession(sessionID);
	};

	const inspect = (sessionID?: SessionID): SpeculativeRuntimeInspection => {
		const states = [...turns.values()].filter((state) => sessionID === undefined || state.sessionID === sessionID);
		const persistent =
			sessionID === undefined ? [...persistentCandidates.values()] : sessionPersistentCandidates(sessionID);
		return {
			activeTurns: states.length,
			turnCandidates: states.reduce(
				(count, state) =>
					count + [...state.candidates.values()].filter((candidate) => candidate.lifetime === "turn").length,
				0,
			),
			resourceCandidates: persistent.filter((candidate) => candidate.lifetime === "resource").length,
			pendingPredictions: states.filter((state) => state.predictionPending).length,
		};
	};

	return { startTurn, consume, actual, finishTurn, disposeSession, dispose, inspect };
}

export function candidateToolNames(settings: SpeculativeActionSettings): readonly string[] {
	const resourceCached = new Set(settings.tools.resourceCached);
	const sandbox = new Set(settings.tools.sandbox);
	return KEYABLE_TOOLS.filter((tool) =>
		inferredExecution(tool) === "sandbox" ? sandbox.has(tool) : resourceCached.has(tool),
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
	settings: SpeculativeActionSettings,
): TurnState<SessionID, Output, StateData> {
	return {
		sessionID,
		turnID: "<dispose>",
		startInput: { sessionID, turnID: "<dispose>" },
		startedAt: Date.now(),
		ready: deferred<void>(),
		candidates: new Map(),
		data: undefined as StateData,
		settings,
		predictionController: new AbortController(),
		actorKeys: new Set(),
		preparedHints: new Set(),
		candidateFailures: new Map(),
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
