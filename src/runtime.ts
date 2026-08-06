import type { ActionKey, DrafterToolDefinition, SpeculativeExecution } from "./common.ts";
import { actionKeyMatches, clampCandidateLimit, DEFAULTS, inferredExecution, KEYABLE_TOOLS } from "./common.ts";
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
	readonly drafterEnabled?: boolean;
	readonly candidateLimit?: number;
	readonly maxConcurrentActions?: number;
	/** @deprecated Compatibility for adapters created before the limits were split. */
	readonly maxCandidates?: number;
	readonly resourceCacheMaxEntries: number;
	readonly resourceCacheMaxBytes?: number;
	readonly predictionTimeoutMs: number;
	readonly adaptiveDrafter?: boolean;
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
	readonly conditionalProbability?: number;
	readonly expectedDurationMs?: number;
	readonly expectedLatencyBenefitMs?: number;
	readonly resourceDemand?: number;
	readonly depth?: number;
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

export interface ResourceValidationResult {
	readonly expired: boolean;
	readonly reason?: string;
	readonly durationMs?: number;
	readonly bytesRead?: number;
	readonly filesRead?: number;
	readonly mode?: "watcher" | "exact";
}

export interface PredictionLease {
	readonly id: string;
	readonly source: "drafter" | "pattern_aware";
	readonly patternID?: string;
	readonly patternContext?: unknown;
	readonly providerTurnID: string;
	readonly anchorActionSeq: number;
	readonly horizon?: number;
	readonly validThroughActionSeq?: number;
	state: "active" | "matched" | "hit" | "expired" | "invalidated";
	resolvedActionSeq?: number;
}

export type SpeculativeJobRun<Output> =
	| { readonly status: "running" }
	| { readonly status: "ready"; readonly completedAt: number; readonly executionMs: number; readonly output: Output }
	| {
			readonly status: "closed";
			readonly reason: string;
			readonly completedAt?: number;
			readonly executionMs?: number;
	  };

export type SpeculativeJobReuse =
	| { readonly kind: "shared" }
	| {
			readonly kind: "exclusive";
			state: "available" | "claimed" | "adopted";
			claimTurnID?: string;
	  };

export interface SpeculativeCandidate {
	readonly id: string;
	readonly key: ActionKey;
	readonly tool: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly reuse: SpeculativeJobReuse;
	run: SpeculativeJobRun<unknown>;
	resourceVersion?: unknown;
	releaseResourceVersion?: () => void;
	resourceCaptureMs?: number;
	resourceCaptureBytes?: number;
	resourceCaptureFiles?: number;
	validationMs: number;
	validationBytes: number;
	validationFiles: number;
	validationMode?: "watcher" | "exact";
	estimatedBytes: number;
	sandboxSetupMs?: number;
	changeCollectionMs?: number;
	commitMs?: number;
	commitValidationMs?: number;
	commitValidationBytes?: number;
	commitValidationFiles?: number;
	changedResources?: readonly string[];
	readonly draftCandidate: string;
	readonly predictedAction: string;
	readonly startedAt: number;
	executionStartedAt?: number;
	actorLeadMs?: number;
	readonly predictionLatencyMs: number;
	readonly draftTokens: number;
	readonly totalDraftTokens: number;
	readonly source: "drafter" | "pattern_aware";
	empiricalProbability?: number;
	conditionalProbability?: number;
	depth?: number;
	scheduling: SpeculativeSchedulingMetadata;
	utility: number;
	readonly patternID?: string;
	readonly leases: PredictionLease[];
	hits: number;
	authoritativeSequence?: number;
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
	readonly cacheBytes?: number;
	readonly cacheByteCapacity?: number;
	readonly cacheRunning: number;
	readonly cacheCompleted: number;
	readonly activeCandidates: number;
	readonly turnCandidates: number;
	readonly resourceCandidates: number;
	readonly cacheTools: readonly string[];
	readonly cacheExecutions: readonly SpeculativeExecution[];
	readonly observedWallMs?: number;
}

interface SpeculativeSchedulingEventFields {
	readonly source: "drafter" | "pattern_aware" | "cache";
	readonly patternID?: string;
	readonly futureHorizon?: number;
	readonly empiricalProbability?: number;
	readonly conditionalProbability?: number;
	readonly patternDepth?: number;
	readonly expectedDurationMs: number;
	readonly expectedLeadMs?: number;
	readonly expectedBenefitMs: number;
	readonly expectedWasteMs?: number;
	readonly overheadCostMs?: number;
	readonly schedulerUtility: number;
	readonly resourceClass: SpeculativeResourceProfile["class"];
	readonly resourceUnits: number;
	readonly resourceCaptureMs?: number;
	readonly resourceCaptureBytes?: number;
	readonly resourceCaptureFiles?: number;
	readonly validationMs?: number;
	readonly validationBytes?: number;
	readonly validationFiles?: number;
	readonly validationMode?: "watcher" | "exact";
	readonly estimatedCacheBytes?: number;
	readonly sandboxSetupMs?: number;
	readonly changeCollectionMs?: number;
	readonly commitMs?: number;
	readonly commitValidationMs?: number;
	readonly commitValidationBytes?: number;
	readonly commitValidationFiles?: number;
	readonly actorLeadMs?: number;
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
					consumeOverheadMs: number;
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
	readonly authorizeCandidate?: (input: {
		readonly stateData: StateData;
		readonly consumeInput: ConsumeInput;
		readonly settings: SpeculativeActionSettings;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
		readonly tool: string;
		readonly concrete: Record<string, unknown>;
		readonly signal?: AbortSignal;
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
	readonly candidateSizeBytes?: (input: {
		readonly output: Output;
		readonly candidate: SpeculativeCandidate;
	}) => number;
	readonly candidateExecutionMetrics?: (input: {
		readonly output: Output;
		readonly candidate: SpeculativeCandidate;
	}) => Partial<Pick<SpeculativeCandidate, "sandboxSetupMs" | "changeCollectionMs">>;
	readonly prepareCandidate?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeDraftCandidate;
		readonly signal: AbortSignal;
	}) => MaybePromise<void>;
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
	readonly releaseResourceVersion?: (version: unknown) => void;
	readonly isResourceExpired?: (input: {
		readonly stateData: StateData;
		readonly consumeInput?: ConsumeInput;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
	}) => MaybePromise<boolean | ResourceValidationResult>;
	readonly watchResourceVersion?: (input: {
		readonly stateData: StateData;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
		readonly onInvalidated: (changedPath?: string) => void;
	}) => MaybePromise<(() => void) | undefined>;
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
	readonly continuePatternAware?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeCandidate;
		readonly patternID: string;
		readonly patternContext: unknown;
		readonly output: Output;
		readonly parentConfirmed: boolean;
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
		readonly signal?: AbortSignal;
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
	readonly settingsChanged: (settings: SpeculativeActionSettings) => Promise<void>;
	readonly releaseSession: (sessionID: SessionID) => Promise<void>;
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
	run: SpeculativeJobRun<Output>;
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
	readonly pendingActionSequences: Set<number>;
	actionSequence: number;
	admittedCandidates: number;
	drafterAttempted: boolean;
	drafterFeedback?: "success" | "failure";
	drafterPlanMismatch?: boolean;
	pendingDrafterMismatch?: {
		readonly key: ActionKey;
		readonly actualAction: string;
		readonly predictedAction?: string;
	};
	terminal: boolean;
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

class SpeculativeJobError extends Error {
	readonly reason: string;

	constructor(reason: string, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.reason = reason;
		this.name = "SpeculativeJobError";
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
	const wallTimes = new Map<SessionID, number>();
	const actionSequences = new Map<SessionID, number>();
	const schedulers = new Map<SessionID, ToolSpeculationScheduler<RuntimeCandidate<Output>>>();
	const candidateOwners = new WeakMap<RuntimeCandidate<Output>, TurnState<SessionID, Output, StateData>>();
	const serviceTimes = new Map<string, { count: number; averageMs: number }>();
	const executionOverheadTimes = new Map<string, { count: number; averageMs: number }>();
	const hitOverheadTimes = new Map<string, { count: number; averageMs: number }>();
	const actorLeadTimes = new Map<string, { count: number; averageMs: number }>();
	const drafterBackoff = new Map<SessionID, { failures: number; skips: number }>();
	let notifiedMasterEnabled: boolean | undefined;

	const turnKey = (input: TurnInput<SessionID>): string => `${String(input.sessionID)}:${input.turnID}`;
	const persistentKey = (sessionID: SessionID, key: ActionKey): string => `${String(sessionID)}:${key.key}`;
	const sessionPrefix = (sessionID: SessionID): string => `${String(sessionID)}:`;
	const resourceCacheLimit = (settings: SpeculativeActionSettings): number =>
		Number.isFinite(settings.resourceCacheMaxEntries) ? Math.max(1, Math.floor(settings.resourceCacheMaxEntries)) : 1;
	const resourceCacheByteLimit = (settings: SpeculativeActionSettings): number =>
		typeof settings.resourceCacheMaxBytes === "number" && Number.isFinite(settings.resourceCacheMaxBytes)
			? Math.max(1, Math.floor(settings.resourceCacheMaxBytes))
			: 256 * 1024 * 1024;
	const schedulerFor = (sessionID: SessionID): ToolSpeculationScheduler<RuntimeCandidate<Output>> => {
		const existing = schedulers.get(sessionID);
		if (existing) return existing;
		const created = new ToolSpeculationScheduler<RuntimeCandidate<Output>>();
		schedulers.set(sessionID, created);
		return created;
	};

	const observeAverage = (
		target: Map<string, { count: number; averageMs: number }>,
		tool: string,
		durationMs: number,
	): void => {
		const duration = Math.max(0, durationMs);
		const current = target.get(tool) ?? { count: 0, averageMs: 0 };
		const count = current.count + 1;
		target.set(tool, { count, averageMs: current.averageMs + (duration - current.averageMs) / count });
	};
	const observeServiceTime = (tool: string, durationMs: number): void =>
		observeAverage(serviceTimes, tool, durationMs);
	const observeExecutionOverhead = (tool: string, durationMs: number): void =>
		observeAverage(executionOverheadTimes, tool, durationMs);
	const observeHitOverhead = (tool: string, durationMs: number): void =>
		observeAverage(hitOverheadTimes, tool, durationMs);
	const schedulingKey = (source: PredictionLease["source"], tool: string, horizon?: number): string =>
		`${source}:${tool}:${horizon === undefined ? "*" : Math.max(0, Math.floor(horizon))}`;
	const observedLeadTime = (source: PredictionLease["source"], tool: string, horizon?: number): number | undefined =>
		actorLeadTimes.get(schedulingKey(source, tool, horizon))?.averageMs ??
		actorLeadTimes.get(schedulingKey(source, tool))?.averageMs;
	const observeLeadTime = (
		source: PredictionLease["source"],
		tool: string,
		durationMs: number,
		horizon?: number,
	): void => {
		observeAverage(actorLeadTimes, schedulingKey(source, tool), durationMs);
		if (horizon !== undefined) observeAverage(actorLeadTimes, schedulingKey(source, tool, horizon), durationMs);
	};
	const masterEnabled = (settings: SpeculativeActionSettings): boolean =>
		settings.enabled && settings.mode === "predict_action_single_step";
	const sourceEnabled = (settings: SpeculativeActionSettings, source: "drafter" | "pattern_aware"): boolean =>
		masterEnabled(settings) &&
		(source === "drafter"
			? (settings.drafterEnabled ?? DEFAULTS.drafterEnabled)
			: (settings.patternAware?.enabled ?? false));
	const latestSettings = async (): Promise<SpeculativeActionSettings | undefined> => {
		try {
			return await adapter.settings();
		} catch {
			return undefined;
		}
	};
	const adaptiveDrafter = (state: TurnState<SessionID, Output, StateData>): boolean =>
		state.settings.adaptiveDrafter ?? DEFAULTS.adaptiveDrafter;
	const candidateLimit = (settings: SpeculativeActionSettings): number =>
		clampCandidateLimit(settings.candidateLimit ?? settings.maxCandidates ?? DEFAULTS.candidateLimit);
	const concurrentActionLimit = (settings: SpeculativeActionSettings): number =>
		clampCandidateLimit(settings.maxConcurrentActions ?? settings.maxCandidates ?? DEFAULTS.maxConcurrentActions);
	const takeDrafterOpportunity = (sessionID: SessionID): boolean => {
		const feedback = drafterBackoff.get(sessionID);
		if (!feedback?.skips) return true;
		feedback.skips--;
		return false;
	};
	const recordDrafterFailure = (
		state: TurnState<SessionID, Output, StateData>,
		candidate?: RuntimeCandidate<Output>,
	): void => {
		if (!adaptiveDrafter(state) || (!state.drafterAttempted && !candidate) || state.drafterFeedback) return;
		if (candidate && !candidate.leases.some((lease) => lease.source === "drafter")) return;
		state.drafterFeedback = "failure";
		const feedback = drafterBackoff.get(state.sessionID) ?? { failures: 0, skips: 0 };
		feedback.failures++;
		if (feedback.failures >= 2) {
			feedback.skips = Math.max(
				feedback.skips,
				Math.min(candidateLimit(state.settings), 2 ** Math.max(0, feedback.failures - 2)),
			);
		}
		drafterBackoff.set(state.sessionID, feedback);
	};
	const matchPredictionLeases = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		actionSequence: number,
	): Promise<void> => {
		const matched = candidate.leases.filter(
			(lease) =>
				lease.state === "active" &&
				(lease.validThroughActionSeq === undefined || actionSequence <= lease.validThroughActionSeq),
		);
		for (const lease of matched) {
			lease.state = "matched";
			lease.resolvedActionSeq = actionSequence;
			if (lease.source !== "pattern_aware" || !lease.patternID || !adapter.onPatternResolved) continue;
			try {
				await adapter.onPatternResolved(lease.patternID, "consumed", lease.patternContext);
			} catch {
				// Pattern feedback must not alter tool semantics.
			}
		}
		if (matched.some((lease) => lease.source === "drafter")) {
			state.drafterFeedback = "success";
			drafterBackoff.delete(state.sessionID);
		}
	};

	const schedulingMetadata = (
		draft: SpeculativeDraftCandidate,
		action: ActionKey,
		source: PredictionLease["source"],
	): SpeculativeSchedulingMetadata => {
		const empiricalProbability =
			typeof draft.empiricalProbability === "number" && Number.isFinite(draft.empiricalProbability)
				? Math.max(0, Math.min(1, draft.empiricalProbability))
				: undefined;
		const measured = serviceTimes.get(action.tool)?.averageMs;
		const expectedDurationMs = Math.max(1, draft.expectedDurationMs ?? measured ?? 1);
		const expectedLeadMs = observedLeadTime(source, action.tool, draft.horizon);
		const expectedHiddenMs = Math.min(expectedDurationMs, expectedLeadMs ?? expectedDurationMs);
		const expectedBenefitMs = Math.max(
			0,
			Math.min(
				expectedHiddenMs,
				draft.expectedLatencyBenefitMs ??
					(empiricalProbability === undefined ? expectedHiddenMs : empiricalProbability * expectedHiddenMs),
			),
		);
		const base = resourceProfile(action.tool, action.execution);
		const overheadCostMs =
			(executionOverheadTimes.get(action.tool)?.averageMs ?? 0) +
			(hitOverheadTimes.get(action.tool)?.averageMs ?? 0) * (empiricalProbability ?? 1);
		return {
			expectedDurationMs,
			...(expectedLeadMs !== undefined ? { expectedLeadMs } : {}),
			expectedBenefitMs,
			overheadCostMs,
			resource: {
				...base,
				units: Math.max(1, Math.floor(draft.resourceDemand ?? base.units)),
			},
		};
	};

	const draftPriority = (draft: SpeculativeDraftCandidate, batchSource: PredictionLease["source"]): number => {
		const probability =
			typeof draft.empiricalProbability === "number" && Number.isFinite(draft.empiricalProbability)
				? Math.max(0, Math.min(1, draft.empiricalProbability))
				: 1;
		const duration =
			typeof draft.expectedDurationMs === "number" && Number.isFinite(draft.expectedDurationMs)
				? Math.max(1, draft.expectedDurationMs)
				: (serviceTimes.get(draft.tool)?.averageMs ?? 1);
		const source = draft.source ?? batchSource;
		const hidden = Math.min(duration, observedLeadTime(source, draft.tool, draft.horizon) ?? duration);
		return Math.min(hidden, draft.expectedLatencyBenefitMs ?? probability * hidden);
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
			if (candidate.run.status === "closed") continue;
			candidates.set(candidate.key.key, candidate);
		}
		return [...candidates.values()];
	};

	const cacheSnapshot = (state: TurnState<SessionID, Output, StateData>): SpeculativeCacheSnapshot => {
		const candidates = cachedCandidates(state);
		const running = candidates.filter((candidate) => candidate.run.status === "running").length;
		return {
			cacheEntries: candidates.length,
			cacheCapacity: state.settings.resourceCacheMaxEntries,
			cacheBytes: candidates.reduce((total, candidate) => total + candidate.estimatedBytes, 0),
			cacheByteCapacity: resourceCacheByteLimit(state.settings),
			cacheRunning: running,
			cacheCompleted: candidates.length - running,
			activeCandidates: running,
			turnCandidates: candidates.filter((candidate) => candidate.reuse.kind === "exclusive").length,
			resourceCandidates: candidates.filter((candidate) => candidate.reuse.kind === "shared").length,
			cacheTools: [...new Set(candidates.map((candidate) => candidate.key.tool))].sort(),
			cacheExecutions: [...new Set(candidates.map((candidate) => candidate.key.execution))].sort(),
			observedWallMs:
				(wallTimes.get(state.sessionID) ?? 0) + (state.finished ? 0 : Math.max(0, Date.now() - state.startedAt)),
		};
	};

	const schedulingEventFields = (
		candidate: RuntimeCandidate<Output>,
		source: SpeculativeSchedulingEventFields["source"] = candidate.source,
	): SpeculativeSchedulingEventFields => ({
		source,
		...(candidate.patternID ? { patternID: candidate.patternID } : {}),
		...(candidateFutureHorizon(candidate) !== undefined ? { futureHorizon: candidateFutureHorizon(candidate) } : {}),
		...(candidate.empiricalProbability !== undefined ? { empiricalProbability: candidate.empiricalProbability } : {}),
		...(candidate.conditionalProbability !== undefined
			? { conditionalProbability: candidate.conditionalProbability }
			: {}),
		...(candidate.depth !== undefined ? { patternDepth: candidate.depth } : {}),
		expectedDurationMs: candidate.scheduling.expectedDurationMs,
		...(candidate.scheduling.expectedLeadMs !== undefined
			? { expectedLeadMs: candidate.scheduling.expectedLeadMs }
			: {}),
		expectedBenefitMs: candidate.scheduling.expectedBenefitMs,
		expectedWasteMs: Math.max(0, candidate.scheduling.expectedDurationMs - candidate.scheduling.expectedBenefitMs),
		...(candidate.scheduling.overheadCostMs !== undefined
			? { overheadCostMs: candidate.scheduling.overheadCostMs }
			: {}),
		schedulerUtility: candidate.utility,
		resourceClass: candidate.scheduling.resource.class,
		resourceUnits: candidate.scheduling.resource.units,
		...(candidate.resourceCaptureMs !== undefined ? { resourceCaptureMs: candidate.resourceCaptureMs } : {}),
		...(candidate.resourceCaptureBytes !== undefined ? { resourceCaptureBytes: candidate.resourceCaptureBytes } : {}),
		...(candidate.resourceCaptureFiles !== undefined ? { resourceCaptureFiles: candidate.resourceCaptureFiles } : {}),
		validationMs: candidate.validationMs,
		validationBytes: candidate.validationBytes,
		validationFiles: candidate.validationFiles,
		...(candidate.validationMode ? { validationMode: candidate.validationMode } : {}),
		estimatedCacheBytes: candidate.estimatedBytes,
		...(candidate.sandboxSetupMs !== undefined ? { sandboxSetupMs: candidate.sandboxSetupMs } : {}),
		...(candidate.changeCollectionMs !== undefined ? { changeCollectionMs: candidate.changeCollectionMs } : {}),
		...(candidate.commitMs !== undefined ? { commitMs: candidate.commitMs } : {}),
		...(candidate.commitValidationMs !== undefined ? { commitValidationMs: candidate.commitValidationMs } : {}),
		...(candidate.commitValidationBytes !== undefined
			? { commitValidationBytes: candidate.commitValidationBytes }
			: {}),
		...(candidate.commitValidationFiles !== undefined
			? { commitValidationFiles: candidate.commitValidationFiles }
			: {}),
		...(candidate.actorLeadMs !== undefined ? { actorLeadMs: candidate.actorLeadMs } : {}),
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
			executionMs: candidateExecutionMs(candidate),
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
		const removed = persistentCandidates.delete(key);
		if (removed) releaseCandidateResourceVersion(candidate);
		return removed;
	};

	const releaseCandidateResourceVersion = (candidate: RuntimeCandidate<Output>): void => {
		const release = candidate.releaseResourceVersion;
		candidate.releaseResourceVersion = undefined;
		try {
			release?.();
		} catch {
			// Resource cleanup must not alter actor semantics.
		}
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

	const trimPersistentCandidates = (
		sessionID: SessionID,
		settings: SpeculativeActionSettings,
		protectedCandidate?: RuntimeCandidate<Output>,
	): RuntimeCandidate<Output>[] => {
		const prefix = sessionPrefix(sessionID);
		const evicted: RuntimeCandidate<Output>[] = [];
		while (true) {
			const entries = [...persistentCandidates.entries()].filter(([key]) => key.startsWith(prefix));
			const overEntries = entries.length > resourceCacheLimit(settings);
			const overBytes =
				entries.reduce((total, [, candidate]) => total + candidate.estimatedBytes, 0) >
				resourceCacheByteLimit(settings);
			if (!overEntries && !overBytes) break;
			const victim = entries.find(
				([, candidate]) => candidate !== protectedCandidate && candidate.schedulerOutcome !== "promoted",
			);
			if (!victim) break;
			persistentCandidates.delete(victim[0]);
			releaseCandidateResourceVersion(victim[1]);
			evicted.push(victim[1]);
		}
		return evicted;
	};

	const addPersistentCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): RuntimeCandidate<Output>[] => {
		persistentCandidates.set(persistentKey(state.sessionID, candidate.key), candidate);
		return trimPersistentCandidates(state.sessionID, state.settings, candidate);
	};

	const settlePatternLeases = async (
		candidate: RuntimeCandidate<Output>,
		state: "expired" | "invalidated",
	): Promise<void> => {
		for (const lease of candidate.leases) {
			if (lease.state !== "active" || lease.source !== "pattern_aware") continue;
			lease.state = state;
			if (!lease.patternID || !adapter.onPatternResolved) continue;
			try {
				await adapter.onPatternResolved(lease.patternID, "unused", lease.patternContext);
			} catch {
				// Pattern feedback must not alter tool semantics.
			}
		}
	};

	const completePredictionMatch = (candidate: RuntimeCandidate<Output>, actionSequence: number): void => {
		for (const lease of candidate.leases) {
			if (lease.state === "matched" && lease.resolvedActionSeq === actionSequence) lease.state = "hit";
		}
	};

	const expireDrafterLeases = (
		candidate: RuntimeCandidate<Output>,
		providerTurnID?: string,
		state: PredictionLease["state"] = "expired",
	): void => {
		for (const lease of candidate.leases) {
			if (lease.state !== "active" || lease.source !== "drafter") continue;
			if (providerTurnID !== undefined && lease.providerTurnID !== providerTurnID) continue;
			lease.state = state;
		}
	};

	const expireDrafterPlan = (state: TurnState<SessionID, Output, StateData>): void => {
		for (const candidate of availableCandidates(state).values()) expireDrafterLeases(candidate);
	};

	const pruneResolvedLeases = (candidate: RuntimeCandidate<Output>): void => {
		const unresolved = candidate.leases.filter((lease) => lease.state === "active" || lease.state === "matched");
		candidate.leases.splice(0, candidate.leases.length, ...unresolved);
	};

	const closeCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason: string,
		leaseState: "expired" | "invalidated" = "invalidated",
		publish = false,
		schedulerOutcome: "preempted" | "discarded" = "discarded",
	): Promise<boolean> => {
		if (candidate.run.status === "closed") return false;
		const completedAt = candidateCompletedAt(candidate);
		const executionMs = candidateExecutionMs(candidate);
		candidate.schedulerOutcome = schedulerOutcome;
		candidate.run = {
			status: "closed",
			reason,
			...(completedAt !== undefined ? { completedAt } : {}),
			...(executionMs > 0 ? { executionMs } : {}),
		};
		expireDrafterLeases(candidate, undefined, leaseState);
		await settlePatternLeases(candidate, leaseState);
		for (const lease of candidate.leases) {
			if (lease.state === "matched") lease.state = "invalidated";
		}
		schedulerFor(state.sessionID).discard(candidate);
		if (state.candidates.get(candidate.key.key) === candidate) state.candidates.delete(candidate.key.key);
		removePersistentCandidate(state, candidate);
		releaseCandidateResourceVersion(candidate);
		candidate.controller.abort();
		candidate.execution.resolve({ ok: false, error: new Error(reason) });
		if (publish) await publishCancelled(state, candidate, reason);
		return true;
	};

	const preemptCandidate = async (
		candidate: RuntimeCandidate<Output>,
		reason = "scheduler_preempted",
		outcome: "preempted" | "discarded" = "preempted",
		publish = true,
	): Promise<void> => {
		const owner = candidateOwners.get(candidate);
		if (!owner) {
			candidate.schedulerOutcome = outcome;
			candidate.run = { status: "closed", reason };
			releaseCandidateResourceVersion(candidate);
			candidate.controller.abort();
			candidate.execution.resolve({ ok: false, error: new Error(reason) });
			return;
		}
		await closeCandidate(owner, candidate, reason, "invalidated", publish, outcome);
		if (publish) await publishCache(owner);
	};

	const preemptForAuthoritative = async (
		state: TurnState<SessionID, Output, StateData>,
		resource: SpeculativeResourceProfile,
	): Promise<void> => {
		for (const candidate of schedulerFor(state.sessionID).preemptForAuthoritative(
			resource,
			speculativeResourceBudget(concurrentActionLimit(state.settings)),
		)) {
			await preemptCandidate(candidate);
		}
	};

	const disableSession = async (
		sessionID: SessionID,
		reason = "speculative_action_disabled",
		publish = true,
	): Promise<void> => {
		const candidates = new Set<RuntimeCandidate<Output>>(sessionPersistentCandidates(sessionID));
		for (const [key, state] of turns) {
			if (state.sessionID !== sessionID) continue;
			state.finished = true;
			state.terminal = true;
			state.predictionController.abort();
			for (const candidate of state.candidates.values()) candidates.add(candidate);
			turns.delete(key);
		}
		for (const candidate of candidates) await preemptCandidate(candidate, reason, "discarded", publish);
		drafterBackoff.delete(sessionID);
		if (!schedulerFor(sessionID).snapshot().length) schedulers.delete(sessionID);
	};

	const settingsChanged = async (settings: SpeculativeActionSettings): Promise<void> => {
		notifiedMasterEnabled = masterEnabled(settings);
		if (notifiedMasterEnabled) return;
		const sessions = new Set<SessionID>(schedulers.keys());
		for (const state of turns.values()) sessions.add(state.sessionID);
		for (const candidate of persistentCandidates.values()) {
			const owner = candidateOwners.get(candidate);
			if (owner) sessions.add(owner.sessionID);
		}
		await Promise.all([...sessions].map((sessionID) => disableSession(sessionID)));
	};

	const releaseSession = async (sessionID: SessionID): Promise<void> => {
		await disableSession(sessionID, "session_deleted", false);
		tokenTotals.delete(sessionID);
		wallTimes.delete(sessionID);
		actionSequences.delete(sessionID);
		schedulers.delete(sessionID);
		drafterBackoff.delete(sessionID);
	};

	const reconcilePersistentCandidates = async (state: TurnState<SessionID, Output, StateData>): Promise<void> => {
		for (const candidate of sessionPersistentCandidates(state.sessionID)) {
			const configured =
				candidate.key.execution === "resource_cached"
					? state.settings.tools.resourceCached.includes(candidate.tool)
					: state.settings.tools.sandbox.includes(candidate.tool);
			if (!configured) await preemptCandidate(candidate, "tool_disabled", "discarded");
		}
		for (const candidate of trimPersistentCandidates(state.sessionID, state.settings)) {
			await preemptCandidate(candidate, "resource_cache_limit_changed", "discarded");
		}
	};

	const cancelCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason: string,
		detail?: string,
	): Promise<void> => {
		expireDrafterLeases(candidate, state.turnID);
		if (candidate.reuse.kind === "exclusive" && !hasActivePredictionLease(candidate)) {
			await closeCandidate(state, candidate, reason);
		}
		await publishCancelled(state, candidate, reason, detail);
	};

	const expireCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): Promise<void> => {
		await closeCandidate(state, candidate, "candidate_expired");
	};

	const expirePatternLeasesAfterAction = async (state: TurnState<SessionID, Output, StateData>): Promise<void> => {
		const settledThrough =
			state.pendingActionSequences.size > 0 ? Math.min(...state.pendingActionSequences) - 1 : state.actionSequence;
		for (const candidate of availableCandidates(state).values()) {
			if (candidate.run.status === "closed") continue;
			let expired = false;
			for (const lease of candidate.leases) {
				if (
					lease.state !== "active" ||
					lease.source !== "pattern_aware" ||
					lease.validThroughActionSeq === undefined ||
					lease.validThroughActionSeq > settledThrough
				) {
					continue;
				}
				lease.state = "expired";
				expired = true;
				if (!lease.patternID || !adapter.onPatternResolved) continue;
				try {
					await adapter.onPatternResolved(lease.patternID, "unused", lease.patternContext);
				} catch {
					// Pattern feedback must not alter tool semantics.
				}
			}
			if (expired && candidate.reuse.kind === "exclusive" && !hasActivePredictionLease(candidate)) {
				await closeCandidate(state, candidate, "pattern_horizon_expired", "expired", true);
			}
		}
	};

	const invalidateChangedResources = async (
		state: TurnState<SessionID, Output, StateData>,
		action: ActionKey,
		excluded?: RuntimeCandidate<Output>,
	): Promise<void> => {
		if (action.execution !== "sandbox") return;
		for (const candidate of availableCandidates(state).values()) {
			if (candidate === excluded || candidate.reuse.kind !== "shared") continue;
			if (
				action.tool !== "bash" &&
				!action.resources.some((changed) =>
					candidate.key.resources.some((cached) => resourcePathsOverlap(changed, cached)),
				)
			) {
				continue;
			}
			await expireCandidate(state, candidate);
			await publishCancelled(state, candidate, "authoritative_resource_changed");
		}
	};

	const findCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		actual: ActionKey,
		actionSequence: number,
	): RuntimeCandidate<Output> | undefined => {
		const exact =
			state.candidates.get(actual.key) ?? persistentCandidates.get(persistentKey(state.sessionID, actual));
		if (exact && candidateCanMatch(exact, actionSequence) && claimCandidate(exact, state.turnID)) {
			touchPersistentCandidate(state, exact);
			return exact;
		}
		for (const candidate of availableCandidates(state).values()) {
			if (!candidateCanMatch(candidate, actionSequence)) continue;
			if (adapter.projectOutput === undefined && candidate.key.key !== actual.key) continue;
			if (!actionKeyMatches(candidate.key, actual)) continue;
			if (!claimCandidate(candidate, state.turnID)) continue;
			touchPersistentCandidate(state, candidate);
			return candidate;
		}
		return undefined;
	};

	const candidateCanMatch = (candidate: RuntimeCandidate<Output>, actionSequence: number): boolean => {
		if (candidate.run.status === "closed") return false;
		if (candidate.reuse.kind === "shared") return true;
		if (candidate.reuse.state !== "available") return false;
		return candidate.leases.some(
			(lease) =>
				lease.state === "active" &&
				(lease.validThroughActionSeq === undefined || actionSequence <= lease.validThroughActionSeq),
		);
	};

	const claimCandidate = (candidate: RuntimeCandidate<Output>, turnID: string): boolean => {
		if (candidate.reuse.kind === "shared") return candidate.run.status !== "closed";
		if (candidate.reuse.state !== "available") return false;
		candidate.reuse.state = "claimed";
		candidate.reuse.claimTurnID = turnID;
		return true;
	};

	const findReusableCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		action: ActionKey,
	): Promise<RuntimeCandidate<Output> | undefined> => {
		for (const candidate of availableCandidates(state).values()) {
			if (candidate.run.status === "closed") continue;
			if (candidate.reuse.kind === "exclusive" && candidate.reuse.state !== "available") continue;
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

	const continuationAnchorActionSeq = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): number =>
		candidate.authoritativeSequence ??
		Math.max(
			state.actionSequence,
			...candidate.leases.flatMap((lease) =>
				lease.source === "pattern_aware" && lease.validThroughActionSeq !== undefined
					? [lease.validThroughActionSeq]
					: [],
			),
		);

	const attachPredictionLease = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		draft: SpeculativeDraftCandidate,
		source: PredictionLease["source"],
		anchorActionSeq: number,
	): Promise<void> => {
		pruneResolvedLeases(candidate);
		if (source === "drafter") {
			if (
				!candidate.leases.some(
					(lease) =>
						lease.state === "active" && lease.source === "drafter" && lease.providerTurnID === state.turnID,
				)
			) {
				candidate.leases.push({
					id: `${candidate.id}:drafter:${state.turnID}`,
					source: "drafter",
					providerTurnID: state.turnID,
					anchorActionSeq,
					state: "active",
				});
			}
			return;
		}
		if (!draft.patternID) return;
		if (candidate.leases.some((lease) => lease.state === "active" && lease.patternID === draft.patternID)) return;
		const horizon = Math.max(0, Math.floor(draft.horizon ?? 0));
		candidate.leases.push({
			id: `${candidate.id}:pattern:${draft.patternID}:${anchorActionSeq}`,
			source: "pattern_aware",
			patternID: draft.patternID,
			...(draft.patternContext !== undefined ? { patternContext: draft.patternContext } : {}),
			providerTurnID: state.turnID,
			anchorActionSeq,
			horizon,
			validThroughActionSeq: anchorActionSeq + horizon + 1,
			state: "active",
		});
		const scheduling = schedulingMetadata(draft, candidate.key, source);
		if (expectedUtility(scheduling) > candidate.utility) {
			candidate.empiricalProbability = draft.empiricalProbability;
			candidate.conditionalProbability = draft.conditionalProbability;
			candidate.depth = draft.depth;
			candidate.scheduling = scheduling;
			candidate.utility = expectedUtility(scheduling);
			schedulerFor(state.sessionID).update(candidate, scheduling);
		}
		try {
			await adapter.onPatternLaunched?.(draft.patternID, draft.patternContext);
		} catch {
			// Pattern feedback must not alter tool semantics.
		}
		if (persistentCandidates.get(persistentKey(state.sessionID, candidate.key)) !== candidate) {
			for (const evicted of addPersistentCandidate(state, candidate)) {
				await preemptCandidate(evicted, "resource_cache_evicted", "discarded");
			}
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
		predictionAnchorActionSeq = state.actionSequence,
	): Promise<number> => {
		let accepted = 0;
		const enabled = await latestSettings();
		if (!enabled || !sourceEnabled(enabled, batchSource)) {
			if (!enabled || !masterEnabled(enabled)) state.terminal = true;
			return accepted;
		}
		const turnCandidateLimit = candidateLimit(state.settings);
		const ordered = [...drafts].sort(
			(left, right) =>
				draftPriority(right, batchSource) - draftPriority(left, batchSource) ||
				(right.horizon ?? 0) - (left.horizon ?? 0) ||
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
				if (state.preparedHints.has(hintKey) || state.preparedHints.size >= turnCandidateLimit) continue;
				state.preparedHints.add(hintKey);
				if (adapter.prepareCandidate) {
					void Promise.resolve()
						.then(() =>
							adapter.prepareCandidate?.({
								startInput: input,
								data: state.data,
								settings: state.settings,
								candidate: draft,
								signal: state.predictionController.signal,
							}),
						)
						.catch(() => {
							// Preparation is best-effort and never executes the hinted action.
						});
				}
				continue;
			}
			if (state.terminal) return accepted;
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
			if (state.actorKeys.has(action.key)) {
				accepted++;
				continue;
			}
			const callID = `spec_${fastCandidateID(`${input.turnID}:${source}:${index}:${action.key}`)}`;
			const reusable = await findReusableCandidate(state, action);
			if (reusable) {
				await attachPredictionLease(state, reusable, draft, source, predictionAnchorActionSeq);
				accepted++;
				if (source === "pattern_aware" && reusable.run.status === "ready") {
					await continuePatternCandidate(state, input, reusable, reusable.run.output, false);
				}
				continue;
			}
			if (state.admittedCandidates >= turnCandidateLimit) return accepted;
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
			const current = await latestSettings();
			if (!current || !sourceEnabled(current, source)) {
				candidateController.abort();
				if (!current || !masterEnabled(current)) state.terminal = true;
				return accepted;
			}
			if (state.actorKeys.has(action.key)) {
				candidateController.abort();
				accepted++;
				continue;
			}
			if (state.terminal) {
				candidateController.abort();
				return accepted;
			}
			const horizon = source === "pattern_aware" ? Math.max(0, Math.floor(draft.horizon ?? 0)) : undefined;
			const sourceLease: PredictionLease = {
				id: `${callID}:${source}:${draft.patternID ?? state.turnID}`,
				source,
				...(draft.patternID ? { patternID: draft.patternID } : {}),
				...(draft.patternContext !== undefined ? { patternContext: draft.patternContext } : {}),
				providerTurnID: state.turnID,
				anchorActionSeq: predictionAnchorActionSeq,
				...(horizon !== undefined
					? { horizon, validThroughActionSeq: predictionAnchorActionSeq + horizon + 1 }
					: {}),
				state: "active",
			};
			const scheduling = schedulingMetadata(draft, action, source);
			const candidate: RuntimeCandidate<Output> = {
				id: callID,
				key: action,
				tool: draft.tool,
				input: concrete,
				reuse:
					action.execution === "resource_cached" ? { kind: "shared" } : { kind: "exclusive", state: "available" },
				run: { status: "running" },
				validationMs: 0,
				validationBytes: 0,
				validationFiles: 0,
				estimatedBytes: estimateValueBytes({ input: concrete, draftCandidate, predictedAction }),
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
				...(typeof draft.conditionalProbability === "number"
					? { conditionalProbability: Math.max(0, Math.min(1, draft.conditionalProbability)) }
					: {}),
				...(typeof draft.depth === "number" ? { depth: Math.max(0, Math.floor(draft.depth)) } : {}),
				scheduling,
				utility: expectedUtility(scheduling),
				...(draft.patternID ? { patternID: draft.patternID } : {}),
				leases: [sourceLease],
				execution: deferred<CandidateExecution<Output>>(),
				controller: candidateController,
				hits: 0,
			};
			const admission = schedulerFor(state.sessionID).admit(
				candidate,
				scheduling,
				speculativeResourceBudget(concurrentActionLimit(state.settings)),
			);
			if (!admission.admitted) {
				candidate.schedulerOutcome = "discarded";
				await publishCancelled(state, candidate, `scheduler_${admission.reason}`);
				continue;
			}
			for (const victim of admission.preempted) await preemptCandidate(victim);
			state.admittedCandidates++;
			state.candidates.set(action.key, candidate);
			candidateOwners.set(candidate, state);
			if (candidate.reuse.kind === "shared" || source === "pattern_aware") {
				for (const evicted of addPersistentCandidate(state, candidate)) {
					await preemptCandidate(evicted, "resource_cache_evicted", "discarded");
				}
			}
			accepted++;
			if (source === "pattern_aware" && draft.patternID) {
				try {
					await adapter.onPatternLaunched?.(draft.patternID, draft.patternContext);
				} catch {
					// Pattern feedback must not alter tool semantics.
				}
			}
			await publishStarted(state, candidate);
			let executionStarted = candidate.startedAt;
			void Promise.resolve()
				.then(async () => {
					await Promise.resolve();
					const current = await latestSettings();
					if (!current || !sourceEnabled(current, source)) {
						throw new SpeculativeJobError(
							current && masterEnabled(current) ? `${source}_disabled` : "speculative_action_disabled",
							new Error("speculative action source disabled"),
						);
					}
					if (adapter.prepareCandidate) {
						try {
							await adapter.prepareCandidate({
								startInput: input,
								data: state.data,
								settings: state.settings,
								candidate: draft,
								signal: candidateController.signal,
							});
						} catch (error) {
							throw new SpeculativeJobError("candidate_preparation_failed", error);
						}
					}
					const prepared = await latestSettings();
					if (!prepared || !sourceEnabled(prepared, source)) {
						throw new SpeculativeJobError(
							prepared && masterEnabled(prepared) ? `${source}_disabled` : "speculative_action_disabled",
							new Error("speculative action source disabled"),
						);
					}
					if (state.terminal) {
						throw new SpeculativeJobError(
							"request_finished_without_hit",
							new Error("speculative request finished"),
						);
					}
					if (
						(action.execution === "resource_cached" || action.tool === "bash") &&
						adapter.captureResourceVersion
					) {
						try {
							const captured = await adapter.captureResourceVersion({
								startInput: input,
								data: state.data,
								settings: state.settings,
								candidate: draft,
								tool: draft.tool,
								concrete,
								action,
								callID,
								index,
							});
							candidate.resourceVersion = captured;
							candidate.releaseResourceVersion = () => {
								adapter.releaseResourceVersion?.(captured);
							};
							Object.assign(candidate, resourceCaptureMetrics(captured));
						} catch (error) {
							throw new SpeculativeJobError("resource_capture_failed", error);
						}
					}
					if (action.execution === "resource_cached" && adapter.watchResourceVersion) {
						let releaseWatch: (() => void) | undefined;
						try {
							releaseWatch = await adapter.watchResourceVersion({
								stateData: state.data,
								action,
								candidate,
								onInvalidated: (changedPath) => {
									void preemptCandidate(
										candidate,
										changedPath ? `resource_changed:${changedPath}` : "resource_changed",
										"discarded",
									);
								},
							});
						} catch {}
						const releaseVersion = candidate.releaseResourceVersion;
						candidate.releaseResourceVersion = () => {
							releaseWatch?.();
							releaseVersion?.();
						};
					}
					if (candidate.run.status === "closed") {
						throw new SpeculativeJobError(candidate.run.reason, new Error(`speculative ${candidate.run.reason}`));
					}
					executionStarted = Date.now();
					candidate.executionStartedAt = executionStarted;
					return adapter.executeCandidate({
						startInput: input,
						data: state.data,
						candidate: draft,
						tool: draft.tool,
						concrete,
						action,
						callID,
						index,
						signal: candidateController.signal,
					});
				})
				.then(
					async (output) => {
						if (candidate.run.status === "closed") {
							candidate.execution.resolve({
								ok: false,
								error: new Error(`speculative_${candidate.run.reason}`),
							});
							return;
						}
						const completedAt = Date.now();
						const executionMs = Math.max(0, completedAt - executionStarted);
						candidate.run = { status: "ready", completedAt, executionMs, output };
						observeServiceTime(candidate.tool, executionMs);
						Object.assign(candidate, adapter.candidateExecutionMetrics?.({ output, candidate }) ?? {});
						observeExecutionOverhead(
							candidate.key.tool,
							(candidate.resourceCaptureMs ?? 0) +
								(candidate.sandboxSetupMs ?? 0) +
								(candidate.changeCollectionMs ?? 0),
						);
						candidate.estimatedBytes += Math.max(
							0,
							adapter.candidateSizeBytes?.({ output, candidate }) ?? estimateValueBytes(output),
						);
						schedulerFor(state.sessionID).complete(candidate);
						for (const evicted of trimPersistentCandidates(state.sessionID, state.settings, candidate)) {
							await preemptCandidate(evicted, "resource_cache_byte_limit", "discarded");
						}
						await publishCache(state);
						await publishCompleted(state, candidate);
						candidate.execution.resolve({ ok: true, output });
						if (action.execution !== "sandbox") {
							await continuePatternCandidate(
								state,
								input,
								candidate,
								output,
								candidate.hits > 0 ||
									candidate.leases.some((lease) => lease.state === "matched" || lease.state === "hit"),
							);
						}
					},
					async (error: unknown) => {
						if (candidate.run.status === "closed") {
							candidate.execution.resolve({ ok: false, error });
							return;
						}
						const reason = error instanceof SpeculativeJobError ? error.reason : "candidate_execution_failed";
						const completedAt = Date.now();
						const executionMs = Math.max(0, completedAt - executionStarted);
						candidate.run = { status: "closed", reason, completedAt, executionMs };
						schedulerFor(state.sessionID).discard(candidate);
						candidate.schedulerOutcome = "discarded";
						recordDrafterFailure(state, candidate);
						expireDrafterLeases(candidate, undefined, "invalidated");
						await settlePatternLeases(candidate, "invalidated");
						for (const lease of candidate.leases) {
							if (lease.state === "matched") lease.state = "invalidated";
						}
						if (state.candidates.get(candidate.key.key) === candidate) state.candidates.delete(candidate.key.key);
						removePersistentCandidate(state, candidate);
						releaseCandidateResourceVersion(candidate);
						await publishCancelled(state, candidate, reason, errorDetail(error));
						await publishCache(state);
						candidate.execution.resolve({ ok: false, error });
					},
				);
		}
		return accepted;
	};

	const continuePatternCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		input: StartInput,
		candidate: RuntimeCandidate<Output>,
		output: Output,
		parentConfirmed: boolean,
	): Promise<void> => {
		const settings = await latestSettings();
		if (!settings || !sourceEnabled(settings, "pattern_aware") || !adapter.continuePatternAware || state.terminal) {
			return;
		}
		for (const lease of candidate.leases) {
			if (
				lease.source !== "pattern_aware" ||
				!lease.patternID ||
				lease.state === "expired" ||
				lease.state === "invalidated"
			) {
				continue;
			}
			let prediction: SpeculativePrediction | undefined;
			try {
				prediction = await adapter.continuePatternAware({
					startInput: input,
					data: state.data,
					settings,
					candidate,
					patternID: lease.patternID,
					patternContext: lease.patternContext,
					output,
					parentConfirmed,
				});
			} catch {
				continue;
			}
			if (!prediction?.candidates.length || state.terminal) continue;
			await admitPredictions(
				state,
				input,
				prediction.candidates,
				0,
				0,
				tokenTotals.get(state.sessionID) ?? 0,
				"pattern_aware",
				candidateToolNames(settings),
				continuationAnchorActionSeq(state, candidate),
			);
		}
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
		const settings = await latestSettings();
		if (!adapter.recordAuthoritative || !settings || !sourceEnabled(settings, "pattern_aware") || state.finished) {
			return;
		}
		const concrete = asConcreteInput(actualCall.input);
		if (!concrete) return;
		const prediction = await adapter.recordAuthoritative({
			startInput: state.startInput as StartInput,
			data: state.data,
			settings,
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
			candidateToolNames(settings),
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
			if (adapter.predictPatternAware && sourceEnabled(state.settings, "pattern_aware")) {
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
					const immediatePatternCandidate = [...availableCandidates(state).values()].some((candidate) =>
						candidate.leases.some(
							(lease) => lease.state === "active" && lease.source === "pattern_aware" && lease.horizon === 0,
						),
					);
					const activeDrafterPlan = [...availableCandidates(state).values()].some(hasActiveSharedDrafterLease);
					if (adaptiveDrafter(state) && (immediatePatternCandidate || activeDrafterPlan)) return;
				} catch {
					// Learned predictions are optional; drafter prediction remains available.
				}
			}
			const current = await latestSettings();
			if (!current || !sourceEnabled(current, "drafter")) return;
			const activeDrafterPlan = [...availableCandidates(state).values()].some(hasActiveSharedDrafterLease);
			if (adaptiveDrafter(state) && activeDrafterPlan) return;
			if (adaptiveDrafter(state) && !takeDrafterOpportunity(input.sessionID)) return;
			const remainingCandidates = candidateLimit(state.settings) - state.admittedCandidates;
			if (remainingCandidates <= 0) return;
			const drafterSettings =
				remainingCandidates === candidateLimit(state.settings)
					? state.settings
					: { ...state.settings, candidateLimit: remainingCandidates, maxCandidates: remainingCandidates };

			state.drafterAttempted = true;
			const predictionStarted = Date.now();
			const prediction = await withTimeout(
				Promise.resolve(
					adapter.predict(input, drafterSettings, definitions, candidateNames, state.predictionController.signal),
				),
				Math.max(0, state.settings.predictionTimeoutMs),
				() => state.predictionController.abort(),
			);
			const predictionLatencyMs = Math.max(0, Date.now() - predictionStarted);
			const totalDraftTokens = (tokenTotals.get(input.sessionID) ?? 0) + prediction.draftTokens;
			tokenTotals.set(input.sessionID, totalDraftTokens);
			if (state.finished) return;
			if (!prediction.candidates.length) {
				recordDrafterFailure(state);
				if (!accepted) {
					state.noCandidateReported = true;
					await publishMiss(state, "no_candidate", undefined, "Drafter returned no tool-call candidates.");
				}
				return;
			}
			const drafterAccepted = await admitPredictions(
				state,
				input,
				prediction.candidates,
				predictionLatencyMs,
				prediction.draftTokens,
				totalDraftTokens,
				"drafter",
				candidateNames,
			);
			accepted += drafterAccepted;
			if (!drafterAccepted) recordDrafterFailure(state);
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
			recordDrafterFailure(state);
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
		if (!masterEnabled(settings) || notifiedMasterEnabled === false) {
			await disableSession(input.sessionID);
			return;
		}
		if (!candidateNames.length) {
			for (const candidate of sessionPersistentCandidates(input.sessionID)) {
				await preemptCandidate(candidate, "tool_disabled", "discarded");
			}
			return;
		}
		if (!definitions.length || signal?.aborted) return;

		const existing = turns.get(turnKey(input));
		if (existing) await finishState(existing, false);
		try {
			await adapter.onTurnStarted?.({ startInput: input, settings, definitions, candidateNames, signal });
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
			pendingActionSequences: new Set(),
			actionSequence: actionSequences.get(input.sessionID) ?? 0,
			admittedCandidates: 0,
			drafterAttempted: false,
			terminal: false,
			finished: false,
			noCandidateReported: false,
			predictionTimedOut: false,
			predictionPending: true,
		};
		turns.set(turnKey(input), state);
		await reconcilePersistentCandidates(state);
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
		const actorArrivedAt = Date.now();
		const settings = await latestSettings();
		if (!settings || !masterEnabled(settings)) {
			await disableSession(input.sessionID);
			return undefined;
		}
		const state = turns.get(turnKey(input));
		if (!state || signal?.aborted) return undefined;
		const actionSequence = (actionSequences.get(state.sessionID) ?? state.actionSequence) + 1;
		actionSequences.set(state.sessionID, actionSequence);
		state.actionSequence = Math.max(state.actionSequence, actionSequence);
		state.pendingActionSequences.add(actionSequence);
		try {
			const actualCall = adapter.actual(input);
			const actual = await adapter.actionKey(actualCall.tool, actualCall.input, {
				type: "consume",
				consumeInput: input,
			});
			const actualAction = diagnosticAction(actualCall.tool, actualCall.input, actual);
			const activeDrafterPlan = [...availableCandidates(state).values()].some(hasActiveDrafterLease);
			if (!actual) {
				if (activeDrafterPlan) state.drafterPlanMismatch = true;
				await preemptForAuthoritative(state, { class: "global", units: 1 });
				return undefined;
			}

			state.actorKeys.add(actual.key);
			const candidate = findCandidate(state, actual, actionSequence);
			if (!candidate) {
				const predicted = new Map(
					[...availableCandidates(state)].filter(([, item]) => hasActiveDrafterLease(item)),
				);
				if (predicted.size > 0) {
					state.drafterPlanMismatch = true;
					state.pendingDrafterMismatch = {
						key: actual,
						actualAction,
						predictedAction: candidatesDiagnostic(predicted),
					};
				}
				await preemptForAuthoritative(state, resourceProfile(actual.tool, actual.execution));
				return undefined;
			}
			if (activeDrafterPlan && !hasActiveDrafterLease(candidate)) state.drafterPlanMismatch = true;
			await matchPredictionLeases(state, candidate, actionSequence);
			const matchedLease =
				candidate.leases.find(
					(lease) =>
						lease.state === "matched" &&
						lease.resolvedActionSeq === actionSequence &&
						lease.source === "pattern_aware",
				) ??
				candidate.leases.find((lease) => lease.state === "matched" && lease.resolvedActionSeq === actionSequence);
			const actorLeadMs = Math.max(0, actorArrivedAt - (candidate.executionStartedAt ?? actorArrivedAt));
			candidate.actorLeadMs = actorLeadMs;
			observeLeadTime(matchedLease?.source ?? candidate.source, candidate.tool, actorLeadMs, matchedLease?.horizon);
			const inFlightAtMatch = candidate.run.status === "running";

			if (adapter.authorizeCandidate) {
				const actualConcrete = asConcreteInput(actualCall.input);
				if (!actualConcrete) return undefined;
				let authorization: CandidatePreflight;
				try {
					authorization = await adapter.authorizeCandidate({
						stateData: state.data,
						consumeInput: input,
						settings,
						action: actual,
						candidate,
						tool: actualCall.tool,
						concrete: actualConcrete,
						signal,
					});
				} catch (error) {
					authorization = { ok: false, reason: "authorization_failed", detail: errorDetail(error) };
				}
				if (!authorization.ok) {
					recordDrafterFailure(state, candidate);
					await expireCandidate(state, candidate);
					await publishMiss(state, authorization.reason, actual, authorization.detail, {
						actualAction,
						draftCandidate: candidate.draftCandidate,
						predictedAction: candidate.predictedAction,
					});
					return undefined;
				}
			}

			const consumeStarted = Date.now();
			if (await isExpired(adapter, state, input, actual, candidate)) {
				recordDrafterFailure(state, candidate);
				await expireCandidate(state, candidate);
				await publishMiss(state, "resource_expired", actual, undefined, {
					actualAction,
					draftCandidate: candidate.draftCandidate,
					predictedAction: candidate.predictedAction,
				});
				return undefined;
			}
			if (inFlightAtMatch) {
				schedulerFor(state.sessionID).promote(candidate);
				candidate.schedulerOutcome = "promoted";
			} else {
				candidate.schedulerOutcome = "reused";
			}
			const waitStarted = Date.now();
			const execution = await waitForCandidate(candidate.execution.promise, signal);
			if (!execution || signal?.aborted) return undefined;
			if (!execution.ok) {
				const reason =
					execution.error instanceof SpeculativeJobError ? execution.error.reason : "candidate_execution_failed";
				recordDrafterFailure(state, candidate);
				await closeCandidate(state, candidate, reason);
				await publishMiss(state, reason, actual, errorDetail(execution.error), {
					actualAction,
					draftCandidate: candidate.draftCandidate,
					predictedAction: candidate.predictedAction,
				});
				return undefined;
			}
			if (inFlightAtMatch && (await isExpired(adapter, state, input, actual, candidate))) {
				recordDrafterFailure(state, candidate);
				await expireCandidate(state, candidate);
				await publishMiss(
					state,
					"resource_expired",
					actual,
					"Resource changed before the speculative result could be consumed.",
					{
						actualAction,
						draftCandidate: candidate.draftCandidate,
						predictedAction: candidate.predictedAction,
					},
				);
				return undefined;
			}

			let output = execution.output;
			if (adapter.adoptCandidate) {
				let adopted: Output | undefined;
				try {
					adopted = await adapter.adoptCandidate({
						stateData: state.data,
						consumeInput: input,
						action: actual,
						candidate,
						output,
					});
				} catch (error) {
					recordDrafterFailure(state, candidate);
					await expireCandidate(state, candidate);
					await publishMiss(state, "adoption_failed", actual, errorDetail(error), {
						actualAction,
						draftCandidate: candidate.draftCandidate,
						predictedAction: candidate.predictedAction,
					});
					return undefined;
				}
				if (adopted === undefined) {
					recordDrafterFailure(state, candidate);
					await expireCandidate(state, candidate);
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
					recordDrafterFailure(state, candidate);
					await expireCandidate(state, candidate);
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
			const consumeOverheadMs = Math.max(0, Date.now() - consumeStarted);
			const executionMs = candidateExecutionMs(candidate) || Math.max(0, Date.now() - candidate.startedAt);
			observeHitOverhead(actual.tool, candidate.validationMs + (candidate.commitMs ?? 0));
			completePredictionMatch(candidate, actionSequence);
			candidate.hits++;
			candidate.authoritativeSequence = Math.max(candidate.authoritativeSequence ?? 0, actionSequence);
			if (candidate.reuse.kind === "exclusive") {
				candidate.reuse.state = "adopted";
				candidate.reuse.claimTurnID = undefined;
				const completedAt = candidateCompletedAt(candidate);
				candidate.run = {
					status: "closed",
					reason: "adopted",
					...(completedAt !== undefined ? { completedAt } : {}),
					executionMs,
				};
				schedulerFor(state.sessionID).discard(candidate);
				if (state.candidates.get(candidate.key.key) === candidate) state.candidates.delete(candidate.key.key);
				removePersistentCandidate(state, candidate);
				releaseCandidateResourceVersion(candidate);
			}
			if ((candidate.commitValidationFiles ?? 0) > 0) {
				await invalidateChangedResources(state, actual, candidate);
			}
			const patternLease = candidate.leases.find(
				(lease) =>
					lease.source === "pattern_aware" && lease.state === "hit" && lease.resolvedActionSeq === actionSequence,
			);
			const drafterLease = candidate.leases.find(
				(lease) =>
					lease.source === "drafter" && lease.state === "hit" && lease.resolvedActionSeq === actionSequence,
			);
			const eventSource: SpeculativeSchedulingEventFields["source"] = patternLease
				? "pattern_aware"
				: drafterLease
					? "drafter"
					: "cache";
			await emit({
				type: "hit",
				sessionID: state.sessionID,
				turnID: state.turnID,
				timestamp: Date.now(),
				tool: actual.tool,
				actionKeyHash: actual.hash,
				savedMs: Math.max(0, executionMs - consumeOverheadMs),
				waitedMs,
				consumeOverheadMs,
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
			if (actual.execution === "sandbox") {
				await continuePatternCandidate(state, state.startInput as StartInput, candidate, output, true);
			}
			return output;
		} finally {
			state.pendingActionSequences.delete(actionSequence);
			await expirePatternLeasesAfterAction(state);
		}
	};

	const actual = async (
		input: ConsumeInput & { readonly durationMs: number; readonly output?: Output },
	): Promise<void> => {
		const settings = await latestSettings();
		if (!settings || !masterEnabled(settings)) {
			await disableSession(input.sessionID);
			return;
		}
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
		if (key) await invalidateChangedResources(state, key);
		await recordAndPredict(state, input, actualCall, key, input.output, durationMs, false);
	};

	const finishState = async (state: TurnState<SessionID, Output, StateData>, terminal: boolean): Promise<void> => {
		if (state.finished) return;
		state.finished = true;
		state.terminal = terminal;
		state.predictionController.abort();
		wallTimes.set(state.sessionID, (wallTimes.get(state.sessionID) ?? 0) + Math.max(0, Date.now() - state.startedAt));
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
		const activeDrafterCandidate = [...availableCandidates(state).values()].find(hasActiveDrafterLease);
		const drafterPlanMissed = state.drafterPlanMismatch === true && state.drafterFeedback !== "success";
		if ((state.actorKeys.size > 0 && state.drafterAttempted && !state.drafterFeedback) || drafterPlanMissed) {
			recordDrafterFailure(state, activeDrafterCandidate);
			if (state.pendingDrafterMismatch) {
				await publishMiss(state, "key_mismatch", state.pendingDrafterMismatch.key, undefined, {
					predictedAction: state.pendingDrafterMismatch.predictedAction,
					actualAction: state.pendingDrafterMismatch.actualAction,
				});
			}
		}
		if (drafterPlanMissed) expireDrafterPlan(state);
		for (const candidate of availableCandidates(state).values()) {
			if (candidate.run.status === "closed") continue;
			if (terminal) {
				expireDrafterLeases(candidate, undefined, "invalidated");
				await settlePatternLeases(candidate, "invalidated");
				if (candidate.reuse.kind === "shared") continue;
				await closeCandidate(state, candidate, "request_finished_without_hit", "invalidated", true);
				continue;
			}
			if (candidate.reuse.kind === "shared") {
				if (state.drafterAttempted && state.drafterFeedback !== "success") {
					expireDrafterLeases(candidate, state.turnID);
				}
				continue;
			}
			expireDrafterLeases(candidate, state.turnID);
			if (hasActivePredictionLease(candidate)) continue;
			await cancelCandidate(state, candidate, "turn_finished_without_hit");
		}
		await publishCache(state);
		if (terminal) {
			try {
				await adapter.flushPatternStore?.();
			} catch {
				// Persistence is best-effort.
			}
		}
		if (!schedulerFor(state.sessionID).snapshot().length) schedulers.delete(state.sessionID);
	};

	const finishTerminalSession = async (sessionID: SessionID): Promise<void> => {
		const candidates = sessionPersistentCandidates(sessionID);
		if (!candidates.length) return;
		for (const candidate of candidates) await settlePatternLeases(candidate, "invalidated");
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
			if (candidate.run.status === "closed") continue;
			await preemptCandidate(candidate, reason, "discarded");
		}
	};

	const finishTurn = async (input: FinishInput): Promise<void> => {
		const settings = await latestSettings();
		if (!settings || !masterEnabled(settings)) {
			await disableSession(input.sessionID);
			return;
		}
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
			await closeCandidate(stateForEvents, candidate, "session_disposed", "invalidated", true);
		}
		tokenTotals.delete(sessionID);
		wallTimes.delete(sessionID);
		actionSequences.delete(sessionID);
		schedulers.delete(sessionID);
		drafterBackoff.delete(sessionID);
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
		for (const candidate of persistentCandidates.values()) {
			const owner = candidateOwners.get(candidate);
			if (owner) sessions.add(owner.sessionID);
		}
		for (const sessionID of sessions) await disposeSession(sessionID);
		schedulers.clear();
		drafterBackoff.clear();
		actionSequences.clear();
	};

	const inspect = (sessionID?: SessionID): SpeculativeRuntimeInspection => {
		const states = [...turns.values()].filter((state) => sessionID === undefined || state.sessionID === sessionID);
		const persistent =
			sessionID === undefined ? [...persistentCandidates.values()] : sessionPersistentCandidates(sessionID);
		return {
			activeTurns: states.length,
			turnCandidates: states.reduce(
				(count, state) =>
					count +
					[...state.candidates.values()].filter((candidate) => candidate.reuse.kind === "exclusive").length,
				0,
			),
			resourceCandidates: persistent.filter((candidate) => candidate.reuse.kind === "shared").length,
			pendingPredictions: states.filter((state) => state.predictionPending).length,
		};
	};

	return { startTurn, consume, actual, finishTurn, settingsChanged, releaseSession, disposeSession, dispose, inspect };
}

export function candidateToolNames(settings: SpeculativeActionSettings): readonly string[] {
	const resourceCached = new Set(settings.tools.resourceCached);
	const sandbox = new Set(settings.tools.sandbox);
	return KEYABLE_TOOLS.filter((tool) =>
		inferredExecution(tool) === "sandbox" ? sandbox.has(tool) : resourceCached.has(tool),
	);
}

export function candidateExecutionMs(candidate: SpeculativeCandidate): number {
	return candidate.run.status === "ready" || candidate.run.status === "closed" ? (candidate.run.executionMs ?? 0) : 0;
}

function candidateCompletedAt(candidate: SpeculativeCandidate): number | undefined {
	return candidate.run.status === "ready" || candidate.run.status === "closed" ? candidate.run.completedAt : undefined;
}

function hasActivePredictionLease(candidate: SpeculativeCandidate): boolean {
	return candidate.leases.some((lease) => lease.state === "active");
}

function hasActiveDrafterLease(candidate: SpeculativeCandidate): boolean {
	return candidate.leases.some((lease) => lease.state === "active" && lease.source === "drafter");
}

function hasActiveSharedDrafterLease(candidate: SpeculativeCandidate): boolean {
	return candidate.reuse.kind === "shared" && hasActiveDrafterLease(candidate);
}

function candidateFutureHorizon(candidate: SpeculativeCandidate): number | undefined {
	return candidate.leases.find(
		(lease) => lease.source === "pattern_aware" && (lease.state === "active" || lease.state === "hit"),
	)?.horizon;
}

function resourcePathsOverlap(left: string, right: string): boolean {
	const normalize = (value: string) =>
		value
			.replaceAll("\\", "/")
			.replace(/^\.\/+/, "")
			.replace(/\/+$/, "") || ".";
	const a = normalize(left);
	const b = normalize(right);
	return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
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
	if (!adapter.isResourceExpired || candidate.resourceVersion === undefined) return false;
	try {
		const result = await adapter.isResourceExpired({
			stateData: state.data,
			...(consumeInput === undefined ? {} : { consumeInput }),
			action,
			candidate,
		});
		if (typeof result === "boolean") return result;
		candidate.validationMs += finiteMetric(result.durationMs);
		candidate.validationBytes += finiteMetric(result.bytesRead);
		candidate.validationFiles += finiteMetric(result.filesRead);
		if (result.mode) candidate.validationMode = result.mode;
		return result.expired;
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
		pendingActionSequences: new Set(),
		actionSequence: 0,
		admittedCandidates: 0,
		drafterAttempted: false,
		terminal: true,
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

function resourceCaptureMetrics(value: unknown) {
	if (!value || typeof value !== "object") return {};
	const record = value as Record<string, unknown>;
	return {
		...(typeof record.captureMs === "number" && Number.isFinite(record.captureMs)
			? { resourceCaptureMs: Math.max(0, record.captureMs) }
			: {}),
		...(typeof record.captureBytes === "number" && Number.isFinite(record.captureBytes)
			? { resourceCaptureBytes: Math.max(0, record.captureBytes) }
			: {}),
		...(typeof record.captureFiles === "number" && Number.isFinite(record.captureFiles)
			? { resourceCaptureFiles: Math.max(0, record.captureFiles) }
			: {}),
	};
}

function finiteMetric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function estimateValueBytes(value: unknown, seen = new WeakSet<object>()): number {
	if (value === undefined || value === null) return 0;
	if (typeof value === "string") return Buffer.byteLength(value);
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean") return 1;
	if (value instanceof Uint8Array) return value.byteLength;
	if (typeof value !== "object") return 0;
	if (seen.has(value)) return 0;
	seen.add(value);
	if (Array.isArray(value)) return value.reduce((total, item) => total + estimateValueBytes(item, seen), 0);
	return Object.entries(value as Record<string, unknown>).reduce(
		(total, [key, item]) => total + Buffer.byteLength(key) + estimateValueBytes(item, seen),
		0,
	);
}

function fastCandidateID(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
