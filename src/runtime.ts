import type { ActionProjectionCoverage, ActionProjectionRule } from "./action-key-projection.ts";
import {
	CandidateAggregate,
	CandidateCatalog,
	type CandidateReuseState,
	type CandidateRunState,
} from "./candidate-lifecycle.ts";
import { BranchStore, JobTable, ResultCache } from "./candidate-stores.ts";
import type {
	ActionKey,
	ActionKeyMatch,
	ActionSemanticsRegistry,
	DrafterToolDefinition,
	SpeculativeExecution,
} from "./common.ts";
import {
	actionKeyCovers,
	actionKeyMatch,
	actionKeyMismatchReason,
	clampCandidateLimit,
	DEFAULTS,
	PI_ACTION_SEMANTICS,
} from "./common.ts";
import type { PatternAwareSettings } from "./pattern-aware.ts";
import type { PlanExecutionNode } from "./plan-execution-graph.ts";
import { PlanExecutionGraph } from "./plan-execution-graph.ts";
import type { PlanAction, PlanProposal, PlanUpdate } from "./plan-proposal.ts";
import { PlanLedger, samePlanActionExecution } from "./plan-proposal.ts";
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
	readonly source?: string;
	readonly proposalID?: string;
	readonly actionID?: string;
	readonly feedback?: unknown;
	readonly dependsOn?: PlanAction["dependsOn"];
	readonly horizon?: number;
	readonly empiricalProbability?: number;
	readonly conditionalProbability?: number;
	readonly expectedDurationMs?: number;
	readonly expectedLatencyBenefitMs?: number;
	readonly resourceDemand?: number;
	readonly depth?: number;
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
	readonly source: string;
	readonly proposalID?: string;
	readonly actionID?: string;
	feedback?: unknown;
	readonly providerTurnID: string;
	readonly anchorActionSeq: number;
	readonly horizon?: number;
	readonly validThroughActionSeq?: number;
	empiricalProbability?: number;
	continuationExpansion?: "speculative" | "confirmed";
	state: "active" | "matched" | "hit" | "expired" | "invalidated";
	resolvedActionSeq?: number;
}

export type SpeculativeJobRun<Output> = CandidateRunState<Output>;

export type SpeculativeJobReuse = CandidateReuseState;

export interface SpeculativeCandidate {
	readonly id: string;
	readonly key: ActionKey;
	readonly tool: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly reuse: SpeculativeJobReuse;
	readonly run: SpeculativeJobRun<unknown>;
	resourceVersion?: unknown;
	releaseResourceVersion?: () => void;
	resourceCaptureMs?: number;
	resourceCaptureBytes?: number;
	resourceCaptureFiles?: number;
	validationMs: number;
	validationBytes: number;
	validationFiles: number;
	validationMode?: "watcher" | "exact";
	projectionCoverage?: readonly ActionProjectionCoverage[];
	projectionMs: number;
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
	readonly source: string;
	empiricalProbability?: number;
	conditionalProbability?: number;
	depth?: number;
	readonly planDependencies?: PlanAction["dependsOn"];
	scheduling: SpeculativeSchedulingMetadata;
	utility: number;
	readonly leases: readonly PredictionLease[];
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
	/** @deprecated Mirrors resultEntries for event compatibility. */
	readonly cacheEntries: number;
	readonly cacheCapacity: number;
	readonly cacheBytes?: number;
	readonly cacheByteCapacity?: number;
	/** @deprecated Running jobs are reported by inFlightJobs and never live in ResultCache. */
	readonly cacheRunning: number;
	/** @deprecated Mirrors resultEntries for event compatibility. */
	readonly cacheCompleted: number;
	readonly cacheProbation: number;
	readonly cacheProtected: number;
	readonly inFlightJobs: number;
	readonly resultEntries: number;
	readonly resultBytes: number;
	readonly branchEntries: number;
	readonly branchBytes: number;
	readonly activeCandidates: number;
	readonly turnCandidates: number;
	readonly resourceCandidates: number;
	readonly cacheTools: readonly string[];
	readonly cacheExecutions: readonly SpeculativeExecution[];
	readonly observedWallMs?: number;
}

export interface SpeculativeLookupRejection {
	readonly reason: string;
	readonly count: number;
}

export interface SpeculativeLookupDiagnostics {
	readonly candidateCount: number;
	readonly compatibleCount: number;
	readonly rejections: readonly SpeculativeLookupRejection[];
}

interface SpeculativeSchedulingEventFields {
	readonly source: string;
	readonly futureHorizon?: number;
	readonly empiricalProbability?: number;
	readonly conditionalProbability?: number;
	readonly patternDepth?: number;
	readonly dependencyEdges?: number;
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
					readonly sources: readonly (PredictionLease["source"] | "cache")[];
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
					lookup?: SpeculativeLookupDiagnostics;
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
				lookup?: SpeculativeLookupDiagnostics;
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
	readonly id?: string;
	readonly tool: string;
	readonly input: unknown;
}

type MaybePromise<T> = T | Promise<T>;

export type PlanActionResolution = "consumed" | "actor_miss" | "stale" | "system";

export interface SpeculativePlanSource<
	SessionID,
	Output,
	StartInput extends TurnInput<SessionID>,
	ConsumeInput extends TurnInput<SessionID>,
	StateData,
> {
	readonly id: string;
	readonly enabled: (settings: SpeculativeActionSettings) => boolean;
	/** Enables the generic per-source failure backoff used for expensive predictors. */
	readonly adaptive?: boolean;
	readonly timeoutMs?: (settings: SpeculativeActionSettings) => number | undefined;
	readonly multiStepEnabled?: (settings: SpeculativeActionSettings) => boolean;
	readonly propose: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly definitions: readonly DrafterToolDefinition[];
		readonly candidateNames: readonly string[];
		readonly signal: AbortSignal;
	}) => MaybePromise<PlanProposal | readonly PlanProposal[]>;
	readonly continue?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeCandidate;
		readonly proposalID: string;
		readonly actionID: string;
		readonly feedback: unknown;
		readonly output: Output;
		readonly parentConfirmed: boolean;
	}) => MaybePromise<PlanUpdate | readonly PlanUpdate[] | undefined>;
	readonly observe?: (input: {
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
		readonly order: number;
	}) => MaybePromise<PlanUpdate | readonly PlanUpdate[] | undefined>;
	readonly onLaunched?: (input: {
		readonly proposalID: string;
		readonly actionID: string;
		readonly feedback: unknown;
	}) => MaybePromise<void>;
	readonly onResolved?: (input: {
		readonly proposalID: string;
		readonly actionID: string;
		readonly feedback: unknown;
		readonly outcome: PlanActionResolution;
	}) => MaybePromise<void>;
	readonly flush?: () => MaybePromise<void>;
}

export interface SpeculativeActionRuntimeAdapter<
	SessionID,
	Output,
	StartInput extends TurnInput<SessionID>,
	ConsumeInput extends TurnInput<SessionID>,
	StateData,
> {
	readonly actionSemantics?: ActionSemanticsRegistry;
	readonly sources?: readonly SpeculativePlanSource<SessionID, Output, StartInput, ConsumeInput, StateData>[];
	readonly settings: () => MaybePromise<SpeculativeActionSettings>;
	readonly definitions: (input: StartInput) => readonly DrafterToolDefinition[];
	readonly stateData: (input: StartInput) => MaybePromise<StateData>;
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
	/** Lossless projections jointly define K(a) relation, realized coverage, and output reconstruction. */
	readonly projectionRules?: readonly ActionProjectionRule<Output>[];
	/** Return a reason to discard an output that must never become a reusable speculative result. */
	readonly rejectCandidateOutput?: (input: {
		readonly output: Output;
		readonly candidate: SpeculativeCandidate;
	}) => string | undefined;
	readonly adoptCandidate?: (input: {
		readonly stateData: StateData;
		readonly consumeInput: ConsumeInput;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
		readonly output: Output;
	}) => MaybePromise<Output | undefined>;
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
	readonly deferredPlanActions: number;
	readonly activePlanActions: number;
	readonly blockedPlanActions: number;
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

interface RuntimeCandidate<Output> extends SpeculativeCandidate {
	readonly run: SpeculativeJobRun<Output>;
	readonly lifecycle: CandidateAggregate<Output, PredictionLease>;
}

interface RankedRuntimeCandidate<Output> {
	readonly candidate: RuntimeCandidate<Output>;
	readonly match: ActionKeyMatch;
	readonly expectedNetSavedMs: number;
}

type CandidateProjectionResult<Output> =
	| { readonly ok: true; readonly output: Output; readonly durationMs: number }
	| {
			readonly ok: false;
			readonly reason: "projection_rule_missing" | "coverage_unavailable" | "view_not_covered" | "projection_failed";
	  };

interface TurnState<SessionID, Output, StateData> {
	readonly sessionID: SessionID;
	readonly turnID: string;
	readonly startInput: TurnInput<SessionID>;
	readonly startedAt: number;
	readonly data: StateData;
	readonly settings: SpeculativeActionSettings;
	readonly predictionController: AbortController;
	readonly actorActionSequences: Map<string, number>;
	readonly actorCallSequences: Map<string, number>;
	readonly preparedHints: Set<string>;
	readonly pendingActionSequences: Set<number>;
	readonly turnAdmissions: Map<string, RuntimeCandidate<Output>>;
	readonly plans: PlanLedger;
	readonly planGraph: PlanExecutionGraph;
	readonly sourceAttempts: Set<string>;
	readonly sourceFeedback: Map<string, "success" | "actor_miss" | "source_error">;
	readonly sourcePlanMismatches: Set<string>;
	readonly pendingSchedulerCompletions: Set<RuntimeCandidate<Output>>;
	actionSequence: number;
	planDispatchDepth: number;
	pendingPlanMismatch?: {
		readonly sources: readonly string[];
		readonly key: ActionKey;
		readonly actualAction: string;
		readonly predictedAction?: string;
		readonly lookup: SpeculativeLookupDiagnostics;
	};
	terminal: boolean;
	finished: boolean;
	noCandidateReported: boolean;
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
	const actionSemantics = adapter.actionSemantics ?? PI_ACTION_SEMANTICS;
	const turns = new Map<string, TurnState<SessionID, Output, StateData>>();
	const planLedgers = new Map<SessionID, PlanLedger>();
	const planGraphs = new Map<SessionID, PlanExecutionGraph>();
	const planLaunchContexts = new Map<
		SessionID,
		Map<
			string,
			{
				readonly predictionLatencyMs: number;
				readonly draftTokens: number;
				readonly totalDraftTokens: number;
			}
		>
	>();
	const planLedgerFor = (sessionID: SessionID): PlanLedger => {
		const existing = planLedgers.get(sessionID);
		if (existing) return existing;
		const created = new PlanLedger();
		planLedgers.set(sessionID, created);
		return created;
	};
	const planGraphFor = (sessionID: SessionID): PlanExecutionGraph => {
		const existing = planGraphs.get(sessionID);
		if (existing) return existing;
		const created = new PlanExecutionGraph((action) => actionSemantics.execution(action.tool));
		planGraphs.set(sessionID, created);
		return created;
	};
	const planActionIdentity = (proposalID: string, actionID: string): string => `${proposalID}\u0000${actionID}`;
	type RuntimePlanSource = SpeculativePlanSource<SessionID, Output, StartInput, ConsumeInput, StateData>;
	const sources: readonly RuntimePlanSource[] = adapter.sources ?? [];
	const sourcesByID = new Map<string, SpeculativePlanSource<SessionID, Output, StartInput, ConsumeInput, StateData>>();
	for (const source of sources) {
		const id = source.id.trim();
		if (!id) throw new Error("speculative plan source id must not be empty");
		if (id !== source.id) throw new Error(`speculative plan source id must be canonical: ${source.id}`);
		if (sourcesByID.has(id)) throw new Error(`duplicate speculative plan source ${id}`);
		sourcesByID.set(id, source);
	}
	const projectionRuleByID = new Map<string, ActionProjectionRule<Output>>();
	for (const rule of adapter.projectionRules ?? []) {
		if (!actionSemantics.supportsProjector(rule.id)) continue;
		if (!projectionRuleByID.has(rule.id)) projectionRuleByID.set(rule.id, rule);
	}
	const projectionRules = [...projectionRuleByID.values()];
	const keyProjectors = projectionRules;
	const jobs = new JobTable<SessionID, RuntimeCandidate<Output>>(keyProjectors);
	const results = new ResultCache<SessionID, RuntimeCandidate<Output>>(keyProjectors);
	// Exclusive branches are deliberately exact-only; projections are for shareable results.
	const branches = new BranchStore<SessionID, RuntimeCandidate<Output>>();
	const tokenTotals = new Map<SessionID, number>();
	const wallTimes = new Map<SessionID, number>();
	const actionSequences = new Map<SessionID, number>();
	const schedulers = new Map<SessionID, ToolSpeculationScheduler<RuntimeCandidate<Output>>>();
	const candidateCatalog = new CandidateCatalog<
		SessionID,
		RuntimeCandidate<Output>,
		TurnState<SessionID, Output, StateData>
	>();
	const serviceTimes = new Map<string, { count: number; averageMs: number }>();
	const executionOverheadTimes = new Map<string, { count: number; averageMs: number }>();
	const hitOverheadTimes = new Map<string, { count: number; averageMs: number }>();
	const projectionOverheadTimes = new Map<string, { count: number; averageMs: number }>();
	const actorLeadTimes = new Map<string, { count: number; averageMs: number }>();
	const sourceBackoff = new Map<
		SessionID,
		Map<string, { actorMisses: number; sourceErrors: number; skips: number }>
	>();
	let notifiedMasterEnabled: boolean | undefined;

	const turnKey = (input: TurnInput<SessionID>): string => `${String(input.sessionID)}:${input.turnID}`;
	const resourceCacheLimit = (settings: SpeculativeActionSettings): number =>
		Number.isFinite(settings.resourceCacheMaxEntries) ? Math.max(1, Math.floor(settings.resourceCacheMaxEntries)) : 1;
	const resourceCacheByteLimit = (settings: SpeculativeActionSettings): number =>
		typeof settings.resourceCacheMaxBytes === "number" && Number.isFinite(settings.resourceCacheMaxBytes)
			? Math.max(1, Math.floor(settings.resourceCacheMaxBytes))
			: 256 * 1024 * 1024;
	const cacheLimits = (settings: SpeculativeActionSettings) => ({
		maxEntries: resourceCacheLimit(settings),
		maxBytes: resourceCacheByteLimit(settings),
		protectedFraction: 0.8,
	});
	const schedulerFor = (sessionID: SessionID): ToolSpeculationScheduler<RuntimeCandidate<Output>> => {
		const existing = schedulers.get(sessionID);
		if (existing) return existing;
		const created = new ToolSpeculationScheduler<RuntimeCandidate<Output>>();
		schedulers.set(sessionID, created);
		return created;
	};
	const completeScheduledCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): void => {
		if (state.planDispatchDepth > 0) state.pendingSchedulerCompletions.add(candidate);
		else schedulerFor(state.sessionID).complete(candidate);
	};

	const observeAverage = (
		target: Map<string, { count: number; averageMs: number }>,
		tool: string,
		durationMs: number,
	): void => {
		const duration = finiteMetric(durationMs);
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
	const observeProjectionOverhead = (tool: string, rule: string, durationMs: number): void =>
		observeAverage(projectionOverheadTimes, `${tool}:${rule}`, durationMs);
	const schedulingKey = (tool: string, horizon?: number): string =>
		`${tool}:${horizon === undefined ? "*" : finiteNonNegativeInteger(horizon)}`;
	const observedLeadTime = (tool: string, horizon?: number): number | undefined =>
		actorLeadTimes.get(schedulingKey(tool, horizon))?.averageMs ?? actorLeadTimes.get(schedulingKey(tool))?.averageMs;
	const observeLeadTime = (tool: string, durationMs: number, horizon?: number): void => {
		observeAverage(actorLeadTimes, schedulingKey(tool), durationMs);
		if (horizon !== undefined) observeAverage(actorLeadTimes, schedulingKey(tool, horizon), durationMs);
	};
	const masterEnabled = (settings: SpeculativeActionSettings): boolean =>
		settings.enabled && settings.mode === "predict_action_single_step";
	const sourceEnabled = (settings: SpeculativeActionSettings, sourceID: string): boolean => {
		if (!masterEnabled(settings)) return false;
		return sourcesByID.get(sourceID)?.enabled(settings) ?? false;
	};
	const sourceMultiStepEnabled = (settings: SpeculativeActionSettings, sourceID: string): boolean => {
		const source = sourcesByID.get(sourceID);
		return source?.multiStepEnabled?.(settings) ?? source?.continue !== undefined;
	};
	const latestSettings = async (): Promise<SpeculativeActionSettings | undefined> => {
		try {
			return await adapter.settings();
		} catch {
			return undefined;
		}
	};
	const flushPredictionSources = async (): Promise<void> => {
		for (const source of sources) {
			try {
				await source.flush?.();
			} catch {
				// Persistence is best-effort and isolated per producer.
			}
		}
	};
	// Keep the historical setting name at the public boundary while applying the
	// policy uniformly to every source that opts into adaptive backoff.
	const adaptiveSourceBackoffEnabled = (state: TurnState<SessionID, Output, StateData>): boolean =>
		state.settings.adaptiveDrafter ?? DEFAULTS.adaptiveDrafter;
	const candidateLimit = (settings: SpeculativeActionSettings): number =>
		clampCandidateLimit(settings.candidateLimit ?? settings.maxCandidates ?? DEFAULTS.candidateLimit);
	const concurrentActionLimit = (settings: SpeculativeActionSettings): number =>
		clampCandidateLimit(settings.maxConcurrentActions ?? settings.maxCandidates ?? DEFAULTS.maxConcurrentActions);
	const takeSourceOpportunity = (sessionID: SessionID, source: string): boolean => {
		const feedback = sourceBackoff.get(sessionID)?.get(source);
		if (!feedback?.skips) return true;
		feedback.skips--;
		return false;
	};
	const recordSourceFailure = (
		state: TurnState<SessionID, Output, StateData>,
		source: string,
		kind: "actor_miss" | "source_error",
	): void => {
		if (state.sourceFeedback.has(source)) return;
		state.sourceFeedback.set(source, kind);
		const bySource = sourceBackoff.get(state.sessionID) ?? new Map();
		const feedback = bySource.get(source) ?? { actorMisses: 0, sourceErrors: 0, skips: 0 };
		feedback[kind === "actor_miss" ? "actorMisses" : "sourceErrors"]++;
		const failures = feedback.actorMisses + feedback.sourceErrors;
		if (failures >= 2) {
			feedback.skips = Math.max(
				feedback.skips,
				Math.min(candidateLimit(state.settings), 2 ** Math.max(0, failures - 2)),
			);
		}
		bySource.set(source, feedback);
		sourceBackoff.set(state.sessionID, bySource);
	};
	const notifyLeaseLaunched = async (lease: PredictionLease): Promise<void> => {
		const source = sourcesByID.get(lease.source);
		if (source?.onLaunched && lease.proposalID && lease.actionID) {
			try {
				await source.onLaunched({
					proposalID: lease.proposalID,
					actionID: lease.actionID,
					feedback: lease.feedback,
				});
			} catch {
				// Producer feedback must not alter tool semantics.
			}
		}
	};
	const notifyLeaseResolved = async (lease: PredictionLease, outcome: PlanActionResolution): Promise<void> => {
		const source = sourcesByID.get(lease.source);
		if (source?.onResolved && lease.proposalID && lease.actionID) {
			try {
				await source.onResolved({
					proposalID: lease.proposalID,
					actionID: lease.actionID,
					feedback: lease.feedback,
					outcome,
				});
			} catch {
				// Producer feedback must not alter tool semantics.
			}
		}
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
			await notifyLeaseResolved(lease, "consumed");
		}
		for (const sourceID of new Set(matched.map((lease) => lease.source))) {
			if (!sourcesByID.get(sourceID)?.adaptive) continue;
			state.sourceFeedback.set(sourceID, "success");
			sourceBackoff.get(state.sessionID)?.delete(sourceID);
		}
	};
	const activeAdaptivePlanSources = (
		candidates: Iterable<RuntimeCandidate<Output>>,
		actionSequence: number,
		planGraph?: PlanExecutionGraph,
	): Set<string> => {
		const active = new Set<string>();
		for (const candidate of candidates) {
			for (const lease of candidate.leases) {
				if (
					lease.state === "active" &&
					(lease.validThroughActionSeq === undefined || actionSequence <= lease.validThroughActionSeq) &&
					sourcesByID.get(lease.source)?.adaptive
				) {
					active.add(lease.source);
				}
			}
		}
		for (const node of planGraph?.deferred() ?? []) {
			if (node.expectedActionSeq >= actionSequence && sourcesByID.get(node.source)?.adaptive)
				active.add(node.source);
		}
		return active;
	};
	const markPlanMismatches = (
		state: TurnState<SessionID, Output, StateData>,
		sourcesToMark: Iterable<string>,
	): void => {
		for (const sourceID of sourcesToMark) {
			if (state.sourceFeedback.get(sourceID) !== "success") state.sourcePlanMismatches.add(sourceID);
		}
	};

	const schedulingMetadata = (
		draft: SpeculativeDraftCandidate,
		action: ActionKey,
		expectedLeadFloorMs = 0,
	): SpeculativeSchedulingMetadata => {
		const empiricalProbability = finiteProbability(draft.empiricalProbability);
		const measured = serviceTimes.get(action.tool)?.averageMs;
		const expectedDurationMs = finitePositive(draft.expectedDurationMs, measured ?? 1);
		const observedExpectedLeadMs = observedLeadTime(action.tool, draft.horizon);
		const normalizedLeadFloorMs = finiteNonNegative(expectedLeadFloorMs, 0);
		const expectedLeadMs =
			observedExpectedLeadMs === undefined && normalizedLeadFloorMs === 0
				? undefined
				: Math.min(expectedDurationMs, Math.max(observedExpectedLeadMs ?? 0, normalizedLeadFloorMs));
		const expectedHiddenMs = Math.min(expectedDurationMs, expectedLeadMs ?? expectedDurationMs);
		const defaultBenefitMs =
			empiricalProbability === undefined ? expectedHiddenMs : empiricalProbability * expectedHiddenMs;
		const expectedBenefitMs = Math.min(
			expectedHiddenMs,
			finiteNonNegative(draft.expectedLatencyBenefitMs, defaultBenefitMs),
		);
		const base = resourceProfile(action.execution, actionSemantics.sandboxMode(action.tool));
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
				units: finitePositiveInteger(draft.resourceDemand, base.units),
			},
		};
	};

	const draftPriority = (draft: SpeculativeDraftCandidate): number => {
		const probability =
			typeof draft.empiricalProbability === "number" && Number.isFinite(draft.empiricalProbability)
				? Math.max(0, Math.min(1, draft.empiricalProbability))
				: 1;
		const duration =
			typeof draft.expectedDurationMs === "number" && Number.isFinite(draft.expectedDurationMs)
				? Math.max(1, draft.expectedDurationMs)
				: (serviceTimes.get(draft.tool)?.averageMs ?? 1);
		const hidden = Math.min(duration, observedLeadTime(draft.tool, draft.horizon) ?? duration);
		return Math.min(hidden, finiteNonNegative(draft.expectedLatencyBenefitMs, probability * hidden));
	};

	const removeTurnAdmission = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): void => {
		for (const [key, admitted] of state.turnAdmissions) {
			if (admitted === candidate) state.turnAdmissions.delete(key);
		}
	};

	const turnAdmission = (
		state: TurnState<SessionID, Output, StateData>,
		key: string,
		utility: number,
	): { readonly admitted: true; readonly victim?: RuntimeCandidate<Output> } | { readonly admitted: false } => {
		for (const [candidateKey, candidate] of state.turnAdmissions) {
			if (candidate.run.status === "closed") state.turnAdmissions.delete(candidateKey);
		}
		if (state.turnAdmissions.has(key)) return { admitted: true };
		if (state.turnAdmissions.size < candidateLimit(state.settings)) return { admitted: true };
		const victim = [...state.turnAdmissions.values()].sort(
			(left, right) => left.utility - right.utility || left.startedAt - right.startedAt,
		)[0];
		if (!victim || victim.utility >= utility) return { admitted: false };
		return { admitted: true, victim };
	};

	const emit = async (event: SpeculativeActionEvent<SessionID>): Promise<void> => {
		try {
			await adapter.onEvent?.(event);
		} catch {
			// Observability must never change tool execution semantics.
		}
	};

	const sessionCandidates = (sessionID: SessionID): readonly RuntimeCandidate<Output>[] => {
		return [...jobs.values(sessionID), ...results.values(sessionID), ...branches.values(sessionID)];
	};

	const cacheSnapshot = (state: TurnState<SessionID, Output, StateData>): SpeculativeCacheSnapshot => {
		const inFlight = jobs.values(state.sessionID);
		const cached = results.values(state.sessionID);
		const staged = branches.values(state.sessionID);
		const candidates = [...inFlight, ...cached, ...staged];
		const lifecycle = results.snapshot(state.sessionID);
		const branchSnapshot = branches.snapshot(state.sessionID);
		const resultBytes = cached.reduce((total, candidate) => total + candidate.estimatedBytes, 0);
		return {
			cacheEntries: cached.length,
			cacheCapacity: state.settings.resourceCacheMaxEntries,
			cacheBytes: resultBytes,
			cacheByteCapacity: resourceCacheByteLimit(state.settings),
			cacheRunning: 0,
			cacheCompleted: cached.length,
			cacheProbation: lifecycle.probationEntries,
			cacheProtected: lifecycle.protectedEntries,
			inFlightJobs: inFlight.length,
			resultEntries: cached.length,
			resultBytes,
			branchEntries: branchSnapshot.entries,
			branchBytes: branchSnapshot.bytes,
			activeCandidates: inFlight.length,
			turnCandidates: staged.length + inFlight.filter((candidate) => candidate.reuse.kind === "exclusive").length,
			resourceCandidates: cached.length + inFlight.filter((candidate) => candidate.reuse.kind === "shared").length,
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
		...(candidateFutureHorizon(candidate) !== undefined ? { futureHorizon: candidateFutureHorizon(candidate) } : {}),
		...(candidate.empiricalProbability !== undefined ? { empiricalProbability: candidate.empiricalProbability } : {}),
		...(candidate.conditionalProbability !== undefined
			? { conditionalProbability: candidate.conditionalProbability }
			: {}),
		...(candidate.depth !== undefined ? { patternDepth: candidate.depth } : {}),
		...(candidate.planDependencies?.length ? { dependencyEdges: candidate.planDependencies.length } : {}),
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
		diagnostics: {
			readonly draftCandidate?: string;
			readonly predictedAction?: string;
			readonly actualAction?: string;
			readonly lookup?: SpeculativeLookupDiagnostics;
		} = {},
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
		return new Map(sessionCandidates(state.sessionID).map((candidate) => [candidate.key.key, candidate]));
	};

	const expectedNetSavedMs = (
		candidate: RuntimeCandidate<Output>,
		match: ActionKeyMatch,
		now = Date.now(),
	): number => {
		const expectedExecutionMs =
			candidate.run.status === "ready" ? candidate.run.executionMs : candidate.scheduling.expectedDurationMs;
		const elapsed =
			candidate.run.status === "running"
				? Math.max(0, now - (candidate.executionStartedAt ?? candidate.startedAt))
				: expectedExecutionMs;
		const remaining = candidate.run.status === "running" ? Math.max(0, expectedExecutionMs - elapsed) : 0;
		const projectionOverhead =
			match.kind === "projected"
				? (projectionOverheadTimes.get(`${candidate.tool}:${match.projector}`)?.averageMs ?? 0)
				: 0;
		return (
			expectedExecutionMs - remaining - (hitOverheadTimes.get(candidate.tool)?.averageMs ?? 0) - projectionOverhead
		);
	};

	const matchingCandidates = (
		state: TurnState<SessionID, Output, StateData>,
		action: ActionKey,
		arrivedCandidates: readonly RuntimeCandidate<Output>[] = [],
	): RankedRuntimeCandidate<Output>[] => {
		const ranked: RankedRuntimeCandidate<Output>[] = [];
		const now = Date.now();
		const matches = new Map<RuntimeCandidate<Output>, ActionKeyMatch>();
		for (const lookup of [
			...jobs.lookup(state.sessionID, action),
			...results.lookup(state.sessionID, action),
			...branches.lookup(state.sessionID, action),
		]) {
			const current = matches.get(lookup.entry);
			if (!current || lookup.match.distance < current.distance) matches.set(lookup.entry, lookup.match);
		}
		for (const candidate of arrivedCandidates) {
			if (matches.has(candidate)) continue;
			const match = actionKeyMatch(candidate.key, action, keyProjectors);
			if (match) matches.set(candidate, match);
		}
		for (const [candidate, match] of matches) {
			ranked.push({ candidate, match, expectedNetSavedMs: expectedNetSavedMs(candidate, match, now) });
		}
		return ranked.sort((left, right) => {
			const latencyDifference = right.expectedNetSavedMs - left.expectedNetSavedMs;
			// Millisecond-scale scheduler and projection measurements are noisy. Keep
			// semantic specificity as the tie-breaker unless the estimated saving is
			// large enough to be meaningful.
			if (Math.abs(latencyDifference) > 5) return latencyDifference;
			return (
				left.match.distance - right.match.distance ||
				Number(right.candidate.run.status === "ready") - Number(left.candidate.run.status === "ready") ||
				right.candidate.startedAt - left.candidate.startedAt
			);
		});
	};

	const captureProjectionCoverage = (action: ActionKey, output: Output): readonly ActionProjectionCoverage[] => {
		const coverage: ActionProjectionCoverage[] = [];
		for (const rule of projectionRules) {
			let value: unknown;
			try {
				value = rule.captureCoverage(action, output);
			} catch {
				continue;
			}
			if (value !== undefined) coverage.push({ rule: rule.id, value });
		}
		return coverage;
	};

	const projectCandidateOutput = async (
		candidate: RuntimeCandidate<Output>,
		action: ActionKey,
		output: Output,
		match: ActionKeyMatch,
	): Promise<CandidateProjectionResult<Output>> => {
		if (match.kind === "exact") return { ok: true, output, durationMs: 0 };
		const rule = projectionRuleByID.get(match.projector);
		const coverage = candidate.projectionCoverage?.find((item) => item.rule === match.projector)?.value;
		if (!rule) return { ok: false, reason: "projection_rule_missing" };
		if (coverage === undefined) return { ok: false, reason: "coverage_unavailable" };
		const started = performance.now();
		try {
			const projected = await rule.projectOutput({
				speculative: candidate.key,
				actor: action,
				output,
				coverage,
				keyMatch: match,
			});
			const durationMs = Math.max(0, performance.now() - started);
			if (projected === undefined) return { ok: false, reason: "view_not_covered" };
			return { ok: true, output: projected, durationMs };
		} catch {
			return { ok: false, reason: "projection_failed" };
		}
	};

	const removeCandidateFromStores = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): boolean => {
		const removedJob = jobs.delete(state.sessionID, candidate);
		const removedResult = results.delete(state.sessionID, candidate);
		const removedBranch = branches.delete(state.sessionID, candidate);
		return removedJob || removedResult || removedBranch;
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

	const trimCompletedCandidates = (
		sessionID: SessionID,
		settings: SpeculativeActionSettings,
		protectedCandidate?: RuntimeCandidate<Output>,
	): RuntimeCandidate<Output>[] => {
		return [
			...results.trim(sessionID, cacheLimits(settings), (candidate) => candidate !== protectedCandidate),
			...branches.trim(
				sessionID,
				{ maxEntries: candidateLimit(settings), maxBytes: resourceCacheByteLimit(settings) },
				(candidate) => candidate !== protectedCandidate,
			),
		];
	};

	const storeCompletedCandidate = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): {
		readonly existing?: RuntimeCandidate<Output>;
		readonly evicted: ReadonlyArray<{ readonly candidate: RuntimeCandidate<Output>; readonly reason: string }>;
	} => {
		jobs.delete(state.sessionID, candidate);
		const shared = candidate.reuse.kind === "shared";
		const existing = shared
			? results.insert(state.sessionID, candidate)
			: branches.insert(state.sessionID, candidate);
		if (existing && existing !== candidate) return { existing, evicted: [] };
		if (shared) {
			const limits = cacheLimits(state.settings);
			const snapshot = results.snapshot(state.sessionID);
			const overEntryLimit = results.values(state.sessionID).length > limits.maxEntries;
			const overByteLimit = snapshot.probationBytes + snapshot.protectedBytes > limits.maxBytes;
			const reason = overEntryLimit && !overByteLimit ? "resource_cache_evicted" : "resource_cache_byte_limit";
			return {
				evicted: results
					.trim(state.sessionID, limits, (entry) => entry !== candidate)
					.map((entry) => ({ candidate: entry, reason })),
			};
		}
		const limits = {
			maxEntries: candidateLimit(state.settings),
			maxBytes: resourceCacheByteLimit(state.settings),
		};
		const snapshot = branches.snapshot(state.sessionID);
		const reason = snapshot.entries > limits.maxEntries ? "branch_store_evicted" : "branch_store_byte_limit";
		return {
			evicted: branches
				.trim(state.sessionID, limits, (entry) => entry !== candidate)
				.map((entry) => ({ candidate: entry, reason })),
		};
	};

	const planResolution = (reason: string): Exclude<PlanActionResolution, "consumed"> => {
		if (
			reason === "prediction_horizon_expired" ||
			reason === "request_finished_without_hit" ||
			reason === "turn_finished_without_hit"
		) {
			return "actor_miss";
		}
		if (
			reason === "resource_expired" ||
			reason === "authoritative_resource_changed" ||
			reason === "candidate_resource_expired" ||
			reason === "resource_changed" ||
			reason.startsWith("resource_changed:")
		) {
			return "stale";
		}
		return "system";
	};

	const settlePredictionLeases = async (
		candidate: RuntimeCandidate<Output>,
		state: "expired" | "invalidated",
		outcome: Exclude<PlanActionResolution, "consumed">,
		matches: (lease: PredictionLease) => boolean = () => true,
	): Promise<void> => {
		for (const lease of candidate.leases) {
			if (lease.state !== "active" || !matches(lease)) continue;
			lease.state = state;
			await notifyLeaseResolved(lease, outcome);
		}
	};

	const completePredictionMatch = (candidate: RuntimeCandidate<Output>, actionSequence: number): void => {
		for (const lease of candidate.leases) {
			if (lease.state === "matched" && lease.resolvedActionSeq === actionSequence) lease.state = "hit";
		}
	};

	const expireTurnBoundSourceLeases = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		preserveSuccessfulBatch = false,
	): Promise<void> => {
		const shouldExpire = (lease: PredictionLease): boolean =>
			lease.providerTurnID === state.turnID &&
			lease.validThroughActionSeq === undefined &&
			sourcesByID.has(lease.source) &&
			(!preserveSuccessfulBatch || state.sourceFeedback.get(lease.source) !== "success");
		for (const lease of candidate.leases) {
			if (lease.state === "active" && shouldExpire(lease) && lease.proposalID && lease.actionID) {
				state.planGraph.markFailed(lease.proposalID, lease.actionID);
			}
		}
		await settlePredictionLeases(candidate, "expired", "actor_miss", shouldExpire);
	};

	const pruneResolvedLeases = (candidate: RuntimeCandidate<Output>): void => {
		candidate.lifecycle.pruneLeases((lease) => lease.state === "active" || lease.state === "matched");
	};

	const closeCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason: string,
		leaseState: "expired" | "invalidated" = "invalidated",
		publish = false,
		schedulerOutcome: "preempted" | "discarded" = "discarded",
	): Promise<boolean> => {
		const wasRunning = candidate.run.status === "running";
		const completedAt = candidateCompletedAt(candidate);
		const executionMs = candidateExecutionMs(candidate);
		if (
			!candidate.lifecycle.close({
				reason,
				...(completedAt !== undefined ? { completedAt } : {}),
				...(executionMs > 0 ? { executionMs } : {}),
			})
		) {
			return false;
		}
		if (wasRunning) markCandidatePlanFailed(state, candidate);
		candidate.schedulerOutcome = schedulerOutcome;
		await settlePredictionLeases(candidate, leaseState, planResolution(reason));
		for (const lease of candidate.leases) {
			if (lease.state === "matched") lease.state = "invalidated";
		}
		schedulerFor(state.sessionID).discard(candidate);
		removeTurnAdmission(state, candidate);
		removeCandidateFromStores(state, candidate);
		releaseCandidateResourceVersion(candidate);
		candidateCatalog.retire(candidate);
		candidate.lifecycle.settleClosed();
		if (publish) await publishCancelled(state, candidate, reason);
		return true;
	};

	const preemptCandidate = async (
		candidate: RuntimeCandidate<Output>,
		reason = "scheduler_preempted",
		outcome: "preempted" | "discarded" = "preempted",
		publish = true,
	): Promise<void> => {
		const owner = candidateCatalog.owner(candidate);
		if (!owner) {
			candidate.schedulerOutcome = outcome;
			candidate.lifecycle.close({ reason });
			releaseCandidateResourceVersion(candidate);
			candidateCatalog.retire(candidate);
			candidate.lifecycle.settleClosed();
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
		const candidates = new Set<RuntimeCandidate<Output>>(candidateCatalog.sessionValues(sessionID));
		for (const [key, state] of turns) {
			if (state.sessionID !== sessionID) continue;
			state.finished = true;
			state.terminal = true;
			state.predictionController.abort();
			turns.delete(key);
			await settleUnlaunchedPlanActions(state, "system");
		}
		for (const candidate of candidates) await preemptCandidate(candidate, reason, "discarded", publish);
		planLedgers.delete(sessionID);
		planGraphs.delete(sessionID);
		planLaunchContexts.delete(sessionID);
		sourceBackoff.delete(sessionID);
		if (!schedulerFor(sessionID).snapshot().length) schedulers.delete(sessionID);
	};

	const settingsChanged = async (settings: SpeculativeActionSettings): Promise<void> => {
		notifiedMasterEnabled = masterEnabled(settings);
		if (notifiedMasterEnabled) return;
		const sessions = new Set<SessionID>(schedulers.keys());
		for (const state of turns.values()) sessions.add(state.sessionID);
		for (const candidate of candidateCatalog.allValues()) {
			const record = candidateCatalog.record(candidate);
			if (record) sessions.add(record.sessionID);
		}
		await Promise.all([...sessions].map((sessionID) => disableSession(sessionID)));
	};

	const releaseSession = async (sessionID: SessionID): Promise<void> => {
		await disableSession(sessionID, "session_deleted", false);
		tokenTotals.delete(sessionID);
		wallTimes.delete(sessionID);
		actionSequences.delete(sessionID);
		schedulers.delete(sessionID);
		sourceBackoff.delete(sessionID);
	};

	const reconcileCandidateStores = async (state: TurnState<SessionID, Output, StateData>): Promise<void> => {
		for (const candidate of sessionCandidates(state.sessionID)) {
			const configured =
				candidate.key.execution === "resource_cached"
					? state.settings.tools.resourceCached.includes(candidate.tool)
					: state.settings.tools.sandbox.includes(candidate.tool);
			if (!configured) await preemptCandidate(candidate, "tool_disabled", "discarded");
		}
		for (const candidate of trimCompletedCandidates(state.sessionID, state.settings)) {
			await preemptCandidate(candidate, "resource_cache_limit_changed", "discarded");
		}
	};

	const cancelCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason: string,
		detail?: string,
	): Promise<void> => {
		await expireTurnBoundSourceLeases(state, candidate);
		if (candidate.reuse.kind === "exclusive" && !hasActivePredictionLease(candidate)) {
			await closeCandidate(state, candidate, reason);
		}
		await publishCancelled(state, candidate, reason, detail);
	};

	const expireCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		reason = "candidate_expired",
	): Promise<void> => {
		markCandidatePlanFailed(state, candidate);
		await closeCandidate(state, candidate, reason);
		await reportBlockedPlanActions(state);
	};

	const expirePredictionLeasesAfterAction = async (state: TurnState<SessionID, Output, StateData>): Promise<void> => {
		const settledThrough =
			state.pendingActionSequences.size > 0 ? Math.min(...state.pendingActionSequences) - 1 : state.actionSequence;
		for (const candidate of availableCandidates(state).values()) {
			if (candidate.run.status === "closed") continue;
			let expired = false;
			for (const lease of candidate.leases) {
				if (
					lease.state !== "active" ||
					lease.validThroughActionSeq === undefined ||
					lease.validThroughActionSeq > settledThrough
				) {
					continue;
				}
				if (lease.proposalID && lease.actionID) {
					state.planGraph.markFailed(lease.proposalID, lease.actionID);
				}
				lease.state = "expired";
				expired = true;
				await notifyLeaseResolved(lease, "actor_miss");
			}
			if (expired && candidate.reuse.kind === "exclusive" && !hasActivePredictionLease(candidate)) {
				await closeCandidate(state, candidate, "prediction_horizon_expired", "expired", true);
			}
		}
		await reportBlockedPlanActions(state);
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
				actionSemantics.resourceVersionPolicy(action.tool) !== "workspace" &&
				!action.resources.some((changed) =>
					candidate.key.resources.some((cached) => resourcePathsOverlap(changed, cached)),
				)
			) {
				continue;
			}
			await expireCandidate(state, candidate, "authoritative_resource_changed");
			await publishCancelled(state, candidate, "authoritative_resource_changed");
		}
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
		return candidate.lifecycle.claim(turnID);
	};

	const releaseCandidateClaim = (candidate: RuntimeCandidate<Output>, turnID: string): void => {
		candidate.lifecycle.releaseClaim(turnID);
	};

	const findReusableCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		action: ActionKey,
	): Promise<RuntimeCandidate<Output> | undefined> => {
		for (const { candidate, match } of matchingCandidates(state, action)) {
			if (candidate.run.status === "closed") continue;
			if (candidate.reuse.kind === "exclusive" && candidate.reuse.state !== "available") continue;
			if (await isExpired(adapter, state, undefined, action, candidate)) {
				await expireCandidate(state, candidate, "candidate_resource_expired");
				continue;
			}
			if (match.kind === "projected") {
				const rule = projectionRuleByID.get(match.projector);
				if (!rule) continue;
				if (candidate.run.status === "running") {
					if (!actionKeyCovers(candidate.key, action, keyProjectors)) continue;
				} else {
					const projection = await projectCandidateOutput(candidate, action, candidate.run.output, match);
					if (!projection.ok) continue;
				}
			}
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
				lease.validThroughActionSeq !== undefined ? [lease.validThroughActionSeq] : [],
			),
		);
	const planLeaseReferences = (candidate: RuntimeCandidate<Output>): readonly PredictionLease[] =>
		candidate.leases.filter(
			(lease) =>
				lease.proposalID !== undefined &&
				lease.actionID !== undefined &&
				(lease.state === "active" || lease.state === "matched" || lease.state === "hit"),
		);
	const markCandidatePlanSucceeded = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): void => {
		for (const lease of planLeaseReferences(candidate)) {
			state.planGraph.markSucceeded(lease.proposalID!, lease.actionID!);
		}
	};
	const markCandidatePlanAdopted = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		actionSequence: number,
	): void => {
		for (const lease of planLeaseReferences(candidate)) {
			if (lease.resolvedActionSeq === actionSequence) {
				state.planGraph.markAdopted(lease.proposalID!, lease.actionID!, actionSequence);
			}
		}
	};
	const markCandidatePlanFailed = (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
	): void => {
		for (const lease of planLeaseReferences(candidate)) {
			state.planGraph.markFailed(lease.proposalID!, lease.actionID!);
		}
	};
	const markDraftPlanAdopted = (
		state: TurnState<SessionID, Output, StateData>,
		draft: SpeculativeDraftCandidate,
	): void => {
		if (draft.proposalID && draft.actionID) {
			state.planGraph.markAdopted(draft.proposalID, draft.actionID, state.actionSequence);
		}
	};
	const actorAlreadySatisfiedDraft = (
		state: TurnState<SessionID, Output, StateData>,
		draft: SpeculativeDraftCandidate,
		action: ActionKey,
		predictionAnchorActionSeq: number,
	): boolean => {
		const observedActionSeq = state.actorActionSequences.get(action.key);
		if (observedActionSeq === undefined) return false;
		const expectedActionSeq =
			draft.proposalID && draft.actionID
				? state.planGraph.get(draft.proposalID, draft.actionID)?.expectedActionSeq
				: undefined;
		return observedActionSeq >= (expectedActionSeq ?? predictionAnchorActionSeq + 1);
	};

	const attachPredictionLease = async (
		state: TurnState<SessionID, Output, StateData>,
		candidate: RuntimeCandidate<Output>,
		draft: SpeculativeDraftCandidate,
		source: PredictionLease["source"],
		anchorActionSeq: number,
	): Promise<boolean> => {
		pruneResolvedLeases(candidate);
		const proposalID = draft.proposalID ?? `${source}:${state.turnID}`;
		const actionID = draft.actionID ?? candidate.key.hash;
		const empiricalProbability = finiteProbability(draft.empiricalProbability);
		const conditionalProbability = finiteProbability(draft.conditionalProbability);
		const depth = finiteOptionalNonNegativeInteger(draft.depth);
		const scheduling = schedulingMetadata(draft, candidate.key);
		const utility = expectedUtility(scheduling);
		const existingLease = candidate.leases.find(
			(lease) =>
				lease.state === "active" &&
				lease.source === source &&
				lease.proposalID === proposalID &&
				lease.actionID === actionID,
		);
		if (existingLease) {
			const leaseProbabilityIncreased =
				empiricalProbability !== undefined &&
				(existingLease.empiricalProbability === undefined ||
					empiricalProbability > existingLease.empiricalProbability);
			const utilityIncreased = utility > candidate.utility;
			if (!leaseProbabilityIncreased && !utilityIncreased) return false;
			if (leaseProbabilityIncreased) {
				existingLease.empiricalProbability = empiricalProbability;
				existingLease.feedback = draft.feedback;
				if (existingLease.continuationExpansion !== "confirmed") {
					existingLease.continuationExpansion = undefined;
				}
				if (candidate.empiricalProbability === undefined || empiricalProbability > candidate.empiricalProbability) {
					candidate.empiricalProbability = empiricalProbability;
					candidate.conditionalProbability = conditionalProbability;
					candidate.depth = depth;
				}
			}
			if (utilityIncreased) {
				candidate.scheduling = scheduling;
				candidate.utility = utility;
				schedulerFor(state.sessionID).update(candidate, scheduling);
			}
			return true;
		}
		const horizon = draft.horizon === undefined ? undefined : finiteNonNegativeInteger(draft.horizon);
		const lease: PredictionLease = {
			id: `${candidate.id}:${source}:${proposalID}:${actionID}:${anchorActionSeq}`,
			source,
			proposalID,
			actionID,
			...(draft.feedback !== undefined ? { feedback: draft.feedback } : {}),
			providerTurnID: state.turnID,
			anchorActionSeq,
			...(horizon !== undefined ? { horizon, validThroughActionSeq: anchorActionSeq + horizon + 1 } : {}),
			...(empiricalProbability !== undefined ? { empiricalProbability } : {}),
			state: "active",
		};
		candidate.lifecycle.addLease(lease);
		if (
			empiricalProbability !== undefined &&
			(candidate.empiricalProbability === undefined || empiricalProbability > candidate.empiricalProbability)
		) {
			candidate.empiricalProbability = empiricalProbability;
			candidate.conditionalProbability = conditionalProbability;
			candidate.depth = depth;
		}
		if (utility > candidate.utility) {
			candidate.scheduling = scheduling;
			candidate.utility = utility;
			schedulerFor(state.sessionID).update(candidate, scheduling);
		}
		await notifyLeaseLaunched(lease);
		return true;
	};

	const admitPredictions = async (
		state: TurnState<SessionID, Output, StateData>,
		input: StartInput,
		drafts: readonly SpeculativeDraftCandidate[],
		predictionLatencyMs: number,
		draftTokens: number,
		totalDraftTokens: number,
		batchSource: string,
		candidateNames: readonly string[],
		predictionAnchorActionSeq = state.actionSequence,
		launchMode: "speculative" | "promoted" = "speculative",
		expectedLeadFloorMs = 0,
	): Promise<number> => {
		let accepted = 0;
		if (state.finished || state.terminal) return accepted;
		const enabled = await latestSettings();
		if (state.finished || state.terminal) return accepted;
		if (!enabled || !sourceEnabled(enabled, batchSource)) {
			if (!enabled || !masterEnabled(enabled)) state.terminal = true;
			return accepted;
		}
		const turnCandidateLimit = candidateLimit(state.settings);
		const ordered = [...drafts].sort(
			(left, right) =>
				draftPriority(right) - draftPriority(left) ||
				finiteNonNegativeInteger(right.horizon) - finiteNonNegativeInteger(left.horizon) ||
				(finiteProbability(right.empiricalProbability) ?? 0) - (finiteProbability(left.empiricalProbability) ?? 0),
		);
		for (const [index, draft] of ordered.entries()) {
			if (state.finished || state.terminal) return accepted;
			const source = draft.source ?? batchSource;
			if (
				!sourceMultiStepEnabled(enabled, source) &&
				(draft.type === "preparation_hint" || (draft.horizon ?? 0) > 0 || (draft.depth ?? 1) > 1)
			) {
				continue;
			}
			if (draft.type === "preparation_hint") {
				if (!candidateNames.includes(draft.tool)) continue;
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
				accepted++;
				continue;
			}
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
			if (actorAlreadySatisfiedDraft(state, draft, action, predictionAnchorActionSeq)) {
				markDraftPlanAdopted(state, draft);
				accepted++;
				continue;
			}
			const callID = `spec_${fastCandidateID(`${input.turnID}:${source}:${index}:${action.key}`)}`;
			const reusable = await findReusableCandidate(state, action);
			if (reusable) {
				const attached = await attachPredictionLease(state, reusable, draft, source, predictionAnchorActionSeq);
				if (!attached) continue;
				accepted++;
				if (reusable.run.status === "ready") {
					markCandidatePlanSucceeded(state, reusable);
					await continuePredictionCandidate(state, input, reusable, reusable.run.output, false);
				}
				continue;
			}
			const execution = draft.execution ?? actionSemantics.execution(draft.tool);
			const reuse = actionSemantics.reuse(draft.tool);
			if (
				!reuse ||
				execution !== action.execution ||
				(reuse === "shared_result") !== (action.execution === "resource_cached")
			) {
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
			if (state.finished || state.terminal) {
				candidateController.abort();
				return accepted;
			}
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
			if (actorAlreadySatisfiedDraft(state, draft, action, predictionAnchorActionSeq)) {
				candidateController.abort();
				markDraftPlanAdopted(state, draft);
				accepted++;
				continue;
			}
			if (state.finished || state.terminal) {
				candidateController.abort();
				return accepted;
			}
			const postflightReusable = await findReusableCandidate(state, action);
			if (postflightReusable) {
				candidateController.abort();
				const attached = await attachPredictionLease(
					state,
					postflightReusable,
					draft,
					source,
					predictionAnchorActionSeq,
				);
				if (!attached) continue;
				accepted++;
				if (postflightReusable.run.status === "ready") {
					markCandidatePlanSucceeded(state, postflightReusable);
					await continuePredictionCandidate(
						state,
						input,
						postflightReusable,
						postflightReusable.run.output,
						false,
					);
				}
				continue;
			}
			const horizon = draft.horizon === undefined ? undefined : finiteNonNegativeInteger(draft.horizon);
			const empiricalProbability = finiteProbability(draft.empiricalProbability);
			const conditionalProbability = finiteProbability(draft.conditionalProbability);
			const depth = finiteOptionalNonNegativeInteger(draft.depth);
			const sourceLease: PredictionLease = {
				id: `${callID}:${source}:${draft.actionID ?? state.turnID}`,
				source,
				proposalID: draft.proposalID ?? `${source}:${state.turnID}`,
				actionID: draft.actionID ?? action.hash,
				...(draft.feedback !== undefined ? { feedback: draft.feedback } : {}),
				providerTurnID: state.turnID,
				anchorActionSeq: predictionAnchorActionSeq,
				...(horizon !== undefined
					? { horizon, validThroughActionSeq: predictionAnchorActionSeq + horizon + 1 }
					: {}),
				...(empiricalProbability !== undefined ? { empiricalProbability } : {}),
				state: "active",
			};
			const scheduling = schedulingMetadata(draft, action, expectedLeadFloorMs);
			const lifecycle = new CandidateAggregate<Output, PredictionLease>(
				reuse === "shared_result" ? "shared" : "exclusive",
				[sourceLease],
				candidateController,
			);
			const candidate: RuntimeCandidate<Output> = {
				id: callID,
				key: action,
				tool: draft.tool,
				input: concrete,
				get reuse() {
					return lifecycle.reuse;
				},
				get run() {
					return lifecycle.run;
				},
				validationMs: 0,
				projectionMs: 0,
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
				...(empiricalProbability !== undefined ? { empiricalProbability } : {}),
				...(conditionalProbability !== undefined ? { conditionalProbability } : {}),
				...(depth !== undefined ? { depth } : {}),
				...(draft.dependsOn?.length ? { planDependencies: draft.dependsOn } : {}),
				scheduling,
				utility: expectedUtility(scheduling),
				get leases() {
					return lifecycle.leases;
				},
				lifecycle,
				hits: 0,
			};
			const turnDecision =
				launchMode === "promoted"
					? ({ admitted: true } as const)
					: turnAdmission(state, action.key, candidate.utility);
			if (!turnDecision.admitted) {
				candidate.schedulerOutcome = "discarded";
				lifecycle.close({ reason: "candidate_budget_insufficient_expected_benefit" });
				lifecycle.settleClosed();
				await publishCancelled(state, candidate, "candidate_budget_insufficient_expected_benefit");
				continue;
			}
			const insertion = jobs.insertOrGetCompatible(state.sessionID, candidate, (existing, match) => {
				const rule = projectionRuleByID.get(match.projector);
				return (
					existing.run.status === "running" &&
					!!rule &&
					actionKeyCovers(existing.key, candidate.key, keyProjectors)
				);
			});
			const existing = insertion.inserted ? undefined : insertion.entry;
			if (existing) {
				lifecycle.close({ reason: "compatible_candidate_already_exists" });
				lifecycle.settleClosed();
				const attached = await attachPredictionLease(state, existing, draft, source, predictionAnchorActionSeq);
				if (attached) {
					accepted++;
					if (existing.run.status === "ready") {
						await continuePredictionCandidate(state, input, existing, existing.run.output, false);
					}
				}
				continue;
			}
			let schedulerVictims: readonly RuntimeCandidate<Output>[] = [];
			if (launchMode === "speculative") {
				const admission = schedulerFor(state.sessionID).admit(
					candidate,
					scheduling,
					speculativeResourceBudget(concurrentActionLimit(state.settings)),
				);
				if (!admission.admitted) {
					jobs.delete(state.sessionID, candidate);
					candidate.schedulerOutcome = "discarded";
					lifecycle.close({ reason: `scheduler_${admission.reason}` });
					lifecycle.settleClosed();
					await publishCancelled(state, candidate, `scheduler_${admission.reason}`);
					continue;
				}
				schedulerVictims = admission.preempted;
			} else {
				candidate.schedulerOutcome = "promoted";
			}
			if (turnDecision.victim) state.turnAdmissions.delete(turnDecision.victim.key.key);
			state.turnAdmissions.set(action.key, candidate);
			candidateCatalog.register(state.sessionID, turnKey(state), candidate, state);
			for (const victim of schedulerVictims) await preemptCandidate(victim);
			if (turnDecision.victim && !schedulerVictims.includes(turnDecision.victim)) {
				await preemptCandidate(turnDecision.victim, "candidate_budget_preempted");
			}
			accepted++;
			await notifyLeaseLaunched(sourceLease);
			await publishStarted(state, candidate);
			let executionStarted = candidate.startedAt;
			const rejectExecution = async (error: unknown): Promise<void> => {
				if (candidate.run.status === "closed") return;
				const classified =
					error instanceof SpeculativeJobError
						? error
						: new SpeculativeJobError("candidate_execution_failed", error);
				const completedAt = Date.now();
				const executionMs = Math.max(0, completedAt - executionStarted);
				candidate.lifecycle.close({
					reason: classified.reason,
					error: classified,
					completedAt,
					executionMs,
				});
				schedulerFor(state.sessionID).discard(candidate);
				candidate.schedulerOutcome = "discarded";
				markCandidatePlanFailed(state, candidate);
				if (adaptiveSourceBackoffEnabled(state)) {
					for (const sourceID of new Set(candidate.leases.map((lease) => lease.source))) {
						if (sourcesByID.get(sourceID)?.adaptive) recordSourceFailure(state, sourceID, "source_error");
					}
				}
				await settlePredictionLeases(candidate, "invalidated", "system");
				for (const lease of candidate.leases) {
					if (lease.state === "matched") lease.state = "invalidated";
				}
				removeTurnAdmission(state, candidate);
				removeCandidateFromStores(state, candidate);
				releaseCandidateResourceVersion(candidate);
				candidateCatalog.retire(candidate);
				await publishCancelled(state, candidate, classified.reason, errorDetail(classified));
				await publishCache(state);
				candidate.lifecycle.settleClosed();
				await reportBlockedPlanActions(state);
				await dispatchReadyPlanActions(state, input);
			};
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
					if (state.finished || state.terminal) {
						throw new SpeculativeJobError(
							"request_finished_without_hit",
							new Error("speculative request finished"),
						);
					}
					if (actionSemantics.requiresRuntimeResourceVersion(action.tool) && adapter.captureResourceVersion) {
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
					if (actionSemantics.watchesResourceVersion(action.tool) && adapter.watchResourceVersion) {
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
				.then(async (output) => {
					if (candidate.run.status === "closed") return;
					const completedAt = Date.now();
					const executionMs = Math.max(0, completedAt - executionStarted);
					let outputRejection: string | undefined;
					try {
						outputRejection = adapter.rejectCandidateOutput?.({ output, candidate });
					} catch (error) {
						await rejectExecution(new SpeculativeJobError("candidate_output_validation_failed", error));
						return;
					}
					if (outputRejection !== undefined) {
						const reason = outputRejection.trim() || "candidate_output_rejected";
						await rejectExecution(new SpeculativeJobError(reason, new Error(reason)));
						return;
					}
					candidate.projectionCoverage = captureProjectionCoverage(action, output);
					if (!candidate.lifecycle.markReady(output, completedAt, executionMs)) return;
					observeServiceTime(candidate.tool, executionMs);
					try {
						const metrics = adapter.candidateExecutionMetrics?.({ output, candidate });
						if (metrics?.sandboxSetupMs !== undefined) {
							candidate.sandboxSetupMs = finiteMetric(metrics.sandboxSetupMs);
						}
						if (metrics?.changeCollectionMs !== undefined) {
							candidate.changeCollectionMs = finiteMetric(metrics.changeCollectionMs);
						}
					} catch {
						// Optional accounting must not invalidate a completed candidate.
					}
					observeExecutionOverhead(
						candidate.key.tool,
						(candidate.resourceCaptureMs ?? 0) +
							(candidate.sandboxSetupMs ?? 0) +
							(candidate.changeCollectionMs ?? 0),
					);
					let outputBytes = estimateValueBytes(output);
					try {
						outputBytes = finiteNonNegative(adapter.candidateSizeBytes?.({ output, candidate }), outputBytes);
					} catch {
						// Fall back to the generic estimate when custom accounting fails.
					}
					candidate.estimatedBytes += outputBytes;
					markCandidatePlanSucceeded(state, candidate);
					const stored = storeCompletedCandidate(state, candidate);
					if (stored.existing) {
						await rejectExecution(
							new SpeculativeJobError(
								"completed_store_conflict",
								new Error("another candidate already owns the completed action"),
							),
						);
						return;
					}
					completeScheduledCandidate(state, candidate);
					for (const evicted of stored.evicted) {
						await preemptCandidate(evicted.candidate, evicted.reason, "discarded");
					}
					await publishCache(state);
					await publishCompleted(state, candidate);
					if (!candidate.lifecycle.settleReady()) return;
					await dispatchReadyPlanActions(state, input);
					if (action.execution !== "sandbox") {
						await continuePredictionCandidate(
							state,
							input,
							candidate,
							output,
							candidate.hits > 0 ||
								candidate.leases.some((lease) => lease.state === "matched" || lease.state === "hit"),
						);
					}
				}, rejectExecution);
		}
		return accepted;
	};

	const planActionDraft = (
		proposal: PlanProposal["id"],
		source: string,
		action: PlanAction,
	): SpeculativeDraftCandidate => ({
		type: action.type,
		tool: action.tool,
		input: action.input,
		...(action.missing ? { missing: action.missing } : {}),
		...(action.execution ? { execution: action.execution } : {}),
		...(action.diagnostic ? { diagnostic: action.diagnostic } : {}),
		source,
		proposalID: proposal,
		actionID: action.id,
		...(action.feedback !== undefined ? { feedback: action.feedback } : {}),
		...(action.horizon !== undefined ? { horizon: action.horizon } : {}),
		...(action.empiricalProbability !== undefined ? { empiricalProbability: action.empiricalProbability } : {}),
		...(action.conditionalProbability !== undefined ? { conditionalProbability: action.conditionalProbability } : {}),
		...(action.expectedDurationMs !== undefined ? { expectedDurationMs: action.expectedDurationMs } : {}),
		...(action.expectedLatencyBenefitMs !== undefined
			? { expectedLatencyBenefitMs: action.expectedLatencyBenefitMs }
			: {}),
		...(action.resourceDemand !== undefined ? { resourceDemand: action.resourceDemand } : {}),
		...(action.depth !== undefined ? { depth: action.depth } : {}),
		...(action.dependsOn?.length ? { dependsOn: action.dependsOn } : {}),
	});

	const removePlanActions = async (
		state: TurnState<SessionID, Output, StateData>,
		source: string,
		proposalID: string,
		actionIDs: readonly string[],
	): Promise<void> => {
		if (!actionIDs.length) return;
		const removed = new Set(actionIDs);
		const removedNodes = state.planGraph.remove(proposalID, actionIDs);
		const contexts = planLaunchContexts.get(state.sessionID);
		for (const actionID of actionIDs) contexts?.delete(planActionIdentity(proposalID, actionID));
		for (const candidate of availableCandidates(state).values()) {
			let changed = false;
			for (const lease of candidate.leases) {
				if (
					lease.state !== "active" ||
					lease.source !== source ||
					lease.proposalID !== proposalID ||
					!lease.actionID ||
					!removed.has(lease.actionID)
				) {
					continue;
				}
				lease.state = "invalidated";
				changed = true;
				await notifyLeaseResolved(lease, "system");
			}
			if (changed && candidate.reuse.kind === "exclusive" && !hasActivePredictionLease(candidate)) {
				await closeCandidate(state, candidate, "plan_action_removed", "invalidated", true);
			}
		}
		for (const node of removedNodes) {
			if (node.state === "deferred") await notifyUnlaunchedPlanResolved(node, "system");
		}
	};

	const notifyUnlaunchedPlanResolved = async (
		node: PlanExecutionNode,
		outcome: Exclude<PlanActionResolution, "consumed">,
	): Promise<void> => {
		const source = sourcesByID.get(node.source);
		if (!source?.onResolved) return;
		try {
			await source.onResolved({
				proposalID: node.proposalID,
				actionID: node.action.id,
				feedback: node.action.feedback,
				outcome,
			});
		} catch {
			// Producer feedback must not alter scheduler semantics.
		}
	};

	const reportBlockedPlanActions = async (state: TurnState<SessionID, Output, StateData>): Promise<void> => {
		for (const blocked of state.planGraph.drainBlocked()) await notifyUnlaunchedPlanResolved(blocked, "system");
	};
	const settleUnlaunchedPlanActions = async (
		state: TurnState<SessionID, Output, StateData>,
		outcome: Exclude<PlanActionResolution, "consumed">,
	): Promise<void> => {
		for (const node of state.planGraph.values()) {
			if (node.state !== "deferred" && node.state !== "launching") continue;
			state.planGraph.markFailed(node.proposalID, node.action.id);
			await notifyUnlaunchedPlanResolved(node, outcome);
		}
		await reportBlockedPlanActions(state);
	};

	const launchPlanNode = async (
		state: TurnState<SessionID, Output, StateData>,
		input: StartInput,
		node: PlanExecutionNode,
		candidateNames: readonly string[],
		mode: "speculative" | "promoted" = "speculative",
	): Promise<boolean> => {
		if (state.finished || state.terminal) {
			state.planGraph.defer(node.proposalID, node.action.id);
			return false;
		}
		const settings = await latestSettings();
		if (!settings || !sourceEnabled(settings, node.source)) {
			state.planGraph.markFailed(node.proposalID, node.action.id);
			await notifyUnlaunchedPlanResolved(node, "system");
			await reportBlockedPlanActions(state);
			return false;
		}
		const context = planLaunchContexts.get(state.sessionID)?.get(planActionIdentity(node.proposalID, node.action.id));
		const actionHorizon = finiteNonNegativeInteger(node.action.horizon);
		const effectiveAnchor = Math.max(0, node.expectedActionSeq - actionHorizon - 1);
		const expectedLeadFloorMs =
			mode === "speculative" &&
			node.action.type === "tool_call" &&
			node.expectedActionSeq > state.actionSequence &&
			(actionHorizon > 0 || (node.action.dependsOn?.length ?? 0) > 0)
				? finitePositive(node.action.expectedDurationMs, serviceTimes.get(node.action.tool)?.averageMs ?? 1)
				: 0;
		let accepted: number;
		try {
			accepted = await admitPredictions(
				state,
				input,
				[planActionDraft(node.proposalID, node.source, node.action)],
				context?.predictionLatencyMs ?? 0,
				context?.draftTokens ?? 0,
				context?.totalDraftTokens ?? tokenTotals.get(state.sessionID) ?? 0,
				node.source,
				candidateNames,
				effectiveAnchor,
				mode,
				expectedLeadFloorMs,
			);
		} catch (error) {
			state.planGraph.markFailed(node.proposalID, node.action.id);
			await publishMiss(state, "plan_action_launch_failed", undefined, errorDetail(error), {
				draftCandidate: draftCandidateDiagnostic(planActionDraft(node.proposalID, node.source, node.action)),
			});
			await notifyUnlaunchedPlanResolved(node, "system");
			await reportBlockedPlanActions(state);
			return false;
		}
		const current = state.planGraph.get(node.proposalID, node.action.id);
		if (accepted > 0) {
			if (node.action.type === "preparation_hint") {
				state.planGraph.markSucceeded(node.proposalID, node.action.id);
			} else if (current?.state === "launching") {
				state.planGraph.markRunning(node.proposalID, node.action.id);
			}
			await reportBlockedPlanActions(state);
			return true;
		}
		if (current?.state === "launching") {
			state.planGraph.markFailed(node.proposalID, node.action.id);
			await notifyUnlaunchedPlanResolved(node, "system");
		}
		await reportBlockedPlanActions(state);
		return false;
	};

	const dispatchReadyPlanActions = async (
		state: TurnState<SessionID, Output, StateData>,
		input: StartInput = state.startInput as StartInput,
		candidateNames?: readonly string[],
	): Promise<void> => {
		if (state.finished || state.terminal) return;
		const names = candidateNames ?? candidateToolNames(state.settings, actionSemantics);
		const ready = [...state.planGraph.takeReady(state.actionSequence)].sort(
			(left, right) =>
				draftPriority(planActionDraft(right.proposalID, right.source, right.action)) -
					draftPriority(planActionDraft(left.proposalID, left.source, left.action)) ||
				left.expectedActionSeq - right.expectedActionSeq ||
				left.action.id.localeCompare(right.action.id),
		);
		state.planDispatchDepth++;
		try {
			for (const node of ready) {
				if (state.finished || state.terminal) {
					state.planGraph.defer(node.proposalID, node.action.id);
					continue;
				}
				await launchPlanNode(state, input, node, names);
			}
		} finally {
			state.planDispatchDepth--;
			if (state.planDispatchDepth === 0) {
				for (const candidate of state.pendingSchedulerCompletions) {
					schedulerFor(state.sessionID).complete(candidate);
				}
				state.pendingSchedulerCompletions.clear();
			}
		}
		await reportBlockedPlanActions(state);
	};

	const promoteDeferredPlanAction = async (
		state: TurnState<SessionID, Output, StateData>,
		actor: ActionKey,
	): Promise<boolean> => {
		const settings = await latestSettings();
		if (!settings || state.finished || state.terminal) return false;
		const matches: Array<{ readonly node: PlanExecutionNode; readonly distance: number }> = [];
		for (const node of state.planGraph.deferred()) {
			if (node.action.type !== "tool_call" || node.action.tool !== actor.tool) continue;
			if (!sourceEnabled(settings, node.source)) continue;
			const concrete = asConcreteInput(node.action.input);
			if (!concrete) continue;
			const key = await adapter.actionKey(node.action.tool, concrete, {
				type: "start",
				startInput: state.startInput as StartInput,
				data: state.data,
			});
			if (!key) continue;
			const match = actionKeyMatch(key, actor, keyProjectors);
			if (!match || (match.kind === "projected" && !actionKeyCovers(key, actor, keyProjectors))) continue;
			matches.push({ node, distance: match.distance });
		}
		matches.sort(
			(left, right) =>
				left.distance - right.distance ||
				left.node.expectedActionSeq - right.node.expectedActionSeq ||
				left.node.proposalID.localeCompare(right.node.proposalID) ||
				left.node.action.id.localeCompare(right.node.action.id),
		);
		for (const { node } of matches) {
			const promotion = state.planGraph.promote(node.proposalID, node.action.id);
			if (promotion.status !== "claimed") continue;
			await preemptForAuthoritative(
				state,
				resourceProfile(actor.execution, actionSemantics.sandboxMode(actor.tool)),
			);
			if (
				await launchPlanNode(
					state,
					state.startInput as StartInput,
					promotion.node,
					candidateToolNames(settings, actionSemantics),
					"promoted",
				)
			) {
				return true;
			}
		}
		return false;
	};

	const adoptObservedPlanActions = async (
		state: TurnState<SessionID, Output, StateData>,
		actor: ActionKey,
		actionSequence: number,
	): Promise<void> => {
		const earliestByProposal = new Map<string, PlanExecutionNode>();
		for (const node of state.planGraph.values()) {
			if (
				node.action.type !== "tool_call" ||
				node.expectedActionSeq > actionSequence ||
				!state.planGraph.canAdopt(node.proposalID, node.action.id)
			) {
				continue;
			}
			if (node.action.tool !== actor.tool) continue;
			const concrete = asConcreteInput(node.action.input);
			if (!concrete) continue;
			const key = await adapter.actionKey(node.action.tool, concrete, {
				type: "start",
				startInput: state.startInput as StartInput,
				data: state.data,
			});
			if (!key || !actionKeyCovers(key, actor, keyProjectors)) continue;
			const current = earliestByProposal.get(node.proposalID);
			if (
				!current ||
				node.expectedActionSeq < current.expectedActionSeq ||
				(node.expectedActionSeq === current.expectedActionSeq &&
					node.action.id.localeCompare(current.action.id) < 0)
			) {
				earliestByProposal.set(node.proposalID, node);
			}
		}
		for (const node of earliestByProposal.values()) {
			state.planGraph.markAdopted(node.proposalID, node.action.id, actionSequence);
		}
		await reportBlockedPlanActions(state);
		await dispatchReadyPlanActions(state, state.startInput as StartInput);
	};

	const admitPlanUpdates = async (
		state: TurnState<SessionID, Output, StateData>,
		input: StartInput,
		source: string,
		updates: PlanUpdate | readonly PlanUpdate[],
		predictionLatencyMs: number,
		candidateNames: readonly string[],
		predictionAnchorActionSeq = state.actionSequence,
	): Promise<number> => {
		let accepted = 0;
		for (const update of Array.isArray(updates) ? updates : [updates]) {
			if (update.source !== source) {
				await publishMiss(state, "invalid_plan_update", undefined, "Plan source does not own this update.");
				continue;
			}
			const proposalID = "actions" in update ? update.id : update.proposalID;
			const previousPlan = state.plans.get(proposalID);
			const result = state.plans.apply(update);
			if (!result.accepted) {
				await publishMiss(state, "invalid_plan_update", undefined, result.reason);
				continue;
			}
			const superseded = result.upserted.flatMap((action) => {
				const previous = previousPlan?.actions.find((candidate) => candidate.id === action.id);
				return previous && !samePlanActionExecution(previous, action) ? [action.id] : [];
			});
			await removePlanActions(state, source, result.plan.id, [...new Set([...result.removed, ...superseded])]);
			const draftTokens = finiteMetric(update.draftTokens);
			const totalDraftTokens = finiteMetric(tokenTotals.get(state.sessionID)) + draftTokens;
			tokenTotals.set(state.sessionID, totalDraftTokens);
			const contexts = planLaunchContexts.get(state.sessionID) ?? new Map();
			planLaunchContexts.set(state.sessionID, contexts);
			for (const action of result.upserted) {
				contexts.set(planActionIdentity(result.plan.id, action.id), {
					predictionLatencyMs,
					draftTokens,
					totalDraftTokens,
				});
			}
			state.planGraph.upsert(result.plan, result.upserted, predictionAnchorActionSeq);
			accepted += result.upserted.length;
			await dispatchReadyPlanActions(state, input, candidateNames);
		}
		return accepted;
	};

	const continuePredictionCandidate = async (
		state: TurnState<SessionID, Output, StateData>,
		input: StartInput,
		candidate: RuntimeCandidate<Output>,
		output: Output,
		parentConfirmed: boolean,
	): Promise<void> => {
		const settings = await latestSettings();
		if (!settings || state.finished || state.terminal) return;
		for (const lease of candidate.leases) {
			const source = sourcesByID.get(lease.source);
			if (
				!sourceEnabled(settings, lease.source) ||
				!sourceMultiStepEnabled(settings, lease.source) ||
				!source?.continue ||
				!lease.proposalID ||
				!lease.actionID ||
				lease.continuationExpansion === "confirmed" ||
				(!parentConfirmed && lease.continuationExpansion === "speculative") ||
				lease.state === "expired" ||
				lease.state === "invalidated"
			) {
				continue;
			}
			lease.continuationExpansion = parentConfirmed ? "confirmed" : "speculative";
			try {
				const updates = await source.continue({
					startInput: input,
					data: state.data,
					settings,
					candidate,
					proposalID: lease.proposalID,
					actionID: lease.actionID,
					feedback: lease.feedback,
					output,
					parentConfirmed,
				});
				if (updates && !state.finished && !state.terminal) {
					await admitPlanUpdates(
						state,
						input,
						lease.source,
						updates,
						0,
						candidateToolNames(settings, actionSemantics),
						continuationAnchorActionSeq(state, candidate),
					);
				}
			} catch {
				// Producer continuation is optional and must not alter actor settlement.
			}
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
		order: number,
	): Promise<void> => {
		try {
			const settings = await latestSettings();
			if (!settings || state.finished || state.terminal) return;
			const concrete = asConcreteInput(actualCall.input);
			if (!concrete) return;
			for (const source of sources) {
				if (!source.observe || !sourceEnabled(settings, source.id)) continue;
				try {
					const updates = await source.observe({
						startInput: state.startInput as StartInput,
						data: state.data,
						settings,
						consumeInput,
						action,
						tool: actualCall.tool,
						concrete,
						output,
						durationMs: finiteMetric(durationMs),
						speculativeHit,
						order,
					});
					if (updates && !state.finished && !state.terminal) {
						await admitPlanUpdates(
							state,
							state.startInput as StartInput,
							source.id,
							updates,
							0,
							candidateToolNames(settings, actionSemantics),
						);
					}
				} catch {
					// One producer's observation must not affect other producers or actor settlement.
				}
			}
		} catch {
			// Analyzer bookkeeping is optional and must not alter actor settlement.
		}
	};

	const runPrediction = async (
		input: StartInput,
		definitions: readonly DrafterToolDefinition[],
		candidateNames: readonly string[],
		state: TurnState<SessionID, Output, StateData>,
	): Promise<void> => {
		let accepted = 0;
		const predictionAnchorActionSeq = state.actionSequence;
		try {
			for (const source of sources) {
				if (state.finished || state.terminal) return;
				const current = await latestSettings();
				if (!current) return;
				let enabled: boolean;
				try {
					enabled = sourceEnabled(current, source.id);
				} catch (error) {
					await publishMiss(state, "prediction_source_error", undefined, `${source.id}: ${errorDetail(error)}`);
					continue;
				}
				if (!enabled) continue;
				if (source.adaptive && adaptiveSourceBackoffEnabled(state)) {
					const activePlan = [...availableCandidates(state).values()].some(
						(candidate) =>
							candidate.reuse.kind === "shared" &&
							candidate.leases.some((lease) => lease.state === "active" && lease.source === source.id),
					);
					if (activePlan || !takeSourceOpportunity(input.sessionID, source.id)) continue;
				}
				state.sourceAttempts.add(source.id);
				const predictionStarted = Date.now();
				const sourceController = new AbortController();
				const abortSource = () => sourceController.abort();
				if (state.predictionController.signal.aborted) sourceController.abort();
				else state.predictionController.signal.addEventListener("abort", abortSource, { once: true });
				try {
					const proposed = Promise.resolve(
						source.propose({
							startInput: input,
							data: state.data,
							settings: current,
							definitions,
							candidateNames,
							signal: sourceController.signal,
						}),
					);
					const timeout = source.timeoutMs?.(current);
					const proposals =
						timeout === undefined
							? await proposed
							: await withTimeout(proposed, Math.max(0, timeout), () => sourceController.abort());
					if (state.finished || state.terminal) return;
					const sourceAccepted = await admitPlanUpdates(
						state,
						input,
						source.id,
						proposals,
						Math.max(0, Date.now() - predictionStarted),
						candidateNames,
						predictionAnchorActionSeq,
					);
					accepted += sourceAccepted;
					if (source.adaptive && adaptiveSourceBackoffEnabled(state) && sourceAccepted === 0) {
						recordSourceFailure(state, source.id, "source_error");
					}
				} catch (error) {
					if (state.finished || state.terminal) return;
					if (source.adaptive && adaptiveSourceBackoffEnabled(state)) {
						recordSourceFailure(state, source.id, "source_error");
					}
					await publishMiss(
						state,
						error instanceof PredictionTimeoutError ? "prediction_timeout" : "prediction_source_error",
						undefined,
						`${source.id}: ${errorDetail(error)}`,
					);
				} finally {
					state.predictionController.signal.removeEventListener("abort", abortSource);
				}
			}
			if (!accepted && !state.noCandidateReported) {
				state.noCandidateReported = true;
				await publishMiss(state, "no_candidate", undefined, "No plan action passed validation and admission.");
			}
		} finally {
			state.predictionPending = false;
		}
	};

	const startTurn = async (input: StartInput, signal?: AbortSignal): Promise<void> => {
		const settings = await adapter.settings();
		const definitions = adapter.definitions(input);
		const candidateNames = candidateToolNames(settings, actionSemantics);
		if (!masterEnabled(settings) || notifiedMasterEnabled === false) {
			await disableSession(input.sessionID);
			return;
		}
		if (!candidateNames.length) {
			for (const candidate of sessionCandidates(input.sessionID)) {
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
			data: await adapter.stateData(input),
			settings,
			predictionController: new AbortController(),
			actorActionSequences: new Map(),
			actorCallSequences: new Map(),
			preparedHints: new Set(),
			pendingActionSequences: new Set(),
			turnAdmissions: new Map(),
			plans: planLedgerFor(input.sessionID),
			planGraph: planGraphFor(input.sessionID),
			sourceAttempts: new Set(),
			sourceFeedback: new Map(),
			sourcePlanMismatches: new Set(),
			pendingSchedulerCompletions: new Set(),
			actionSequence: actionSequences.get(input.sessionID) ?? 0,
			planDispatchDepth: 0,
			terminal: false,
			finished: false,
			noCandidateReported: false,
			predictionPending: true,
		};
		turns.set(turnKey(input), state);
		await reconcileCandidateStores(state);
		await dispatchReadyPlanActions(state, input, candidateNames);
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
		const state = turns.get(turnKey(input));
		if (!state || signal?.aborted) return undefined;
		// Capture the jobs visible when the actor arrived. A fast validation
		// failure may retire a job while settings or K(a) are still resolving;
		// retaining the reference lets the actor receive the precise rejection
		// instead of an indistinguishable empty-cache miss.
		const candidatesAtArrival = [...availableCandidates(state).values()];
		const settings = await latestSettings();
		if (!settings || !masterEnabled(settings)) {
			await disableSession(input.sessionID);
			return undefined;
		}
		if (state.finished || signal?.aborted) return undefined;
		const actionSequence = (actionSequences.get(state.sessionID) ?? state.actionSequence) + 1;
		actionSequences.set(state.sessionID, actionSequence);
		state.actionSequence = Math.max(state.actionSequence, actionSequence);
		state.pendingActionSequences.add(actionSequence);
		try {
			const actualCall = adapter.actual(input);
			if (actualCall.id) state.actorCallSequences.set(actualCall.id, actionSequence);
			const actual = await adapter.actionKey(actualCall.tool, actualCall.input, {
				type: "consume",
				consumeInput: input,
			});
			const actualAction = diagnosticAction(actualCall.tool, actualCall.input, actual);
			if (actual) await promoteDeferredPlanAction(state, actual);
			const candidates = [...new Set([...candidatesAtArrival, ...availableCandidates(state).values()])];
			const activePlanSources = activeAdaptivePlanSources(candidates, actionSequence, state.planGraph);
			if (!actual) {
				markPlanMismatches(state, activePlanSources);
				await preemptForAuthoritative(state, { class: "global", units: 1 });
				return undefined;
			}

			state.actorActionSequences.set(
				actual.key,
				Math.max(state.actorActionSequences.get(actual.key) ?? 0, actionSequence),
			);
			const choices = matchingCandidates(state, actual, candidatesAtArrival);
			const compatibleCandidates = new Set(choices.map((choice) => choice.candidate));
			const rejectionCounts = new Map<string, number>();
			const recordRejection = (reason: string, count = 1): void => {
				if (count <= 0) return;
				rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + count);
			};
			for (const candidate of candidates) {
				if (compatibleCandidates.has(candidate)) continue;
				const reason = actionKeyMismatchReason(candidate.key, actual, keyProjectors);
				if (reason) recordRejection(reason);
			}
			const lookupDiagnostics = (): SpeculativeLookupDiagnostics => ({
				candidateCount: candidates.length,
				compatibleCount: choices.length,
				rejections: [...rejectionCounts]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([reason, count]) => ({ reason, count })),
			});
			const actualConcrete = adapter.authorizeCandidate ? asConcreteInput(actualCall.input) : undefined;
			if (adapter.authorizeCandidate && !actualConcrete) {
				recordRejection("invalid_tool_call_input", choices.length);
				await publishMiss(state, "invalid_tool_call_input", actual, undefined, {
					actualAction,
					lookup: lookupDiagnostics(),
				});
				await preemptForAuthoritative(
					state,
					resourceProfile(actual.execution, actionSemantics.sandboxMode(actual.tool)),
				);
				return undefined;
			}

			const consumeStarted = Date.now();
			let totalWaitedMs = 0;
			let lastFailure:
				| {
						readonly choice: RankedRuntimeCandidate<Output>;
						readonly reason: string;
						readonly detail?: string;
				  }
				| undefined;
			let selected:
				| {
						readonly candidate: RuntimeCandidate<Output>;
						readonly output: Output;
						readonly projectionDurationMs: number;
						readonly matchedPlanSources: ReadonlySet<string>;
				  }
				| undefined;
			const reject = (
				choice: RankedRuntimeCandidate<Output>,
				reason: string,
				detail?: string,
				lookupReason = reason,
			): void => {
				lastFailure = { choice, reason, ...(detail ? { detail } : {}) };
				recordRejection(lookupReason);
			};

			for (const choice of choices) {
				const { candidate, match } = choice;
				if (!candidateCanMatch(candidate, actionSequence)) {
					reject(
						choice,
						candidate.run.status === "closed"
							? candidate.run.reason
							: candidate.reuse.kind === "exclusive" && candidate.reuse.state !== "available"
								? "candidate_claimed"
								: "prediction_horizon_expired",
					);
					continue;
				}
				if (!claimCandidate(candidate, state.turnID)) {
					reject(choice, "candidate_claimed");
					continue;
				}
				const matchedPlanSources = activeAdaptivePlanSources([candidate], actionSequence);
				// Prediction feedback measures whether the actor requested an equivalent
				// action, independently from whether the cached result is still usable.
				// Preserve that boundary before freshness, authorization, and execution
				// validation can reject this candidate and trigger the next fallback.
				await matchPredictionLeases(state, candidate, actionSequence);
				const inFlightAtMatch = candidate.run.status === "running";

				if (adapter.authorizeCandidate && actualConcrete) {
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
						releaseCandidateClaim(candidate, state.turnID);
						reject(choice, authorization.reason, authorization.detail);
						continue;
					}
				}

				if (await isExpired(adapter, state, input, actual, candidate)) {
					await expireCandidate(state, candidate, "resource_expired");
					reject(choice, "resource_expired");
					continue;
				}
				if (inFlightAtMatch) {
					schedulerFor(state.sessionID).promote(candidate);
					candidate.schedulerOutcome = "promoted";
				} else {
					candidate.schedulerOutcome = "reused";
				}

				const waitStarted = Date.now();
				const execution = await waitForCandidate(candidate.lifecycle.completion, signal);
				totalWaitedMs += Math.max(0, Date.now() - waitStarted);
				if (!execution || signal?.aborted) {
					releaseCandidateClaim(candidate, state.turnID);
					return undefined;
				}
				if (!execution.ok) {
					const reason =
						execution.error instanceof SpeculativeJobError
							? execution.error.reason
							: "candidate_execution_failed";
					await closeCandidate(state, candidate, reason);
					reject(choice, reason, errorDetail(execution.error));
					continue;
				}
				if (inFlightAtMatch && (await isExpired(adapter, state, input, actual, candidate))) {
					await expireCandidate(state, candidate, "resource_expired");
					reject(choice, "resource_expired", "Resource changed before the speculative result could be consumed.");
					continue;
				}

				let output = execution.output;
				if (adapter.adoptCandidate) {
					let adopted: Output | undefined;
					let adoptionDetail: string | undefined;
					try {
						adopted = await adapter.adoptCandidate({
							stateData: state.data,
							consumeInput: input,
							action: actual,
							candidate,
							output,
						});
					} catch (error) {
						adopted = undefined;
						adoptionDetail = errorDetail(error);
					}
					if (adopted === undefined) {
						await expireCandidate(state, candidate, "adoption_failed");
						reject(choice, "adoption_failed", adoptionDetail);
						continue;
					}
					output = adopted;
				}

				const projection = await projectCandidateOutput(candidate, actual, output, match);
				if (!projection.ok) {
					releaseCandidateClaim(candidate, state.turnID);
					reject(choice, "projection_failed", projection.reason, projection.reason);
					continue;
				}
				candidate.projectionMs += projection.durationMs;
				if (match.kind === "projected") {
					observeProjectionOverhead(candidate.tool, match.projector, projection.durationMs);
				}
				selected = {
					candidate,
					output: projection.output,
					projectionDurationMs: projection.durationMs,
					matchedPlanSources,
				};
				break;
			}

			if (!selected) {
				if (choices.length > 0) {
					const diagnosticCandidate = lastFailure?.choice.candidate ?? choices[0]?.candidate;
					await publishMiss(state, lastFailure?.reason ?? "candidate_unavailable", actual, lastFailure?.detail, {
						actualAction,
						lookup: lookupDiagnostics(),
						...(diagnosticCandidate
							? {
									draftCandidate: diagnosticCandidate.draftCandidate,
									predictedAction: diagnosticCandidate.predictedAction,
								}
							: {}),
					});
					markPlanMismatches(state, activePlanSources);
				} else {
					const predicted = new Map(
						[...availableCandidates(state)].filter(([, item]) =>
							[...activeAdaptivePlanSources([item], actionSequence)].some((sourceID) =>
								activePlanSources.has(sourceID),
							),
						),
					);
					if (predicted.size > 0) {
						markPlanMismatches(state, activePlanSources);
						state.pendingPlanMismatch = {
							sources: [...activePlanSources].sort(),
							key: actual,
							actualAction,
							predictedAction: candidatesDiagnostic(predicted),
							lookup: lookupDiagnostics(),
						};
					}
				}
				await preemptForAuthoritative(
					state,
					resourceProfile(actual.execution, actionSemantics.sandboxMode(actual.tool)),
				);
				return undefined;
			}

			const { candidate, output, projectionDurationMs, matchedPlanSources } = selected;
			markPlanMismatches(
				state,
				[...activePlanSources].filter((sourceID) => !matchedPlanSources.has(sourceID)),
			);
			const matchedLease = candidate.leases.find(
				(lease) => lease.state === "matched" && lease.resolvedActionSeq === actionSequence,
			);
			const actorLeadMs = Math.max(0, actorArrivedAt - (candidate.executionStartedAt ?? actorArrivedAt));
			candidate.actorLeadMs = actorLeadMs;
			observeLeadTime(candidate.tool, actorLeadMs, matchedLease?.horizon);

			const consumeOverheadMs = Math.max(0, Date.now() - consumeStarted);
			const executionMs = candidateExecutionMs(candidate) || Math.max(0, Date.now() - candidate.startedAt);
			observeHitOverhead(actual.tool, candidate.validationMs + (candidate.commitMs ?? 0) + projectionDurationMs);
			completePredictionMatch(candidate, actionSequence);
			markCandidatePlanAdopted(state, candidate, actionSequence);
			candidate.hits++;
			candidate.authoritativeSequence = Math.max(candidate.authoritativeSequence ?? 0, actionSequence);
			if (candidate.reuse.kind === "shared") {
				results.recordActorHit(state.sessionID, candidate, cacheLimits(state.settings));
			} else {
				candidate.lifecycle.markAdopted(executionMs);
				schedulerFor(state.sessionID).discard(candidate);
				removeTurnAdmission(state, candidate);
				removeCandidateFromStores(state, candidate);
				releaseCandidateResourceVersion(candidate);
				candidateCatalog.retire(candidate);
			}
			await invalidateChangedResources(state, actual, candidate);
			const matchedLeases = candidate.leases.filter(
				(lease) => lease.state === "hit" && lease.resolvedActionSeq === actionSequence,
			);
			const eventSource: SpeculativeSchedulingEventFields["source"] = matchedLeases[0]?.source ?? "cache";
			const eventSources = [...new Set(matchedLeases.map((lease) => lease.source))];
			await emit({
				type: "hit",
				sources: eventSources.length ? eventSources : ["cache"],
				sessionID: state.sessionID,
				turnID: state.turnID,
				timestamp: Date.now(),
				tool: actual.tool,
				actionKeyHash: actual.hash,
				savedMs: Math.max(0, executionMs - consumeOverheadMs),
				waitedMs: totalWaitedMs,
				consumeOverheadMs,
				predictionLatencyMs: candidate.predictionLatencyMs,
				draftTokens: candidate.draftTokens,
				totalDraftTokens: candidate.totalDraftTokens,
				draftCandidate: candidate.draftCandidate,
				predictedAction: candidate.predictedAction,
				actualAction,
				lookup: lookupDiagnostics(),
				...schedulingEventFields(candidate, eventSource),
				...cacheSnapshot(state),
			});
			await recordAndPredict(state, input, actualCall, actual, output, executionMs, true, actionSequence);
			if (actualCall.id) state.actorCallSequences.delete(actualCall.id);
			await continuePredictionCandidate(state, state.startInput as StartInput, candidate, output, true);
			// Let the source revise deferred descendants with confirmed confidence
			// before the now-adopted dependency releases them to the scheduler.
			await dispatchReadyPlanActions(state, state.startInput as StartInput);
			return output;
		} finally {
			state.pendingActionSequences.delete(actionSequence);
			await expirePredictionLeasesAfterAction(state);
			await dispatchReadyPlanActions(state, state.startInput as StartInput);
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
		const actionSequence = actualCall.id
			? (state.actorCallSequences.get(actualCall.id) ?? state.actionSequence)
			: state.actionSequence;
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
		if (key) {
			await invalidateChangedResources(state, key);
			await adoptObservedPlanActions(state, key, actionSequence);
		}
		await recordAndPredict(state, input, actualCall, key, input.output, durationMs, false, actionSequence);
		if (actualCall.id) state.actorCallSequences.delete(actualCall.id);
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
		const missedPlanSources = new Set(
			[...state.sourcePlanMismatches].filter((sourceID) => state.sourceFeedback.get(sourceID) !== "success"),
		);
		if (adaptiveSourceBackoffEnabled(state)) {
			for (const sourceID of missedPlanSources) recordSourceFailure(state, sourceID, "actor_miss");
		}
		if (state.pendingPlanMismatch?.sources.some((sourceID) => missedPlanSources.has(sourceID))) {
			await publishMiss(state, "key_mismatch", state.pendingPlanMismatch.key, undefined, {
				predictedAction: state.pendingPlanMismatch.predictedAction,
				actualAction: state.pendingPlanMismatch.actualAction,
				lookup: state.pendingPlanMismatch.lookup,
			});
		}
		for (const sourceID of state.sourceAttempts) {
			if (
				adaptiveSourceBackoffEnabled(state) &&
				sourcesByID.get(sourceID)?.adaptive &&
				!state.sourceFeedback.has(sourceID)
			) {
				recordSourceFailure(state, sourceID, "actor_miss");
			}
		}
		for (const node of state.planGraph.values()) {
			if (missedPlanSources.has(node.source)) state.planGraph.markFailed(node.proposalID, node.action.id);
		}
		await reportBlockedPlanActions(state);
		if (terminal) await settleUnlaunchedPlanActions(state, "actor_miss");
		for (const candidate of availableCandidates(state).values()) {
			if (candidate.run.status === "closed") continue;
			if (missedPlanSources.size > 0) {
				await settlePredictionLeases(candidate, "expired", "actor_miss", (lease) =>
					missedPlanSources.has(lease.source),
				);
			}
			if (terminal) {
				await settlePredictionLeases(candidate, "invalidated", "actor_miss");
				if (candidate.reuse.kind === "shared") continue;
				await closeCandidate(state, candidate, "request_finished_without_hit", "invalidated", true);
				continue;
			}
			await expireTurnBoundSourceLeases(state, candidate, true);
			if (candidate.reuse.kind === "shared") continue;
			if (hasActivePredictionLease(candidate)) continue;
			await cancelCandidate(state, candidate, "turn_finished_without_hit");
		}
		await publishCache(state);
		if (terminal) {
			await flushPredictionSources();
			planLedgers.delete(state.sessionID);
			planGraphs.delete(state.sessionID);
			planLaunchContexts.delete(state.sessionID);
		}
		candidateCatalog.detachAllFromTurn(turnKey(state));
		if (!schedulerFor(state.sessionID).snapshot().length) schedulers.delete(state.sessionID);
	};

	const finishTerminalSession = async (sessionID: SessionID, settings: SpeculativeActionSettings): Promise<void> => {
		const candidates = sessionCandidates(sessionID);
		const state = createDisposalState<SessionID, Output, StateData>(sessionID, settings, planGraphs.get(sessionID));
		await settleUnlaunchedPlanActions(state, "actor_miss");
		for (const candidate of candidates) {
			if (candidate.reuse.kind === "exclusive") {
				await closeCandidate(state, candidate, "request_finished_without_hit", "invalidated", true);
			} else {
				await settlePredictionLeases(candidate, "invalidated", "actor_miss");
			}
		}
		if (candidates.length) await publishCache(state);
		await flushPredictionSources();
		planLedgers.delete(sessionID);
		planGraphs.delete(sessionID);
		planLaunchContexts.delete(sessionID);
		if (!schedulerFor(sessionID).snapshot().length) schedulers.delete(sessionID);
	};

	const abortState = async (state: TurnState<SessionID, Output, StateData>, reason: string): Promise<void> => {
		if (state.finished) return;
		state.finished = true;
		state.predictionController.abort();
		turns.delete(turnKey(state));
		for (const candidate of candidateCatalog.turnValues(turnKey(state))) {
			if (candidate.run.status === "closed") continue;
			await preemptCandidate(candidate, reason, "discarded");
		}
		candidateCatalog.detachAllFromTurn(turnKey(state));
	};

	const finishTurn = async (input: FinishInput): Promise<void> => {
		const settings = await latestSettings();
		if (!settings || !masterEnabled(settings)) {
			await disableSession(input.sessionID);
			return;
		}
		const state = turns.get(turnKey(input));
		if (state) await finishState(state, input.terminal === true);
		else if (input.terminal === true) await finishTerminalSession(input.sessionID, settings);
	};

	const disposeSession = async (sessionID: SessionID): Promise<void> => {
		for (const state of [...turns.values()].filter((item) => item.sessionID === sessionID)) {
			await abortState(state, "session_disposed");
		}
		const settings = await adapter.settings();
		const stateForEvents = createDisposalState<SessionID, Output, StateData>(
			sessionID,
			settings,
			planGraphs.get(sessionID),
		);
		await settleUnlaunchedPlanActions(stateForEvents, "system");
		for (const candidate of candidateCatalog.sessionValues(sessionID)) {
			await closeCandidate(stateForEvents, candidate, "session_disposed", "invalidated", true);
		}
		tokenTotals.delete(sessionID);
		wallTimes.delete(sessionID);
		actionSequences.delete(sessionID);
		schedulers.delete(sessionID);
		sourceBackoff.delete(sessionID);
		planLedgers.delete(sessionID);
		planGraphs.delete(sessionID);
		planLaunchContexts.delete(sessionID);
		await flushPredictionSources();
	};

	const dispose = async (): Promise<void> => {
		const sessions = new Set<SessionID>();
		for (const state of turns.values()) sessions.add(state.sessionID);
		for (const sessionID of tokenTotals.keys()) sessions.add(sessionID);
		for (const candidate of candidateCatalog.allValues()) {
			const record = candidateCatalog.record(candidate);
			if (record) sessions.add(record.sessionID);
		}
		for (const sessionID of sessions) await disposeSession(sessionID);
		schedulers.clear();
		sourceBackoff.clear();
		planLedgers.clear();
		planGraphs.clear();
		planLaunchContexts.clear();
		actionSequences.clear();
	};

	const inspect = (sessionID?: SessionID): SpeculativeRuntimeInspection => {
		const states = [...turns.values()].filter((state) => sessionID === undefined || state.sessionID === sessionID);
		const candidates =
			sessionID === undefined
				? [...jobs.allValues(), ...results.allValues(), ...branches.allValues()]
				: sessionCandidates(sessionID);
		const planNodes =
			sessionID === undefined
				? [...planGraphs.values()].flatMap((graph) => graph.values())
				: (planGraphs.get(sessionID)?.values() ?? []);
		return {
			activeTurns: states.length,
			turnCandidates: candidates.filter((candidate) => candidate.reuse.kind === "exclusive").length,
			resourceCandidates: candidates.filter((candidate) => candidate.reuse.kind === "shared").length,
			pendingPredictions: states.filter((state) => state.predictionPending).length,
			deferredPlanActions: planNodes.filter((node) => node.state === "deferred").length,
			activePlanActions: planNodes.filter((node) => node.state === "launching" || node.state === "running").length,
			blockedPlanActions: planNodes.filter((node) => node.state === "blocked").length,
		};
	};

	return { startTurn, consume, actual, finishTurn, settingsChanged, releaseSession, disposeSession, dispose, inspect };
}

export function candidateToolNames(
	settings: SpeculativeActionSettings,
	semantics: ActionSemanticsRegistry = PI_ACTION_SEMANTICS,
): readonly string[] {
	const resourceCached = new Set(settings.tools.resourceCached);
	const sandbox = new Set(settings.tools.sandbox);
	return semantics
		.toolNames()
		.filter((tool) => (semantics.execution(tool) === "sandbox" ? sandbox.has(tool) : resourceCached.has(tool)));
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

function candidateFutureHorizon(candidate: SpeculativeCandidate): number | undefined {
	return candidate.leases.find(
		(lease) => lease.horizon !== undefined && (lease.state === "active" || lease.state === "hit"),
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
	planGraph = new PlanExecutionGraph(),
): TurnState<SessionID, Output, StateData> {
	return {
		sessionID,
		turnID: "<dispose>",
		startInput: { sessionID, turnID: "<dispose>" },
		startedAt: Date.now(),
		data: undefined as StateData,
		settings,
		predictionController: new AbortController(),
		actorActionSequences: new Map(),
		actorCallSequences: new Map(),
		preparedHints: new Set(),
		pendingActionSequences: new Set(),
		turnAdmissions: new Map(),
		plans: new PlanLedger(),
		planGraph,
		sourceAttempts: new Set(),
		sourceFeedback: new Map(),
		sourcePlanMismatches: new Set(),
		pendingSchedulerCompletions: new Set(),
		actionSequence: 0,
		planDispatchDepth: 0,
		terminal: true,
		finished: true,
		noCandidateReported: false,
		predictionPending: false,
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

function finiteNonNegative(value: unknown, fallback: number): number {
	const safeFallback = Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : safeFallback;
}

function finitePositive(value: unknown, fallback: number): number {
	return Math.max(1, finiteNonNegative(value, fallback));
}

function finiteNonNegativeInteger(value: unknown): number {
	return Math.floor(finiteMetric(value));
}

function finiteOptionalNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function finitePositiveInteger(value: unknown, fallback: number): number {
	return Math.max(1, Math.floor(finiteNonNegative(value, fallback)));
}

function finiteProbability(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
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
