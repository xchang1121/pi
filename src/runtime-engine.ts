import type { ActionProjectionCoverage, ActionProjectionRule } from "./action-key-projection.ts";
import type {
	ActionKey,
	ActionKeyMatch,
	ActionSemanticsRegistry,
	ProjectedActionKeyMatch,
} from "./action-semantics.ts";
import { actionKeyCovers, actionKeyMatch, PI_ACTION_SEMANTICS } from "./action-semantics.ts";
import { ActorAction } from "./actor-action.ts";
import { CandidateExecution, type CandidateReservation, CandidateResources } from "./candidate-execution.ts";
import { ActionStore, ResultCache, type ResultCacheEvidence, speculativeCacheValue } from "./candidate-stores.ts";
import { DEFAULTS, type DrafterToolDefinition } from "./common.ts";
import { diagnosticAction } from "./diagnostics.ts";
import type { CandidateEventDescriptor, CandidateExecutionProjection } from "./events.ts";
import type { WorldBranch } from "./execution-world.ts";
import type { PlanUpdate } from "./plan-proposal.ts";
import { PlanRuntime, type PlanRuntimeNode, type PredictionOpportunity, type RetiredPlanNode } from "./plan-runtime.ts";
import { PostSettlementQueue } from "./post-settlement.ts";
import { resourceProfile } from "./resource-budget.ts";
import type {
	CandidatePreflight,
	SpeculativeActionEvent,
	SpeculativeActionRuntime,
	SpeculativeActionRuntimeAdapter,
	SpeculativeActionSettings,
	SpeculativeCacheSnapshot,
	SpeculativeCandidate,
	SpeculativeDraftCandidate,
	SpeculativePlanSource,
	SpeculativeRuntimeInspection,
} from "./runtime.ts";
import { type PredictionForecast, SpeculationScheduler } from "./scheduler.ts";
import type {
	ActorActionIdentity,
	PlanActionIdentity,
	PredictionAdoption,
	PredictionSettlement,
	ResolutionCause,
	ResourceValidation,
	SettledSourceRequest,
} from "./settlement.ts";
import { cause, zeroValidationMetrics } from "./settlement.ts";
import { runSourceRequest, SourceGeneration, type SourceRequestResult } from "./source-request.ts";
import { measureSpeculativeTask, type TimelineInterval } from "./task-timing.ts";

interface TurnInput<SessionID> {
	readonly sessionID: SessionID;
	readonly turnID: string;
	readonly terminal?: boolean;
}

class CandidateFailure extends Error {
	readonly failure: ResolutionCause;

	constructor(failure: ResolutionCause) {
		super(failure.detail ?? failure.code);
		this.failure = failure;
	}
}

function uniqueProjectionRules<Output>(
	rules: readonly ActionProjectionRule<Output>[],
	semantics: ActionSemanticsRegistry,
): readonly ActionProjectionRule<Output>[] {
	const unique = new Map<string, ActionProjectionRule<Output>>();
	for (const rule of rules) {
		if (semantics.supportsProjector(rule.id) && !unique.has(rule.id)) unique.set(rule.id, rule);
	}
	return [...unique.values()];
}

function coveringAction<Output>(predicted: ActionKey, rules: readonly ActionProjectionRule<Output>[]): ActionKey {
	for (const rule of rules) {
		try {
			const covering = rule.coveringAction?.(predicted);
			if (covering && actionKeyCovers(covering, predicted, [rule])) return covering;
		} catch {
			// A projection optimization cannot change the predicted action.
		}
	}
	return predicted;
}

function asUpdates(value: PlanUpdate | readonly PlanUpdate[] | undefined): readonly PlanUpdate[] {
	return value === undefined ? [] : Array.isArray(value) ? value : [value as PlanUpdate];
}

function reservationAvailable(reservation: CandidateReservation): boolean {
	return reservation.kind === "shared" ? reservation.owners.length === 0 : reservation.status === "available";
}

function updateSource(update: PlanUpdate): string {
	return "actions" in update ? update.source : update.source;
}

function immediateOnly(update: PlanUpdate): PlanUpdate {
	if ("actions" in update) {
		return {
			...update,
			actions: update.actions.filter(
				(action) =>
					action.type === "tool_call" &&
					finiteMetric(action.horizon) === 0 &&
					(action.dependsOn?.length ?? 0) === 0,
			),
		};
	}
	return { ...update, upsert: [], remove: update.remove };
}

function requestCount(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(64, Math.floor(value))) : 1;
}

function concurrentLimit(settings: SpeculativeActionSettings): number {
	const value = settings.maxConcurrentActions ?? DEFAULTS.maxConcurrentActions;
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function cacheEntryLimit(settings: SpeculativeActionSettings): number {
	return Number.isFinite(settings.resourceCacheMaxEntries)
		? Math.max(1, Math.floor(settings.resourceCacheMaxEntries))
		: 1;
}

function cacheByteLimit(settings: SpeculativeActionSettings): number {
	return typeof settings.resourceCacheMaxBytes === "number" && Number.isFinite(settings.resourceCacheMaxBytes)
		? Math.max(1, Math.floor(settings.resourceCacheMaxBytes))
		: DEFAULTS.resourceCacheMaxBytes;
}

function cacheLimits(settings: SpeculativeActionSettings) {
	return { maxEntries: cacheEntryLimit(settings), maxBytes: cacheByteLimit(settings), hotFraction: 0.8 };
}

function forecastFor(
	node: PlanRuntimeNode,
	semantics: ActionSemanticsRegistry,
	decisionSequence: number,
	sourceLatencyMs = 0,
): PredictionForecast {
	const execution = node.actionKey?.execution ?? semantics.execution(node.action.tool) ?? "resource_cached";
	return {
		tool: node.action.tool,
		execution,
		sandboxMode: semantics.sandboxMode(node.action.tool) ?? "none",
		...(node.action.expectedDurationMs !== undefined ? { expectedDurationMs: node.action.expectedDurationMs } : {}),
		...(node.action.resourceDemand !== undefined ? { resourceDemand: node.action.resourceDemand } : {}),
		decisionBatchesUntilCall: Math.max(0, node.expectedDecisionSeq - decisionSequence),
		sourceLatencyMs,
		criticalPathMs: node.criticalPathMs,
		...(node.action.expectedLatencyBenefitMs !== undefined
			? { expectedLatencyBenefitMs: node.action.expectedLatencyBenefitMs }
			: {}),
	};
}

function planActionDraft(node: PlanRuntimeNode): SpeculativeDraftCandidate {
	return {
		type: node.action.type,
		tool: node.action.tool,
		input: node.action.input,
		...(node.action.missing ? { missing: node.action.missing } : {}),
		...(node.action.execution ? { execution: node.action.execution } : {}),
		...(node.action.diagnostic ? { diagnostic: node.action.diagnostic } : {}),
		source: node.source,
		proposalID: node.proposalID,
		actionID: node.action.id,
		feedback: node.action.feedback,
		...(node.action.dependsOn ? { dependsOn: node.action.dependsOn } : {}),
		...(node.action.horizon !== undefined ? { horizon: node.action.horizon } : {}),
		...(node.action.latestHorizon !== undefined ? { latestHorizon: node.action.latestHorizon } : {}),
		...(node.action.empiricalProbability !== undefined
			? { empiricalProbability: node.action.empiricalProbability }
			: {}),
		...(node.action.conditionalProbability !== undefined
			? { conditionalProbability: node.action.conditionalProbability }
			: {}),
		...(node.action.expectedDurationMs !== undefined ? { expectedDurationMs: node.action.expectedDurationMs } : {}),
		...(node.action.expectedLatencyBenefitMs !== undefined
			? { expectedLatencyBenefitMs: node.action.expectedLatencyBenefitMs }
			: {}),
		...(node.action.resourceDemand !== undefined ? { resourceDemand: node.action.resourceDemand } : {}),
		...(node.action.depth !== undefined ? { depth: node.action.depth } : {}),
	};
}

function asConcreteInput(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return {};
	return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asWorldBranch<Output>(value: Output | WorldBranch<Output>): WorldBranch<Output> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const branch = value as Partial<WorldBranch<Output>>;
	return typeof branch.commit === "function" && branch.compatibility !== undefined && "output" in branch
		? (value as WorldBranch<Output>)
		: undefined;
}

function publicCandidate<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
): SpeculativeCandidate {
	const execution = candidate.work.execution;
	return {
		id: candidate.id,
		key: candidate.key,
		tool: candidate.key.tool,
		input: candidate.key.input,
		...(candidate.resources.version !== undefined ? { resourceVersion: candidate.resources.version } : {}),
		...("executionMs" in execution ? { work: { execution: { executionMs: execution.executionMs } } } : {}),
		...(candidate.owner.draft.source ? { source: candidate.owner.draft.source } : {}),
	};
}

function predictionCandidate<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
	node: PlanRuntimeNode,
): SpeculativeCandidate {
	return {
		...publicCandidate(candidate),
		source: node.source,
		empiricalProbability: node.action.empiricalProbability,
		conditionalProbability: node.action.conditionalProbability,
		depth: node.action.depth,
		planDependencies: node.action.dependsOn,
	} as unknown as SpeculativeCandidate;
}

function activeExecution<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
): boolean {
	return candidate.work.execution.status !== "failed" && candidate.work.execution.status !== "cancelled";
}

function canShareInFlight<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
	actor: ActionKey,
	match: ProjectedActionKeyMatch,
	rules: readonly ActionProjectionRule<Output>[],
): boolean {
	if (!activeExecution(candidate)) return false;
	const rule = rules.find((item) => item.id === match.projector);
	return rule?.canShareInFlight?.(candidate.key, actor) === true;
}

function captureCoverage<Output>(
	action: ActionKey,
	output: Output,
	rules: readonly ActionProjectionRule<Output>[],
): readonly ActionProjectionCoverage[] {
	return rules.flatMap((rule) => {
		try {
			const value = rule.captureCoverage(action, output);
			return value === undefined ? [] : [{ rule: rule.id, value }];
		} catch {
			return [];
		}
	});
}

async function projectOutput<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
	actor: ActionKey,
	output: Output,
	match: ActionKeyMatch,
	rules: readonly ActionProjectionRule<Output>[],
): Promise<ProjectionResult<Output>> {
	if (match.kind === "exact") return { ok: true, output, durationMs: 0 };
	const rule = rules.find((item) => item.id === match.projector);
	if (!rule) return { ok: false, cause: cause("projection", "rule_missing") };
	const coverage = candidate.projectionCoverage.find((item) => item.rule === rule.id);
	if (!coverage) return { ok: false, cause: cause("projection", "coverage_missing") };
	const startedAt = performance.now();
	try {
		const projected = await rule.projectOutput({
			speculative: candidate.key,
			actor,
			output,
			coverage: coverage.value,
			keyMatch: match,
		});
		const durationMs = Math.max(0, performance.now() - startedAt);
		return projected === undefined
			? { ok: false, cause: cause("projection", "view_not_covered") }
			: { ok: true, output: projected, durationMs };
	} catch (error) {
		return { ok: false, cause: cause("projection", "reconstruction_failed", errorDetail(error)) };
	}
}

async function waitForCandidate<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
	if (!signal) return promise;
	if (signal.aborted) return undefined;
	return new Promise((resolve) => {
		const aborted = () => resolve(undefined);
		signal.addEventListener("abort", aborted, { once: true });
		void promise.then((value) => {
			signal.removeEventListener("abort", aborted);
			resolve(value);
		});
	});
}

function registerActorAction<SessionID, Output, StartInput, StateData>(
	session: SessionState<SessionID, Output, StartInput, StateData>,
	callID: string | undefined,
	action: ActorAction,
): void {
	if (callID) session.actorCalls.set(callKey(action.identity.turnID, callID), action);
	else session.anonymousActorCalls.push(action);
}

function takeActorAction<SessionID, Output, StartInput, StateData>(
	session: SessionState<SessionID, Output, StartInput, StateData>,
	turnID: string,
	call: ActualToolCall,
): ActorAction | undefined {
	if (call.id) {
		const key = callKey(turnID, call.id);
		const action = session.actorCalls.get(key);
		session.actorCalls.delete(key);
		return action;
	}
	const index = session.anonymousActorCalls.findIndex(
		(action) =>
			action.identity.turnID === turnID && action.tool === call.tool && action.state.status === "awaiting_fallback",
	);
	return index < 0 ? undefined : session.anonymousActorCalls.splice(index, 1)[0];
}

function forgetActorAction<SessionID, Output, StartInput, StateData>(
	session: SessionState<SessionID, Output, StartInput, StateData>,
	callID: string | undefined,
	action: ActorAction,
): void {
	if (callID) {
		session.actorCalls.delete(callKey(action.identity.turnID, callID));
		return;
	}
	const index = session.anonymousActorCalls.indexOf(action);
	if (index >= 0) session.anonymousActorCalls.splice(index, 1);
}

function clearActorActions<SessionID, Output, StartInput, StateData>(
	session: SessionState<SessionID, Output, StartInput, StateData>,
	turnID?: string,
): void {
	if (turnID === undefined) {
		session.actorCalls.clear();
		session.anonymousActorCalls.length = 0;
		return;
	}
	for (const [key, action] of session.actorCalls) {
		if (action.identity.turnID === turnID) session.actorCalls.delete(key);
	}
	for (let index = session.anonymousActorCalls.length - 1; index >= 0; index--) {
		if (session.anonymousActorCalls[index]?.identity.turnID === turnID) session.anonymousActorCalls.splice(index, 1);
	}
}

function callKey(turnID: string, callID: string): string {
	return JSON.stringify([turnID, callID]);
}

function observeActorDecisionInterval<SessionID, Output, StartInput, StateData>(
	session: SessionState<SessionID, Output, StartInput, StateData>,
	arrivedAt: number,
): void {
	const previous = session.lastActorArrivedAt;
	session.lastActorArrivedAt = arrivedAt;
	if (previous === undefined) return;
	const interval = Math.max(0, arrivedAt - previous);
	if (interval >= 25) session.scheduler.observeActorDecisionInterval(interval);
}

function closeActorPhase<SessionID, Output, StartInput, StateData>(
	turn: TurnState<SessionID, Output, StartInput, StateData>,
	completedAt: number,
): void {
	if (turn.actorPhaseCompletedAt !== undefined) return;
	turn.actorPhaseCompletedAt = Math.max(turn.startedAt, completedAt);
	turn.session.actorPhaseIntervals.push({ startedAt: turn.startedAt, completedAt: turn.actorPhaseCompletedAt });
}

function enterActorAdmission<SessionID, Output, StartInput, StateData>(
	session: SessionState<SessionID, Output, StartInput, StateData>,
): { readonly ready: Promise<void>; readonly release: () => void } {
	const ready = session.actorAdmissionTail;
	let unlock!: () => void;
	session.actorAdmissionTail = new Promise<void>((resolve) => {
		unlock = resolve;
	});
	let released = false;
	return {
		ready,
		release: () => {
			if (released) return;
			released = true;
			unlock();
		},
	};
}

function turnKey<SessionID>(sessionID: SessionID, turnID: string): string {
	return JSON.stringify([String(sessionID), turnID]);
}

function outputIsError(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && (value as { readonly isError?: unknown }).isError === true);
}

function candidateEventDescriptor<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
): CandidateEventDescriptor {
	return {
		source: candidate.owner.draft.source ?? "cache",
		depth: candidate.owner.draft.depth ?? 0,
		id: candidate.id,
		tool: candidate.key.tool,
		actionKeyHash: candidate.key.hash,
		execution: candidate.key.execution,
		predictedAction: diagnosticAction(candidate.key.tool, candidate.key.input, candidate.key),
		predictionLatencyMs: candidate.predictionLatencyMs,
		draftTokens: candidate.draftTokens,
		totalDraftTokens: candidate.totalDraftTokens,
		expectedDurationMs: candidate.expectedDurationMs,
		estimatedBytes: candidate.estimatedBytes,
		validation: {
			durationMs: candidate.validationMs,
			bytesRead: candidate.validationBytes,
			filesRead: candidate.validationFiles,
			...(candidate.validationMode ? { mode: candidate.validationMode } : {}),
		},
	};
}

function candidateExecutionProjection<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
): CandidateExecutionProjection | undefined {
	const state = candidate.work.execution;
	if (state.status === "queued") return undefined;
	if (state.status === "running") return { status: "running", startedAt: state.startedAt };
	if (state.status === "succeeded") {
		return {
			status: "succeeded",
			startedAt: state.startedAt,
			completedAt: state.completedAt,
			executionMs: state.executionMs,
		};
	}
	return {
		status: state.status,
		cause: state.cause,
		...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
		completedAt: state.completedAt,
		executionMs: state.executionMs,
	};
}

function candidateCacheValue<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
	evidence: ResultCacheEvidence,
	now: number,
): number {
	const execution = candidate.work.execution;
	const reuseSamples = Math.max(1, evidence.actorHits);
	return speculativeCacheValue(
		{
			executionMs: "executionMs" in execution ? execution.executionMs : candidate.expectedDurationMs,
			expectedValidationMs: candidate.validationMs / reuseSamples,
			expectedProjectionMs: candidate.projectionMs / reuseSamples,
			bytes: candidate.estimatedBytes,
			actorHits: evidence.actorHits,
			insertedAt: evidence.insertedAt,
			...(evidence.lastActorHitAt ? { lastActorHitAt: evidence.lastActorHitAt } : {}),
		},
		now,
	);
}

function executionDuration<Output, StartInput, StateData>(
	candidate: CandidateRecord<Output, StartInput, StateData>,
): number {
	const execution = candidate.work.execution;
	return "executionMs" in execution ? execution.executionMs : 0;
}

function estimateValueBytes(value: unknown, seen = new WeakSet<object>()): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "string") return value.length * 2;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return 8;
	if (typeof value !== "object" || seen.has(value)) return 0;
	seen.add(value);
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateValueBytes(item, seen), 0);
	return Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + estimateValueBytes(item, seen), 0);
}

function resourcePathsOverlap(left: string, right: string): boolean {
	const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const a = normalize(left);
	const b = normalize(right);
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function uniqueCandidates<T extends object>(candidates: readonly T[]): T[] {
	return [...new Set(candidates)];
}

function maybe<T>(value: T | undefined): T[] {
	return value === undefined ? [] : [value];
}

function finiteMetric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

interface ActualToolCall {
	readonly id?: string;
	readonly tool: string;
	readonly input: unknown;
}

interface PlanActionContext<StartInput, StateData> {
	readonly identity: PlanActionIdentity;
	readonly opportunity?: PredictionOpportunity;
	feedback: unknown;
	readonly startInput: StartInput;
	readonly data: StateData;
	readonly settings: SpeculativeActionSettings;
	readonly attemptStartedAt: number;
	readonly predictionLatencyMs: number;
	readonly draftTokens: number;
	readonly totalDraftTokens: number;
	draft: SpeculativeDraftCandidate;
	readonly admissionSignal: AbortSignal;
	readonly sourceSlot?: SourceRequestSlot;
	continuationSlot?: SourceRequestSlot;
	readonly continuationTriggers: Set<"execution_succeeded" | "actor_adopted">;
	continuationTail: Promise<void>;
}

/** One producer request from the bounded budget for a future Actor action. */
interface SourceRequestSlot {
	readonly source: string;
	readonly targetActionSequence: number;
	readonly expiresAtTarget: boolean;
	readonly generations: Set<SourceGeneration>;
	readonly owners: Set<string>;
	pendingAdmissions: number;
	requestFinished: boolean;
	active: boolean;
}

interface PlanAdmissionScope<SessionID, Output, StartInput, StateData> {
	readonly session: SessionState<SessionID, Output, StartInput, StateData>;
	readonly startInput: StartInput;
	readonly data: StateData;
	readonly settings: SpeculativeActionSettings;
	readonly signal: AbortSignal;
	readonly slot?: SourceRequestSlot;
}

interface CandidateRecord<Output, StartInput, StateData> {
	readonly id: string;
	readonly key: ActionKey;
	readonly work: CandidateExecution<Output>;
	readonly owner: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly draft: SpeculativeDraftCandidate;
		readonly index: number;
	};
	readonly createdAt: number;
	readonly attemptStartedAt: number;
	readonly predictionLatencyMs: number;
	readonly draftTokens: number;
	readonly totalDraftTokens: number;
	expectedDurationMs: number;
	expectedDecisionSeq: number;
	criticalPathMs: number;
	priorityMs: number;
	estimatedBytes: number;
	readonly resources: CandidateResources;
	projectionCoverage: readonly ActionProjectionCoverage[];
	validationMs: number;
	validationBytes: number;
	validationFiles: number;
	validationMode?: "watcher" | "exact";
	projectionMs: number;
	world?: WorldBranch<Output>;
}

interface SessionState<SessionID, Output, StartInput, StateData> {
	readonly id: SessionID;
	readonly plan: PlanRuntime;
	readonly scheduler: SpeculationScheduler<CandidateRecord<Output, StartInput, StateData>>;
	readonly effects: PostSettlementQueue;
	readonly actionContexts: Map<string, PlanActionContext<StartInput, StateData>>;
	readonly launchTimers: Map<string, ReturnType<typeof setTimeout>>;
	readonly sourceSlots: Set<SourceRequestSlot>;
	readonly sourceTasks: Set<Promise<void>>;
	readonly actorCalls: Map<string, ActorAction>;
	readonly anonymousActorCalls: ActorAction[];
	readonly turns: Set<string>;
	readonly actorPhaseIntervals: TimelineInterval[];
	readonly authoritativeToolIntervals: TimelineInterval[];
	readonly authoritativeCandidateIDs: Set<string>;
	actorAdmissionTail: Promise<void>;
	planAdmissionTail: Promise<void>;
	settings: SpeculativeActionSettings;
	taskStartedAt?: number;
	lastActorArrivedAt?: number;
	sequence: number;
	decisionSequence: number;
	tokenTotal: number;
	candidateSequence: number;
	sourceRequestSequence: number;
	pendingSourceRequests: number;
	pendingAdmissions: number;
	disposed: boolean;
}

interface TurnState<SessionID, Output, StartInput, StateData> {
	readonly key: string;
	readonly session: SessionState<SessionID, Output, StartInput, StateData>;
	readonly sessionID: SessionID;
	readonly turnID: string;
	readonly startInput: StartInput;
	readonly startedAt: number;
	readonly data: StateData;
	readonly settings: SpeculativeActionSettings;
	readonly definitions: readonly DrafterToolDefinition[];
	readonly candidateNames: readonly string[];
	readonly generation: SourceGeneration;
	readonly decisionSequence: number;
	readonly actorActions: ActorAction[];
	actorArrivedAt?: number;
	actorPhaseCompletedAt?: number;
	lifecycle: "active" | "closing" | "finished";
}

interface RankedCandidate<Output, StartInput, StateData> {
	readonly candidate: CandidateRecord<Output, StartInput, StateData>;
	readonly match: ActionKeyMatch;
	readonly ready: boolean;
	readonly remainingMs: number;
}

interface ClaimedPrediction {
	readonly node: PlanRuntimeNode;
	readonly opportunity: PredictionOpportunity;
}

type ProjectionResult<Output> =
	| { readonly ok: true; readonly output: Output; readonly durationMs: number }
	| { readonly ok: false; readonly cause: ResolutionCause };

const CACHE_COLD_MAX_AGE_MS = 5 * 60 * 1000;
const CACHE_COLD_MAX_DECISION_BATCHES = 8;

/** Structural runtime: plans own predictions, candidates own execution, ActorAction owns adoption. */
export function makeStructuralSpeculativeActionRuntime<
	SessionID,
	Output,
	StartInput extends TurnInput<SessionID>,
	ConsumeInput extends TurnInput<SessionID>,
	FinishInput extends TurnInput<SessionID>,
	StateData,
>(
	adapter: SpeculativeActionRuntimeAdapter<SessionID, Output, StartInput, ConsumeInput, StateData>,
): SpeculativeActionRuntime<SessionID, Output, StartInput, ConsumeInput, FinishInput> {
	type Source = SpeculativePlanSource<SessionID, Output, StartInput, ConsumeInput, StateData>;
	type Candidate = CandidateRecord<Output, StartInput, StateData>;
	type Session = SessionState<SessionID, Output, StartInput, StateData>;
	type Turn = TurnState<SessionID, Output, StartInput, StateData>;

	const semantics = adapter.actionSemantics ?? PI_ACTION_SEMANTICS;
	const sources = adapter.sources ?? [];
	const sourcesByID = new Map<string, Source>();
	for (const source of sources) {
		if (!source.id || source.id.trim() !== source.id) throw new Error(`invalid speculative plan source ${source.id}`);
		if (sourcesByID.has(source.id)) throw new Error(`duplicate speculative plan source ${source.id}`);
		sourcesByID.set(source.id, source);
	}
	const projectionRules = uniqueProjectionRules(adapter.projectionRules ?? [], semantics);
	const projectors = projectionRules;
	const jobs = new ActionStore<SessionID, Candidate>(projectors, true);
	const results = new ResultCache<SessionID, Candidate>(projectors, candidateCacheValue);
	const branches = new ActionStore<SessionID, Candidate>([], true);
	const sessions = new Map<SessionID, Session>();
	const turns = new Map<string, Turn>();
	let masterEnabled: boolean | undefined;

	const sessionFor = (sessionID: SessionID, settings: SpeculativeActionSettings): Session => {
		const current = sessions.get(sessionID);
		if (current) {
			current.settings = settings;
			return current;
		}
		const created: Session = {
			id: sessionID,
			plan: new PlanRuntime(),
			scheduler: new SpeculationScheduler<Candidate>(),
			effects: new PostSettlementQueue(),
			actionContexts: new Map(),
			launchTimers: new Map(),
			sourceSlots: new Set(),
			sourceTasks: new Set(),
			actorCalls: new Map(),
			anonymousActorCalls: [],
			turns: new Set(),
			actorPhaseIntervals: [],
			authoritativeToolIntervals: [],
			authoritativeCandidateIDs: new Set(),
			actorAdmissionTail: Promise.resolve(),
			planAdmissionTail: Promise.resolve(),
			settings,
			sequence: 0,
			decisionSequence: 0,
			tokenTotal: 0,
			candidateSequence: 0,
			sourceRequestSequence: 0,
			pendingSourceRequests: 0,
			pendingAdmissions: 0,
			disposed: false,
		};
		sessions.set(sessionID, created);
		return created;
	};

	const clearLaunchTimers = (session: Session): void => {
		for (const timer of session.launchTimers.values()) clearTimeout(timer);
		session.launchTimers.clear();
	};

	const candidateNames = (settings: SpeculativeActionSettings): readonly string[] => {
		const resource = new Set(settings.tools.resourceCached);
		const sandbox = new Set(settings.tools.sandbox);
		return semantics
			.toolNames()
			.filter((tool) => (semantics.execution(tool) === "resource_cached" ? resource.has(tool) : sandbox.has(tool)));
	};

	const startTurn = async (input: StartInput, signal?: AbortSignal): Promise<void> => {
		const settings = await adapter.settings();
		if (!settings.enabled || masterEnabled === false) {
			await disableSession(input.sessionID, cause("control", "disabled"));
			return;
		}
		if (signal?.aborted) return;
		const definitions = adapter.definitions(input);
		const names = candidateNames(settings);
		if (!definitions.length || !names.length) return;
		const key = turnKey(input.sessionID, input.turnID);
		const previous = turns.get(key);
		if (previous) await finishState(previous, false);
		const session = sessionFor(input.sessionID, settings);
		const generation = new SourceGeneration(signal);
		const startedAt = performance.now();
		if (session.taskStartedAt === undefined) {
			session.taskStartedAt = startedAt;
			session.actorPhaseIntervals.length = 0;
			session.authoritativeToolIntervals.length = 0;
			session.authoritativeCandidateIDs.clear();
		}
		const state: Turn = {
			key,
			session,
			sessionID: input.sessionID,
			turnID: input.turnID,
			startInput: input,
			startedAt,
			data: await adapter.stateData(input),
			settings,
			definitions,
			candidateNames: names,
			generation,
			decisionSequence: session.decisionSequence + 1,
			actorActions: [],
			lifecycle: "active",
		};
		turns.set(key, state);
		session.turns.add(key);
		await reconcileStores(state);
		try {
			await adapter.onTurnStarted?.({
				startInput: input,
				settings,
				definitions,
				candidateNames: names,
				...(signal ? { signal } : {}),
			});
		} catch {
			// Host analysis does not own runtime state.
		}
		dispatchReady(session);
		setTimeout(() => {
			if (state.lifecycle === "active" && !state.generation.signal.aborted) launchSourceRequests(state);
		}, 0);
	};

	const claimSourceSlot = (
		session: Session,
		source: string,
		targetActionSequence: number,
		limit: number,
		expiresAtTarget = true,
	): SourceRequestSlot | undefined => {
		const used = [...session.sourceSlots].filter(
			(slot) => slot.active && slot.source === source && slot.targetActionSequence === targetActionSequence,
		).length;
		if (used >= limit) return undefined;
		const slot: SourceRequestSlot = {
			source,
			targetActionSequence,
			expiresAtTarget,
			generations: new Set(),
			owners: new Set(),
			pendingAdmissions: 0,
			requestFinished: false,
			active: true,
		};
		session.sourceSlots.add(slot);
		return slot;
	};

	const releaseSourceSlot = (session: Session, slot: SourceRequestSlot, failure: ResolutionCause): void => {
		if (!slot.active) return;
		slot.active = false;
		session.sourceSlots.delete(slot);
		for (const generation of slot.generations) generation.expire(failure);
		slot.generations.clear();
	};

	const releaseUnusedSourceSlot = (session: Session, slot: SourceRequestSlot): void => {
		if (slot.requestFinished && slot.pendingAdmissions === 0 && slot.owners.size === 0) {
			releaseSourceSlot(session, slot, cause("control", "source_slot_unused"));
		}
	};

	const expireSourceHorizon = (session: Session, sequence: number, failure: ResolutionCause): void => {
		for (const slot of [...session.sourceSlots]) {
			if (slot.expiresAtTarget && slot.targetActionSequence <= sequence) releaseSourceSlot(session, slot, failure);
		}
	};

	const releaseAllSourceSlots = (session: Session, failure: ResolutionCause): void => {
		for (const slot of [...session.sourceSlots]) releaseSourceSlot(session, slot, failure);
	};

	const trackSourceTask = (session: Session, task: Promise<void>): void => {
		session.sourceTasks.add(task);
		void task
			.finally(() => session.sourceTasks.delete(task))
			.catch(() => {
				// Request failure is already represented by its source settlement.
			});
	};

	const waitForSourceTasks = async (session: Session): Promise<void> => {
		while (session.sourceTasks.size) await Promise.allSettled([...session.sourceTasks]);
		await session.planAdmissionTail;
	};

	const launchSourceRequests = (state: Turn): void => {
		for (const source of sources) {
			if (!source.enabled(state.settings)) continue;
			const count = requestCount(source.proposalCount?.(state.settings));
			for (let index = 0; index < count; index++) {
				const targetActionSequence = state.session.sequence + 1;
				const slot = claimSourceSlot(
					state.session,
					source.id,
					targetActionSequence,
					count,
					source.requestLifetime === "actor_action",
				);
				if (!slot) break;
				const generation = new SourceGeneration(state.generation.signal);
				slot.generations.add(generation);
				state.session.pendingSourceRequests++;
				const pending = runSourceRequest({
					request: {
						source: source.id,
						turnID: state.turnID,
						index: state.session.sourceRequestSequence++,
						kind: "proposal",
						targetActionSequence,
					},
					generation,
					timeoutMs: source.timeoutMs?.(state.settings),
					produce: (requestSignal) =>
						source.propose({
							startInput: state.startInput,
							data: state.data,
							settings: state.settings,
							definitions: state.definitions,
							candidateNames: state.candidateNames,
							proposalIndex: index,
							proposalCount: count,
							signal: requestSignal,
						}),
					count: (value) => asUpdates(value).length,
				}).then((request) =>
					sourceRequestFinished(
						{
							session: state.session,
							startInput: state.startInput,
							data: state.data,
							settings: state.settings,
							signal: generation.signal,
							slot,
						},
						state.turnID,
						source,
						slot,
						generation,
						request,
					),
				);
				trackSourceTask(state.session, pending);
			}
		}
	};

	const sourceRequestFinished = async (
		scope: PlanAdmissionScope<SessionID, Output, StartInput, StateData>,
		turnID: string,
		source: Source,
		slot: SourceRequestSlot,
		generation: SourceGeneration,
		request: SourceRequestResult<PlanUpdate | readonly PlanUpdate[] | undefined>,
	): Promise<void> => {
		const session = scope.session;
		session.pendingSourceRequests = Math.max(0, session.pendingSourceRequests - 1);
		slot.generations.delete(generation);
		queueSourceRequestEvent(session, turnID, scope.settings, request);
		if (
			request.settlement.status !== "produced" ||
			request.value === undefined ||
			!slot.active ||
			scope.signal.aborted
		) {
			slot.requestFinished = true;
			releaseUnusedSourceSlot(session, slot);
			return;
		}
		session.pendingAdmissions++;
		slot.pendingAdmissions++;
		const admission = session.planAdmissionTail
			.then(async () => {
				if (session.disposed || !slot.active || scope.signal.aborted) return;
				for (const update of asUpdates(request.value)) {
					if (session.disposed || !slot.active || scope.signal.aborted) break;
					await admitUpdate(scope, source, update, request);
				}
			})
			.catch(() => {
				// One malformed proposal cannot poison later independent admissions.
			})
			.finally(() => {
				session.pendingAdmissions = Math.max(0, session.pendingAdmissions - 1);
				slot.pendingAdmissions = Math.max(0, slot.pendingAdmissions - 1);
				slot.requestFinished = true;
				releaseUnusedSourceSlot(session, slot);
			});
		session.planAdmissionTail = admission;
		await admission;
	};

	const admitUpdate = async (
		scope: PlanAdmissionScope<SessionID, Output, StartInput, StateData>,
		source: Source,
		update: PlanUpdate,
		request?: SettledSourceRequest,
	): Promise<void> => {
		const { session } = scope;
		if (session.disposed || scope.signal.aborted) return;
		if (updateSource(update) !== source.id) return;
		const acceptedUpdate = source.multiStepEnabled?.(scope.settings) === false ? immediateOnly(update) : update;
		const applied = session.plan.apply(acceptedUpdate, session.decisionSequence);
		if (!applied.accepted) return;
		for (const retired of applied.retired) retirePlanAction(session, retired, cause("plan", "superseded"));
		const draftTokens = finiteMetric(acceptedUpdate.draftTokens);
		session.tokenTotal += draftTokens;
		for (const action of applied.upserted) {
			const node = session.plan.get(applied.plan.id, action.id);
			if (!node || (node.predictionState && node.predictionState.status !== "pending")) continue;
			const issued = !session.actionContexts.has(node.identity.id);
			if (issued) {
				scope.slot?.owners.add(node.identity.id);
				session.actionContexts.set(node.identity.id, {
					identity: node.identity,
					...(node.prediction ? { opportunity: session.plan.opportunity(node.proposalID, node.action.id) } : {}),
					feedback: action.feedback,
					startInput: scope.startInput,
					data: scope.data,
					settings: scope.settings,
					attemptStartedAt: request?.startedAt ?? performance.now(),
					predictionLatencyMs: request?.durationMs ?? 0,
					draftTokens,
					totalDraftTokens: session.tokenTotal,
					draft: planActionDraft(node),
					admissionSignal: scope.signal,
					...(scope.slot ? { sourceSlot: scope.slot } : {}),
					continuationTriggers: new Set(),
					continuationTail: Promise.resolve(),
				});
				if (node.prediction && source.onIssued) {
					session.effects.enqueue(() =>
						source.onIssued!({
							proposalID: node.identity.proposalID,
							actionID: node.identity.actionID,
							feedback: action.feedback,
						}),
					);
				}
			} else {
				const context = session.actionContexts.get(node.identity.id)!;
				context.feedback = action.feedback;
				context.draft = planActionDraft(node);
			}
			if (action.type === "preparation_hint") {
				void runPreparationHint(session, node);
				continue;
			}
			await materializeAction(session, node);
		}
		dispatchReady(session);
	};

	const materializeAction = async (session: Session, node: PlanRuntimeNode): Promise<void> => {
		if (!node.prediction || node.actionKey || node.execution.status !== "deferred") return;
		const context = session.actionContexts.get(node.identity.id);
		if (!context) return;
		const concrete = asConcreteInput(node.action.input);
		if (!concrete || !context.settings.enabled || !candidateNames(context.settings).includes(node.action.tool)) {
			failUnlaunchable(session, node, cause("admission", concrete ? "tool_disabled" : "invalid_input"));
			return;
		}
		let key: ActionKey | undefined;
		try {
			key = await adapter.actionKey(node.action.tool, concrete, {
				type: "start",
				startInput: context.startInput,
				data: context.data,
			});
		} catch {
			key = undefined;
		}
		if (!key) {
			failUnlaunchable(session, node, cause("matching", "action_not_keyable"));
			return;
		}
		key = coveringAction(key, projectionRules);
		const executionInput = asConcreteInput(key.input);
		if (!executionInput) {
			failUnlaunchable(session, node, cause("matching", "action_not_keyable"));
			return;
		}
		const callID = `spec_${session.candidateSequence + 1}`;
		let preflight: CandidatePreflight;
		try {
			preflight = await adapter.preflightCandidate({
				startInput: context.startInput,
				data: context.data,
				settings: context.settings,
				candidate: context.draft,
				tool: node.action.tool,
				concrete: executionInput,
				action: key,
				callID,
				index: session.candidateSequence,
				signal: context.admissionSignal,
			});
		} catch (error) {
			preflight = { ok: false, reason: "preflight_failed", detail: errorDetail(error) };
		}
		if (!preflight.ok) {
			failUnlaunchable(session, node, cause("admission", preflight.reason, preflight.detail));
			return;
		}
		if (context.admissionSignal.aborted) {
			failUnlaunchable(session, node, cause("source", "generation_expired"));
			return;
		}
		session.plan.bindActionKey(node.proposalID, node.action.id, key);
	};

	const releaseActionContext = (session: Session, id: string, keepContinuation = false): void => {
		const context = session.actionContexts.get(id);
		if (!context) return;
		session.actionContexts.delete(id);
		if (context.sourceSlot) {
			context.sourceSlot.owners.delete(id);
			releaseUnusedSourceSlot(session, context.sourceSlot);
		}
		if (!keepContinuation && context.continuationSlot) {
			releaseSourceSlot(session, context.continuationSlot, cause("control", "parent_prediction_not_adopted"));
		}
	};

	const runPreparationHint = async (session: Session, node: PlanRuntimeNode): Promise<void> => {
		if (node.action.type !== "preparation_hint") return;
		const promoted = session.plan.promote(node.proposalID, node.action.id);
		if (promoted.status !== "scheduled") return;
		const context = session.actionContexts.get(node.identity.id);
		const work = new CandidateExecution<void>("shared");
		const workID = `hint:${node.identity.id}`;
		session.plan.attachExecution(node.proposalID, node.action.id, workID, work);
		const startedAt = performance.now();
		work.start(startedAt);
		if (!context || !adapter.prepareCandidate) {
			work.succeed(undefined, performance.now(), 0);
			releaseActionContext(session, node.identity.id);
			dispatchReady(session);
			return;
		}
		try {
			await adapter.prepareCandidate({
				startInput: context.startInput,
				data: context.data,
				settings: context.settings,
				candidate: context.draft,
				signal: context.admissionSignal,
			});
			const completedAt = performance.now();
			work.succeed(undefined, completedAt, completedAt - startedAt);
		} catch (error) {
			const failure = cause("execution", "preparation_failed", errorDetail(error));
			const completedAt = performance.now();
			work.fail(failure, completedAt, completedAt - startedAt);
		} finally {
			releaseActionContext(session, node.identity.id);
			dispatchReady(session);
		}
	};

	const failUnlaunchable = (session: Session, node: PlanRuntimeNode, failure: ResolutionCause): void => {
		const work = new CandidateExecution<never>("shared");
		work.fail(failure, performance.now(), 0);
		session.plan.attachExecution(node.proposalID, node.action.id, `rejected:${node.identity.id}`, work);
		settleUnobserved(session, node, failure);
	};

	const settleBlockedPlanActions = (session: Session): void => {
		for (const node of session.plan.drainBlocked()) {
			const failure = cause("plan", "dependency_impossible");
			if (node.execution.status === "deferred" || node.execution.status === "scheduled") {
				const work = new CandidateExecution<never>("shared");
				work.fail(failure, performance.now(), 0);
				session.plan.attachExecution(node.proposalID, node.action.id, `blocked:${node.identity.id}`, work);
			}
			if (node.prediction) settleUnobserved(session, node, failure);
			else releaseActionContext(session, node.identity.id);
		}
	};

	const dispatchReady = (session: Session, immediatePredictionID?: string): void => {
		if (session.disposed) return;
		settleBlockedPlanActions(session);
		for (const node of session.plan.launchable()) {
			if (!node.prediction || !node.actionKey || node.action.type !== "tool_call") continue;
			const existingTimer = session.launchTimers.get(node.prediction.id);
			if (
				existingTimer &&
				node.expectedDecisionSeq > session.decisionSequence + 1 &&
				node.prediction.id !== immediatePredictionID
			) {
				continue;
			}
			if (existingTimer) clearTimeout(existingTimer);
			session.launchTimers.delete(node.prediction.id);
			const context = session.actionContexts.get(node.identity.id);
			const forecast = forecastFor(node, semantics, session.decisionSequence, context?.predictionLatencyMs);
			const delay = node.prediction.id === immediatePredictionID ? 0 : session.scheduler.launchDelay(forecast);
			if (delay <= 0) {
				const promoted = session.plan.promote(node.proposalID, node.action.id);
				if (promoted.status === "scheduled") void launchNode(session, promoted.node);
				continue;
			}
			const timer = setTimeout(() => {
				session.launchTimers.delete(node.prediction.id);
				const promoted = session.plan.promote(node.proposalID, node.action.id);
				if (promoted.status === "scheduled") void launchNode(session, promoted.node);
			}, delay);
			session.launchTimers.set(node.prediction.id, timer);
		}
		startQueuedCandidates(session);
	};

	const launchNode = async (session: Session, node: PlanRuntimeNode): Promise<void> => {
		if (!node.prediction || !node.actionKey || node.predictionState.status === "settled") {
			session.plan.defer(node.proposalID, node.action.id);
			return;
		}
		const context = session.actionContexts.get(node.identity.id);
		if (!context) {
			failUnlaunchable(session, node, cause("plan", "context_missing"));
			return;
		}
		const reusable = await reusableForPrediction(session, node.actionKey);
		if (reusable) {
			attachNode(session, node, reusable);
			return;
		}
		const concrete = asConcreteInput(node.action.input);
		if (!concrete) {
			failUnlaunchable(session, node, cause("admission", "invalid_input"));
			return;
		}
		const sequence = ++session.candidateSequence;
		const candidateID = `spec_${sequence}_${node.actionKey.hash.slice(0, 12)}`;
		const reuse = semantics.reuse(node.action.tool) === "exclusive_branch" ? "exclusive" : "shared";
		const work = new CandidateExecution<Output>(reuse);
		const scheduled = session.scheduler.evaluate([
			forecastFor(node, semantics, session.decisionSequence, context.predictionLatencyMs),
		]);
		const candidate: Candidate = {
			id: candidateID,
			key: node.actionKey,
			work,
			owner: {
				startInput: context.startInput,
				data: context.data,
				settings: context.settings,
				draft: context.draft,
				index: sequence - 1,
			},
			createdAt: Date.now(),
			attemptStartedAt: context.attemptStartedAt,
			predictionLatencyMs: context.predictionLatencyMs,
			draftTokens: context.draftTokens,
			totalDraftTokens: context.totalDraftTokens,
			expectedDurationMs: scheduled.expectedDurationMs,
			expectedDecisionSeq: node.expectedDecisionSeq,
			criticalPathMs: scheduled.criticalPathMs,
			priorityMs: scheduled.priorityMs,
			estimatedBytes: 0,
			resources: new CandidateResources(),
			projectionCoverage: [],
			validationMs: 0,
			validationBytes: 0,
			validationFiles: 0,
			projectionMs: 0,
		};
		const insertion = jobs.insertOrGetCompatible(
			session.id,
			candidate,
			(existing, match) => canShareInFlight(existing, node.actionKey!, match, projectionRules),
			(existing) => activeExecution(existing),
		);
		if (!insertion.inserted) {
			attachNode(session, node, insertion.entry);
			return;
		}
		session.plan.attachExecution(node.proposalID, node.action.id, candidate.id, candidate.work);
		startQueuedCandidates(session);
	};

	const attachNode = (session: Session, node: PlanRuntimeNode, candidate: Candidate): void => {
		if (!session.plan.attachExecution(node.proposalID, node.action.id, candidate.id, candidate.work)) return;
		const scheduled = session.scheduler.evaluate(forecastsForCandidate(session, candidate, node));
		candidate.expectedDurationMs = Math.max(candidate.expectedDurationMs, scheduled.expectedDurationMs);
		candidate.expectedDecisionSeq = Math.min(candidate.expectedDecisionSeq, node.expectedDecisionSeq);
		candidate.criticalPathMs = Math.max(candidate.criticalPathMs, scheduled.criticalPathMs);
		candidate.priorityMs = Math.max(candidate.priorityMs, scheduled.priorityMs);
		const execution = candidate.work.execution;
		if (execution.status === "succeeded") {
			queueContinuation(session, node, candidate, execution.output, "execution_succeeded");
			return;
		}
		if (execution.status === "queued" || execution.status === "running") {
			session.scheduler.refresh(candidate, forecastsForCandidate(session, candidate, node));
		}
		if (execution.status === "queued") startQueuedCandidates(session);
	};

	const startQueuedCandidates = (session: Session, preferred?: Candidate, authoritative = false): void => {
		const queued = jobs
			.values(session.id)
			.filter((candidate) => candidate.work.execution.status === "queued")
			.sort(
				(left, right) =>
					Number(right === preferred) - Number(left === preferred) ||
					Number(!reservationAvailable(right.work.reservation)) -
						Number(!reservationAvailable(left.work.reservation)) ||
					left.expectedDecisionSeq - right.expectedDecisionSeq ||
					right.priorityMs - left.priorityMs ||
					right.criticalPathMs - left.criticalPathMs ||
					right.expectedDurationMs - left.expectedDurationMs ||
					left.createdAt - right.createdAt,
			);
		for (const candidate of queued) {
			const admission = session.scheduler.admit(
				candidate,
				forecastsForCandidate(session, candidate),
				concurrentLimit(session.settings),
			);
			if (!admission.admitted && !(authoritative && candidate === preferred)) continue;
			const startedAt = performance.now();
			if (!candidate.work.start(startedAt)) continue;
			queueCandidateEvent(session, candidate);
			void executeCandidate(session, candidate, startedAt);
		}
	};

	const executeCandidate = async (session: Session, candidate: Candidate, startedAt: number): Promise<void> => {
		try {
			if (adapter.prepareCandidate) {
				await adapter.prepareCandidate({
					startInput: candidate.owner.startInput,
					data: candidate.owner.data,
					settings: candidate.owner.settings,
					candidate: candidate.owner.draft,
					action: candidate.key,
					signal: candidate.work.controller.signal,
				});
			}
			if (semantics.requiresRuntimeResourceVersion(candidate.key.tool) && adapter.captureResourceVersion) {
				const version = await adapter.captureResourceVersion({
					startInput: candidate.owner.startInput,
					data: candidate.owner.data,
					settings: candidate.owner.settings,
					candidate: candidate.owner.draft,
					tool: candidate.key.tool,
					concrete: candidate.key.input as Record<string, unknown>,
					action: candidate.key,
					callID: candidate.id,
					index: candidate.owner.index,
				});
				candidate.resources.setVersion(version, adapter.releaseResourceVersion);
			}
			const parentWorld = parentWorldFor(session, candidate);
			const executed = await adapter.executeCandidate({
				startInput: candidate.owner.startInput,
				data: candidate.owner.data,
				candidate: candidate.owner.draft,
				tool: candidate.key.tool,
				concrete: candidate.key.input as Record<string, unknown>,
				action: candidate.key,
				callID: candidate.id,
				index: candidate.owner.index,
				signal: candidate.work.controller.signal,
				...(parentWorld ? { parentWorld } : {}),
			});
			const branch = asWorldBranch(executed);
			const output = branch?.output ?? (executed as Output);
			candidate.world = branch;
			const rejected = adapter.rejectCandidateOutput?.({
				output,
				candidate: publicCandidate(candidate),
			});
			if (rejected) throw new CandidateFailure(cause("execution", "output_rejected", rejected));
			candidate.projectionCoverage = captureCoverage(candidate.key, output, projectionRules);
			candidate.estimatedBytes = estimateValueBytes(output) + (branch?.capturedBytes ?? 0);
			const completedAt = performance.now();
			if (!candidate.work.succeed(output, completedAt, completedAt - startedAt)) return;
			session.scheduler.observeService(candidate.key.tool, completedAt - startedAt);
			session.scheduler.complete(candidate);
			jobs.delete(session.id, candidate);
			if (candidate.work.reservation.kind === "shared") results.insert(session.id, candidate);
			else branches.insert(session.id, candidate);
			installWatcher(session, candidate);
			for (const node of nodesForCandidate(session, candidate.id)) {
				const current = session.plan.get(node.proposalID, node.action.id);
				if (current?.predictionState?.status === "pending")
					queueContinuation(session, current, candidate, output, "execution_succeeded");
			}
			trimResults(session, candidate.owner.settings);
			queueCandidateEvent(session, candidate);
			dispatchReady(session);
		} catch (error) {
			const failure =
				error instanceof CandidateFailure
					? error.failure
					: candidate.work.controller.signal.aborted
						? cause("control", "execution_aborted")
						: cause("execution", "candidate_failed", errorDetail(error));
			const completedAt = performance.now();
			const settled = candidate.work.controller.signal.aborted
				? candidate.work.cancel(failure, completedAt, completedAt - startedAt)
				: candidate.work.fail(failure, completedAt, completedAt - startedAt);
			session.scheduler.complete(candidate);
			removeCandidate(session, candidate);
			if (settled) queueCandidateEvent(session, candidate);
			dispatchReady(session);
		}
	};

	const consume = async (input: ConsumeInput, signal?: AbortSignal): Promise<Output | undefined> => {
		const actorArrivedAt = performance.now();
		const state = turns.get(turnKey(input.sessionID, input.turnID));
		if (!state || state.lifecycle !== "active" || signal?.aborted || masterEnabled === false) return undefined;
		expireSourceHorizon(state.session, state.session.sequence + 1, cause("control", "actor_action_arrived"));
		closeActorPhase(state, actorArrivedAt);
		if (state.actorArrivedAt === undefined) {
			state.actorArrivedAt = actorArrivedAt;
			observeActorDecisionInterval(state.session, actorArrivedAt);
		}
		const candidatesAtArrival = allCandidates(state.sessionID);
		const sequence = ++state.session.sequence;
		clearLaunchTimers(state.session);
		const actualCall = adapter.actual(input) as ActualToolCall;
		const identity: ActorActionIdentity = {
			id: actualCall.id ?? JSON.stringify([input.turnID, sequence]),
			sequence,
			decisionSequence: state.decisionSequence,
			turnID: input.turnID,
		};
		const admission = enterActorAdmission(state.session);
		let actualKey: ActionKey | undefined;
		try {
			actualKey = await adapter.actionKey(actualCall.tool, actualCall.input, {
				type: "consume",
				consumeInput: input,
			});
		} catch {
			actualKey = undefined;
		}
		const actorAction = new ActorAction({
			identity,
			tool: actualCall.tool,
			...(actualKey ? { actionKey: actualKey } : {}),
		});
		registerActorAction(state.session, actualCall.id, actorAction);
		state.actorActions.push(actorAction);

		await admission.ready;
		try {
			if (!actualKey) {
				actorAction.deferToFallback();
				preemptForActor(state.session, { class: "global", units: 1 }, state.settings);
				return undefined;
			}

			const matchingPredictions: ClaimedPrediction[] = predictionMatches(
				state.session,
				actualKey,
				state.decisionSequence,
			).flatMap(({ node, relation }) => {
				const opportunity = state.session.plan.claimMatch(node.proposalID, node.action.id, identity, relation);
				if (!opportunity) return [];
				return [{ node, opportunity }];
			});
			await Promise.all(matchingPredictions.map(({ node }) => promoteForActor(state.session, node)));
			const candidates = uniqueCandidates([...candidatesAtArrival, ...allCandidates(state.sessionID)]);
			const ranked = rankCandidates(actualKey, candidates);
			let selected:
				| {
						readonly candidate: Candidate;
						readonly match: ActionKeyMatch;
						readonly output: Output;
						readonly timing: { executionAheadMs: number; attemptLeadMs: number; hitLatencyMs: number };
						readonly toolExecution: TimelineInterval;
				  }
				| undefined;
			let rejection: ResolutionCause = cause("matching", ranked.length ? "candidate_unavailable" : "no_candidate");
			let rejectedCandidateID: string | undefined;
			const stopCandidate = (candidate: Candidate, reservationOwner: string): boolean => {
				const failure = signal?.aborted
					? cause("control", "actor_aborted")
					: masterEnabled === false || state.lifecycle !== "active" || turns.get(state.key) !== state
						? cause("control", "disabled")
						: undefined;
				if (!failure) return false;
				candidate.work.release(reservationOwner);
				rejection = failure;
				rejectedCandidateID = candidate.id;
				return true;
			};

			for (const choice of ranked) {
				const candidate = choice.candidate;
				const reservationOwner = identity.id;
				if (!candidate.work.reserve(reservationOwner)) {
					const failure = cause("matching", "candidate_reserved");
					actorAction.reject(candidate.id, choice.match, failure);
					rejection = failure;
					rejectedCandidateID = candidate.id;
					continue;
				}
				if (candidate.work.execution.status === "queued") {
					preemptForActor(
						state.session,
						resourceProfile(candidate.key.execution, semantics.sandboxMode(candidate.key.tool)),
						state.settings,
						candidate,
					);
					startQueuedCandidates(state.session, candidate, true);
				}
				admission.release();
				const authorization = await authorize(state, input, actualKey, actualCall, candidate, signal);
				if (stopCandidate(candidate, reservationOwner)) break;
				if (authorization) {
					candidate.work.release(reservationOwner);
					actorAction.reject(candidate.id, choice.match, authorization);
					rejection = authorization;
					rejectedCandidateID = candidate.id;
					continue;
				}
				const wasRunning =
					candidate.work.execution.status === "queued" || candidate.work.execution.status === "running";
				if (!wasRunning) {
					const before = await validateCandidate(state, input, actualKey, candidate);
					if (stopCandidate(candidate, reservationOwner)) break;
					if (before.status !== "valid") {
						candidate.work.release(reservationOwner);
						actorAction.reject(candidate.id, choice.match, before.cause);
						rejection = before.cause;
						rejectedCandidateID = candidate.id;
						if (before.status === "stale") discardCandidate(state.session, candidate, before.cause);
						continue;
					}
				}
				const execution = await waitForCandidate(candidate.work.completion, signal);
				if (stopCandidate(candidate, reservationOwner)) break;
				if (!execution) {
					candidate.work.release(reservationOwner);
					rejection = cause("control", "actor_aborted");
					break;
				}
				if (execution.status !== "succeeded") {
					candidate.work.release(reservationOwner);
					actorAction.reject(candidate.id, choice.match, execution.cause);
					rejection = execution.cause;
					rejectedCandidateID = candidate.id;
					continue;
				}
				if (wasRunning) {
					const after = await validateCandidate(state, input, actualKey, candidate);
					if (stopCandidate(candidate, reservationOwner)) break;
					if (after.status !== "valid") {
						candidate.work.release(reservationOwner);
						actorAction.reject(candidate.id, choice.match, after.cause);
						rejection = after.cause;
						rejectedCandidateID = candidate.id;
						if (after.status === "stale") discardCandidate(state.session, candidate, after.cause);
						continue;
					}
				}
				if (candidate.world) {
					const compatibility = state.session.scheduler.assessCompatibility(
						candidate.world.compatibility,
						actualKey.executionFingerprint,
					);
					if (!compatibility.compatible) {
						const failure = cause("compatibility", compatibility.code, compatibility.detail);
						candidate.work.release(reservationOwner);
						actorAction.reject(candidate.id, choice.match, failure);
						rejection = failure;
						rejectedCandidateID = candidate.id;
						discardCandidate(state.session, candidate, failure);
						continue;
					}
				}

				// Projection is pure and must succeed before the irreversible world commit.
				const projection = await projectOutput(
					candidate,
					actualKey,
					execution.output,
					choice.match,
					projectionRules,
				);
				if (stopCandidate(candidate, reservationOwner)) break;
				if (!projection.ok) {
					candidate.work.release(reservationOwner);
					actorAction.reject(candidate.id, choice.match, projection.cause);
					rejection = projection.cause;
					rejectedCandidateID = candidate.id;
					continue;
				}
				candidate.projectionMs += projection.durationMs;
				let output = projection.output;
				if (candidate.world) {
					try {
						const committed = await candidate.world.commit();
						if (choice.match.kind === "exact") output = committed;
					} catch (error) {
						const failure = cause("commit", "world_commit_failed", errorDetail(error));
						candidate.work.release(reservationOwner);
						actorAction.reject(candidate.id, choice.match, failure);
						rejection = failure;
						rejectedCandidateID = candidate.id;
						discardCandidate(state.session, candidate, failure);
						continue;
					}
				}

				const executionAheadMs = Math.min(execution.executionMs, Math.max(0, actorArrivedAt - execution.startedAt));
				const timing = {
					executionAheadMs,
					attemptLeadMs: Math.max(0, actorArrivedAt - candidate.attemptStartedAt),
					hitLatencyMs: Math.max(0, performance.now() - actorArrivedAt),
				};
				if (candidate.work.reservation.kind === "exclusive") {
					candidate.work.consume(reservationOwner);
					removeCandidate(state.session, candidate);
				} else {
					candidate.work.release(reservationOwner);
					results.recordActorHit(state.sessionID, candidate, cacheLimits(state.settings));
				}
				selected = {
					candidate,
					match: choice.match,
					output,
					timing,
					toolExecution: { startedAt: execution.startedAt, completedAt: execution.completedAt },
				};
				break;
			}

			if (selected) {
				actorAction.adopt(
					selected.candidate.id,
					selected.match,
					selected.timing,
					selected.toolExecution,
					matchingPredictions.map(({ opportunity }) => opportunity.identity),
				);
				forgetActorAction(state.session, actualCall.id, actorAction);
				const adoption: PredictionAdoption = {
					status: "adopted",
					candidateID: selected.candidate.id,
				};
				for (const { node } of matchingPredictions) {
					queueContinuation(state.session, node, selected.candidate, selected.output, "actor_adopted");
				}
				confirmPredictions(state.session, matchingPredictions, identity, adoption);
				invalidateChangedResources(state.session, actualKey, selected.candidate);
				queueActorSettlement(state, input, actualCall, actorAction, selected.output, selected.candidate);
				state.session.effects.enqueue(() => dispatchReady(state.session));
				return selected.output;
			}

			actorAction.deferToFallback(matchingPredictions.map(({ opportunity }) => opportunity.identity));
			const adoption: PredictionAdoption = {
				status: "rejected",
				...(rejectedCandidateID ? { candidateID: rejectedCandidateID } : {}),
				cause: rejection,
			};
			confirmPredictions(state.session, matchingPredictions, identity, adoption);
			preemptForActor(
				state.session,
				resourceProfile(actualKey.execution, semantics.sandboxMode(actualKey.tool)),
				state.settings,
			);
			state.session.effects.enqueue(() => dispatchReady(state.session));
			return undefined;
		} finally {
			admission.release();
		}
	};

	const actual = async (
		input: ConsumeInput & { readonly durationMs: number; readonly output?: Output },
	): Promise<void> => {
		const state = turns.get(turnKey(input.sessionID, input.turnID));
		if (!state) return;
		const actualCall = adapter.actual(input) as ActualToolCall;
		const actorAction = takeActorAction(state.session, input.turnID, actualCall);
		if (!actorAction) return;
		const durationMs = finiteMetric(input.durationMs);
		if (!actorAction.settleActor(durationMs, outputIsError(input.output), performance.now())) return;
		state.session.scheduler.observeService(actorAction.tool, durationMs);
		const key = actorAction.actionKey;
		if (key) invalidateChangedResources(state.session, key);
		queueActorSettlement(state, input, actualCall, actorAction, input.output);
	};

	const queueActorSettlement = (
		state: Turn,
		input: ConsumeInput,
		actualCall: ActualToolCall,
		actorAction: ActorAction,
		output: Output | undefined,
		candidate?: Candidate,
	): void => {
		const settlement = actorAction.settlement;
		if (!settlement) return;
		if (
			settlement.provider.kind === "actor" ||
			!state.session.authoritativeCandidateIDs.has(settlement.provider.candidateID)
		) {
			state.session.authoritativeToolIntervals.push(settlement.provider.toolExecution);
			if (settlement.provider.kind === "speculative") {
				state.session.authoritativeCandidateIDs.add(settlement.provider.candidateID);
			}
		}
		const key = actorAction.actionKey;
		const settledCandidate =
			candidate ??
			(settlement.provider.kind === "speculative"
				? candidateByID(state.sessionID, settlement.provider.candidateID)
				: undefined);
		const event: SpeculativeActionEvent<SessionID> = {
			type: "actor_action",
			sessionID: state.sessionID,
			turnID: state.turnID,
			timestamp: Date.now(),
			cache: cacheSnapshot(state.session, state.settings),
			settlement,
			actualAction: diagnosticAction(actorAction.tool, actualCall.input, key),
			...(key ? { execution: key.execution } : {}),
			...(settledCandidate ? { candidate: candidateEventDescriptor(settledCandidate) } : {}),
		};
		state.session.effects.enqueue(async () => {
			await emit(event);
			const concrete = asConcreteInput(actualCall.input) ?? {};
			for (const source of sources) {
				if (!source.observe || !source.enabled(state.settings)) continue;
				try {
					const updates = await source.observe({
						startInput: state.startInput,
						data: state.data,
						settings: state.settings,
						consumeInput: input,
						...(key ? { action: key } : {}),
						tool: actorAction.tool,
						concrete,
						...(output !== undefined ? { output } : {}),
						durationMs:
							settlement.provider.kind === "actor"
								? settlement.provider.durationMs
								: settledCandidate
									? executionDuration(settledCandidate)
									: candidateExecutionDuration(state.session, settlement.provider.candidateID),
						order: settlement.actorAction.sequence,
					});
					for (const update of asUpdates(updates)) {
						if (state.lifecycle === "active") {
							await admitUpdate(
								{
									session: state.session,
									startInput: state.startInput,
									data: state.data,
									settings: state.settings,
									signal: state.generation.signal,
								},
								source,
								update,
							);
						}
					}
				} catch {
					// Learning and continuation never alter an authoritative Actor result.
				}
			}
		});
	};

	const confirmPredictions = (
		session: Session,
		matches: readonly ClaimedPrediction[],
		actorAction: ActorActionIdentity,
		adoption: PredictionAdoption,
	): void => {
		for (const { node, opportunity } of matches) {
			const settlement = session.plan.confirm(opportunity, actorAction, adoption);
			if (settlement) predictionSettled(session, node, settlement);
		}
	};

	const advancePredictionFrontier = (state: Turn): void => {
		if (!state.actorActions.length || state.decisionSequence <= state.session.decisionSequence) return;
		state.session.decisionSequence = state.decisionSequence;
		const observation = state.actorActions.find((action) => action.actionKey);
		for (const node of state.session.plan.due(state.decisionSequence)) {
			if (node.predictionState.status !== "pending") continue;
			if (!observation) {
				settleUnobserved(state.session, node, cause("matching", "actor_action_not_keyable"));
				continue;
			}
			const settlement = state.session.plan.miss(node.proposalID, node.action.id, observation.identity);
			if (settlement) predictionSettled(state.session, node, settlement);
		}
		dispatchReady(state.session);
	};

	const predictionSettled = (session: Session, node: PlanRuntimeNode, settlement: PredictionSettlement): void => {
		if (!node.prediction) return;
		const context = session.actionContexts.get(node.identity.id);
		if (!context) return;
		const source = sourcesByID.get(context.identity.source);
		const event: SpeculativeActionEvent<SessionID> = {
			type: "prediction",
			sessionID: session.id,
			turnID: context.startInput.turnID,
			timestamp: Date.now(),
			cache: cacheSnapshot(session, context.settings),
			settlement,
		};
		session.effects.enqueue(async () => {
			await emit(event);
			try {
				if (source?.onSettled) {
					await source.onSettled({
						proposalID: context.identity.proposalID,
						actionID: context.identity.actionID,
						feedback: context.feedback,
						settlement,
					});
				}
			} catch {
				// Source feedback is a projection of settlement, never its owner.
			}
		});
		const adopted =
			settlement.observation === "observed" &&
			settlement.match.matched &&
			settlement.match.adoption.status === "adopted";
		releaseActionContext(session, node.identity.id, adopted);
		if ("candidateID" in node.execution && node.execution.candidateID) {
			const candidate = candidateByID(session.id, node.execution.candidateID);
			if (
				candidate?.work.reservation.kind === "exclusive" &&
				!nodesForCandidate(session, candidate.id).some(
					(item) => item.predictionState && item.predictionState.status !== "settled",
				)
			) {
				discardCandidate(session, candidate, cause("retention", "prediction_horizon_settled"));
			}
		}
	};

	const settleUnobserved = (session: Session, node: PlanRuntimeNode, failure: ResolutionCause): void => {
		const settlement = session.plan.unobserve(node.proposalID, node.action.id, failure);
		if (settlement) predictionSettled(session, node, settlement);
	};

	const queueContinuation = (
		session: Session,
		node: PlanRuntimeNode,
		candidate: Candidate,
		output: Output,
		trigger: "execution_succeeded" | "actor_adopted",
	): void => {
		if (!node.prediction) return;
		if (session.plan.get(node.proposalID, node.action.id)?.identity.id !== node.identity.id) return;
		const context = session.actionContexts.get(node.identity.id);
		const source = context ? sourcesByID.get(context.identity.source) : undefined;
		if (!context || !source?.continue) return;
		if (source.multiStepEnabled?.(context.settings) === false) return;
		if (source.continueOn && !source.continueOn.includes(trigger)) return;
		if (context.continuationTriggers.has(trigger)) return;
		context.continuationTriggers.add(trigger);
		const targetActionSequence = Math.max(
			session.sequence + 1,
			(context.sourceSlot?.targetActionSequence ?? session.sequence) + 1,
		);
		let slot = context.continuationSlot;
		if (!slot?.active) {
			slot = claimSourceSlot(
				session,
				source.id,
				targetActionSequence,
				requestCount(source.proposalCount?.(context.settings)),
			);
			if (!slot) return;
			context.continuationSlot = slot;
		}
		const continuationSlot = slot;
		const pending = context.continuationTail
			.then(async () => {
				if (session.disposed || !continuationSlot.active) return;
				const revision = session.plan.reserveRevision(node.proposalID);
				if (revision === undefined) return;
				const generation = new SourceGeneration();
				continuationSlot.generations.add(generation);
				continuationSlot.requestFinished = false;
				session.pendingSourceRequests++;
				const request = await runSourceRequest({
					request: {
						source: source.id,
						turnID: context.startInput.turnID,
						index: session.sourceRequestSequence++,
						kind: "continuation",
						targetActionSequence: continuationSlot.targetActionSequence,
					},
					generation,
					timeoutMs: source.timeoutMs?.(context.settings),
					produce: (requestSignal) =>
						source.continue!({
							startInput: context.startInput,
							data: context.data,
							settings: context.settings,
							candidate: predictionCandidate(candidate, node),
							proposalID: node.proposalID,
							actionID: node.action.id,
							revision,
							feedback: context.feedback,
							output,
							trigger,
							signal: requestSignal,
						}),
					count: (value) => asUpdates(value).length,
				});
				await sourceRequestFinished(
					{
						session,
						startInput: context.startInput,
						data: context.data,
						settings: context.settings,
						signal: generation.signal,
						slot: continuationSlot,
					},
					context.startInput.turnID,
					source,
					continuationSlot,
					generation,
					request,
				);
			})
			.catch(() => {
				// Continuation failure cannot revoke completed work or Actor adoption.
			});
		context.continuationTail = pending;
		trackSourceTask(session, pending);
	};

	const retirePlanAction = (session: Session, retired: RetiredPlanNode, failure: ResolutionCause): void => {
		const timer = session.launchTimers.get(retired.node.identity.id);
		if (timer) clearTimeout(timer);
		session.launchTimers.delete(retired.node.identity.id);
		if (retired.opportunity?.state.status === "matching") return;
		const finalized = retired.opportunity?.unobserve(failure);
		if (finalized) predictionSettled(session, retired.node, finalized);
		else releaseActionContext(session, retired.node.identity.id);
	};

	const reusableForPrediction = async (session: Session, key: ActionKey): Promise<Candidate | undefined> => {
		for (const lookup of [
			...jobs.lookup(session.id, key),
			...results.lookup(session.id, key),
			...branches.lookup(session.id, key),
		]) {
			const candidate = lookup.entry;
			if (!activeExecution(candidate)) continue;
			if (lookup.match.kind === "projected" && candidate.work.execution.status !== "succeeded") {
				if (!canShareInFlight(candidate, key, lookup.match, projectionRules)) continue;
			}
			if (candidate.work.execution.status === "succeeded") {
				const validation = await validateCandidateWithoutTurn(key, candidate);
				if (validation.status === "stale") {
					discardCandidate(session, candidate, validation.cause);
					continue;
				}
				if (validation.status === "indeterminate") continue;
			}
			return candidate;
		}
		return undefined;
	};

	const nodesForCandidate = (session: Session, candidateID: string): readonly PlanRuntimeNode[] =>
		session.plan
			.values()
			.filter((node) => "candidateID" in node.execution && node.execution.candidateID === candidateID);

	const forecastsForCandidate = (
		session: Session,
		candidate: Candidate,
		additional?: PlanRuntimeNode,
	): readonly PredictionForecast[] => {
		const nodes = nodesForCandidate(session, candidate.id);
		const unique =
			additional?.prediction && !nodes.some((node) => node.prediction?.id === additional.prediction.id)
				? [...nodes, additional]
				: nodes;
		return unique.map((node) =>
			forecastFor(
				node,
				semantics,
				session.decisionSequence,
				session.actionContexts.get(node.identity.id)?.predictionLatencyMs,
			),
		);
	};

	const parentWorldFor = (session: Session, candidate: Candidate): WorldBranch<Output> | undefined => {
		const nodes = nodesForCandidate(session, candidate.id);
		for (const node of nodes) {
			for (const dependency of node.action.dependsOn ?? []) {
				const parent = session.plan.get(node.proposalID, dependency.actionID);
				if (!parent || !("candidateID" in parent.execution) || !parent.execution.candidateID) continue;
				const parentCandidate = candidateByID(session.id, parent.execution.candidateID);
				if (parentCandidate?.world) {
					return parentCandidate.world;
				}
			}
		}
		return undefined;
	};

	const installWatcher = (session: Session, candidate: Candidate): void => {
		if (!adapter.watchResourceVersion || !semantics.watchesResourceVersion(candidate.key.tool)) return;
		void Promise.resolve(
			adapter.watchResourceVersion({
				stateData: candidate.owner.data,
				action: candidate.key,
				candidate: publicCandidate(candidate),
				onInvalidated: (changedPath) => {
					discardCandidate(session, candidate, cause("freshness", "resource_changed", changedPath));
				},
			}),
		).then(
			(stop) => candidate.resources.setWatcher(stop),
			() => undefined,
		);
	};

	const validateCandidate = async (
		state: Turn,
		input: ConsumeInput,
		action: ActionKey,
		candidate: Candidate,
	): Promise<ResourceValidation> => {
		if (!adapter.validateResourceVersion || !semantics.requiresRuntimeResourceVersion(candidate.key.tool)) {
			return { status: "valid", metrics: zeroValidationMetrics() };
		}
		try {
			const validation = await adapter.validateResourceVersion({
				stateData: state.data,
				consumeInput: input,
				action,
				candidate: publicCandidate(candidate),
			});
			recordValidation(candidate, validation);
			return validation;
		} catch (error) {
			return {
				status: "indeterminate",
				cause: cause("freshness", "validation_failed", errorDetail(error)),
				metrics: zeroValidationMetrics(),
			};
		}
	};

	const validateCandidateWithoutTurn = async (
		action: ActionKey,
		candidate: Candidate,
	): Promise<ResourceValidation> => {
		if (!adapter.validateResourceVersion || !semantics.requiresRuntimeResourceVersion(candidate.key.tool)) {
			return { status: "valid", metrics: zeroValidationMetrics() };
		}
		try {
			const validation = await adapter.validateResourceVersion({
				stateData: candidate.owner.data,
				action,
				candidate: publicCandidate(candidate),
			});
			recordValidation(candidate, validation);
			return validation;
		} catch (error) {
			return {
				status: "indeterminate",
				cause: cause("freshness", "validation_failed", errorDetail(error)),
				metrics: zeroValidationMetrics(),
			};
		}
	};

	const authorize = async (
		state: Turn,
		input: ConsumeInput,
		action: ActionKey,
		actualCall: ActualToolCall,
		candidate: Candidate,
		signal?: AbortSignal,
	): Promise<ResolutionCause | undefined> => {
		if (!adapter.authorizeCandidate) return undefined;
		const concrete = asConcreteInput(actualCall.input);
		if (!concrete) return cause("authorization", "invalid_input");
		try {
			const result = await adapter.authorizeCandidate({
				stateData: state.data,
				consumeInput: input,
				settings: state.settings,
				action,
				candidate: publicCandidate(candidate),
				tool: actualCall.tool,
				concrete,
				...(signal ? { signal } : {}),
			});
			return result.ok ? undefined : cause("authorization", result.reason, result.detail);
		} catch (error) {
			return cause("authorization", "authorization_failed", errorDetail(error));
		}
	};

	const rankCandidates = (
		action: ActionKey,
		candidates: readonly Candidate[],
	): readonly RankedCandidate<Output, StartInput, StateData>[] => {
		const now = performance.now();
		return candidates
			.flatMap((candidate) => {
				const match = actionKeyMatch(candidate.key, action, projectors);
				if (!match || !activeExecution(candidate)) return [];
				const execution = candidate.work.execution;
				const remainingMs =
					execution.status === "running"
						? Math.max(0, candidate.expectedDurationMs - (now - execution.startedAt))
						: execution.status === "queued"
							? candidate.expectedDurationMs
							: 0;
				return [{ candidate, match, ready: execution.status === "succeeded", remainingMs }];
			})
			.sort(
				(left, right) =>
					Number(right.ready) - Number(left.ready) ||
					left.remainingMs - right.remainingMs ||
					left.match.distance - right.match.distance ||
					right.candidate.createdAt - left.candidate.createdAt,
			);
	};

	const predictionMatches = (
		session: Session,
		action: ActionKey,
		decisionSequence: number,
	): readonly { readonly node: PlanRuntimeNode; readonly relation: ActionKeyMatch }[] => {
		const groups = new Map<string, Array<{ readonly node: PlanRuntimeNode; readonly relation: ActionKeyMatch }>>();
		for (const node of session.plan.pending()) {
			if (!node.actionKey || node.action.type !== "tool_call") continue;
			const relation = actionKeyMatch(node.actionKey, action, projectors);
			if (!relation) continue;
			const group = groups.get(node.proposalID) ?? [];
			group.push({ node, relation });
			groups.set(node.proposalID, group);
		}
		return [...groups.values()].flatMap((group) => {
			const due = group.filter(({ node }) => node.expectedDecisionSeq <= decisionSequence);
			const ranked = (due.length ? due : group).sort((left, right) =>
				due.length
					? right.node.expectedDecisionSeq - left.node.expectedDecisionSeq
					: left.node.expectedDecisionSeq - right.node.expectedDecisionSeq,
			);
			return ranked[0] ? [ranked[0]] : [];
		});
	};

	const promoteForActor = async (session: Session, node: PlanRuntimeNode): Promise<void> => {
		if (!node.prediction) return;
		const timer = session.launchTimers.get(node.prediction.id);
		if (timer) clearTimeout(timer);
		session.launchTimers.delete(node.prediction.id);
		const promoted = session.plan.promote(node.proposalID, node.action.id);
		if (promoted.status === "scheduled") await launchNode(session, promoted.node);
	};

	const preemptForActor = (
		session: Session,
		resource: ReturnType<typeof resourceProfile>,
		settings: SpeculativeActionSettings,
		protectedCandidate?: Candidate,
	): void => {
		for (const candidate of session.scheduler.preemptForAuthoritative(
			resource,
			concurrentLimit(settings),
			(candidate) => candidate !== protectedCandidate && reservationAvailable(candidate.work.reservation),
		)) {
			cancelCandidate(session, candidate, cause("admission", "preempted_by_actor"));
		}
	};

	const cancelCandidate = (session: Session, candidate: Candidate, failure: ResolutionCause): void => {
		const state = candidate.work.execution;
		const startedAt = state.status === "running" ? state.startedAt : performance.now();
		const completedAt = performance.now();
		const settled = candidate.work.cancel(failure, completedAt, Math.max(0, completedAt - startedAt));
		session.scheduler.discard(candidate);
		removeCandidate(session, candidate);
		if (settled) queueCandidateEvent(session, candidate);
		dispatchReady(session);
	};

	const discardCandidate = (session: Session, candidate: Candidate, failure: ResolutionCause): void => {
		if (candidate.work.execution.status === "queued" || candidate.work.execution.status === "running") {
			cancelCandidate(session, candidate, failure);
			return;
		}
		removeCandidate(session, candidate);
	};

	const removeCandidate = (session: Session, candidate: Candidate): void => {
		jobs.delete(session.id, candidate);
		results.delete(session.id, candidate);
		branches.delete(session.id, candidate);
		candidate.resources.dispose();
	};

	const reconcileStores = async (state: Turn): Promise<void> => {
		const enabled = new Set(candidateNames(state.settings));
		for (const candidate of allCandidates(state.sessionID)) {
			if (!enabled.has(candidate.key.tool))
				discardCandidate(state.session, candidate, cause("control", "tool_disabled"));
		}
		trimResults(state.session, state.settings);
	};

	const trimResults = (session: Session, settings: SpeculativeActionSettings): void => {
		for (const candidate of results.trim(session.id, cacheLimits(settings))) {
			removeCandidate(session, candidate);
		}
	};

	const advanceColdCache = (session: Session, settings: SpeculativeActionSettings): void => {
		for (const candidate of results.advanceDecisionBatch(session.id, {
			maxAgeMs: CACHE_COLD_MAX_AGE_MS,
			maxDecisionBatches: CACHE_COLD_MAX_DECISION_BATCHES,
		})) {
			removeCandidate(session, candidate);
		}
		trimResults(session, settings);
	};

	const invalidateChangedResources = (session: Session, action: ActionKey, adopted?: Candidate): void => {
		const invalidateWorkspace = adopted && semantics.resourceVersionPolicy(adopted.key.tool) === "workspace";
		const changed =
			adopted && !invalidateWorkspace ? (adopted.world?.resources ?? action.resources) : action.resources;
		if ((!changed.length && !invalidateWorkspace) || (adopted && adopted.work.reservation.kind === "shared")) return;
		for (const candidate of allCandidates(session.id)) {
			if (candidate === adopted) continue;
			// Once an Actor reserves a candidate, its freshness and compatibility checks
			// are authoritative. Cache invalidation may only retire unclaimed work.
			if (!reservationAvailable(candidate.work.reservation)) continue;
			if (
				invalidateWorkspace ||
				candidate.key.resources.some((resource) => changed.some((path) => resourcePathsOverlap(resource, path)))
			) {
				discardCandidate(session, candidate, cause("freshness", "authoritative_resource_changed"));
			}
		}
	};

	const pruneActionContexts = (session: Session): void => {
		for (const [id, context] of session.actionContexts) {
			if (context.opportunity?.state.status !== "matching") releaseActionContext(session, id);
		}
	};

	const finishState = async (state: Turn, terminal: boolean): Promise<void> => {
		if (state.lifecycle !== "active") return;
		const completedAt = performance.now();
		closeActorPhase(state, completedAt);
		advancePredictionFrontier(state);
		if (state.actorActions.length) advanceColdCache(state.session, state.settings);
		state.lifecycle = "closing";
		state.generation.expire(cause("control", terminal ? "terminal_turn" : "turn_finished"));
		if (terminal) {
			releaseAllSourceSlots(state.session, cause("control", "terminal_turn"));
			await waitForSourceTasks(state.session);
		}
		await state.session.effects.flush();
		state.lifecycle = "finished";
		try {
			await adapter.onTurnFinished?.({
				startInput: state.startInput,
				settings: state.settings,
				terminal,
				durationMs: Math.max(0, completedAt - state.startedAt),
			});
		} catch {
			// Host lifecycle is outside authoritative settlement.
		}
		turns.delete(state.key);
		state.session.turns.delete(state.key);
		clearActorActions(state.session, state.turnID);
		if (!terminal) return;
		for (const node of state.session.plan.unsettled()) {
			settleUnobserved(state.session, node, cause("control", "session_terminal"));
		}
		clearLaunchTimers(state.session);
		for (const candidate of allCandidates(state.sessionID)) {
			if (candidate.work.reservation.kind === "exclusive")
				discardCandidate(state.session, candidate, cause("control", "session_terminal"));
		}
		queueTaskEvent(state.session, state.turnID, completedAt);
		await state.session.effects.flush();
		for (const source of sources) {
			try {
				await source.flush?.();
			} catch {
				// Persistence failure is isolated per source.
			}
		}
		state.session.plan.clear();
		pruneActionContexts(state.session);
		clearActorActions(state.session);
	};

	const finishTurn = async (input: FinishInput): Promise<void> => {
		const state = turns.get(turnKey(input.sessionID, input.turnID));
		if (state) await finishState(state, input.terminal === true);
		else if (input.terminal === true) {
			const session = sessions.get(input.sessionID);
			if (!session) return;
			const completedAt = performance.now();
			releaseAllSourceSlots(session, cause("control", "session_terminal"));
			await waitForSourceTasks(session);
			for (const node of session.plan.unsettled())
				settleUnobserved(session, node, cause("control", "session_terminal"));
			for (const candidate of allCandidates(input.sessionID)) {
				if (candidate.work.reservation.kind === "exclusive")
					discardCandidate(session, candidate, cause("control", "session_terminal"));
			}
			clearLaunchTimers(session);
			queueTaskEvent(session, input.turnID, completedAt);
			await session.effects.flush();
			session.plan.clear();
			pruneActionContexts(session);
			clearActorActions(session);
		}
	};

	const settingsChanged = async (settings: SpeculativeActionSettings): Promise<void> => {
		masterEnabled = settings.enabled;
		if (settings.enabled) return;
		await Promise.all(
			[...sessions.keys()].map((sessionID) => disableSession(sessionID, cause("control", "disabled"))),
		);
	};

	const disableSession = async (sessionID: SessionID, failure: ResolutionCause): Promise<void> => {
		const session = sessions.get(sessionID);
		if (!session) return;
		for (const key of [...session.turns]) {
			const state = turns.get(key);
			if (!state) continue;
			state.lifecycle = "finished";
			state.generation.expire(failure);
			turns.delete(key);
		}
		session.turns.clear();
		releaseAllSourceSlots(session, failure);
		await waitForSourceTasks(session);
		for (const node of session.plan.unsettled()) settleUnobserved(session, node, failure);
		clearLaunchTimers(session);
		for (const candidate of allCandidates(sessionID)) discardCandidate(session, candidate, failure);
		session.plan.clear();
		clearActorActions(session);
		session.taskStartedAt = undefined;
		session.lastActorArrivedAt = undefined;
		session.actorPhaseIntervals.length = 0;
		session.authoritativeToolIntervals.length = 0;
		session.authoritativeCandidateIDs.clear();
		await session.effects.flush();
		pruneActionContexts(session);
	};

	const disposeSession = async (sessionID: SessionID): Promise<void> => {
		const session = sessions.get(sessionID);
		if (!session) return;
		session.disposed = true;
		await disableSession(sessionID, cause("control", "session_disposed"));
		await session.effects.close();
		sessions.delete(sessionID);
		for (const source of sources) {
			try {
				await source.flush?.();
			} catch {
				// Persistence failure is isolated per source.
			}
		}
	};

	const releaseSession = async (sessionID: SessionID): Promise<void> => {
		await disposeSession(sessionID);
	};

	const dispose = async (): Promise<void> => {
		for (const sessionID of [...sessions.keys()]) await disposeSession(sessionID);
	};

	const inspect = (sessionID?: SessionID): SpeculativeRuntimeInspection => {
		const selectedSessions = sessionID === undefined ? [...sessions.values()] : maybe(sessions.get(sessionID));
		const selectedTurns = [...turns.values()].filter(
			(turn) => sessionID === undefined || turn.sessionID === sessionID,
		);
		const candidates =
			sessionID === undefined
				? uniqueCandidates([...jobs.allValues(), ...results.allValues(), ...branches.allValues()])
				: allCandidates(sessionID);
		const planNodes = selectedSessions.flatMap((session) => session.plan.values());
		return {
			activeTurns: selectedTurns.length,
			exclusiveCandidates: candidates.filter((candidate) => candidate.work.reservation.kind === "exclusive").length,
			sharedCandidates: candidates.filter((candidate) => candidate.work.reservation.kind === "shared").length,
			pendingPredictions: selectedSessions.reduce(
				(total, session) => total + session.pendingSourceRequests + session.pendingAdmissions,
				0,
			),
			deferredPlanActions: planNodes.filter((node) => node.execution.status === "deferred").length,
			activePlanActions: planNodes.filter(
				(node) => node.execution.status === "scheduled" || node.execution.status === "running",
			).length,
			blockedPlanActions: planNodes.filter((node) => node.readiness === "blocked").length,
		};
	};

	const cacheSnapshot = (session: Session, settings: SpeculativeActionSettings): SpeculativeCacheSnapshot => {
		const inFlight = jobs.values(session.id);
		const cached = results.values(session.id);
		const staged = branches.values(session.id);
		const segments = results.snapshot(session.id);
		return {
			cacheCapacity: settings.resourceCacheMaxEntries,
			cacheByteCapacity: cacheByteLimit(settings),
			cacheCold: segments.coldEntries,
			cacheHot: segments.hotEntries,
			inFlightJobs: inFlight.length,
			resultEntries: cached.length,
			resultBytes: cached.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
			branchEntries: staged.length,
			branchBytes: staged.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
			exclusiveCandidates: [...inFlight, ...staged].filter(
				(candidate) => candidate.work.reservation.kind === "exclusive",
			).length,
			sharedCandidates: [...inFlight, ...cached].filter((candidate) => candidate.work.reservation.kind === "shared")
				.length,
			cacheTools: [...new Set([...inFlight, ...cached, ...staged].map((candidate) => candidate.key.tool))].sort(),
			cacheExecutions: [
				...new Set([...inFlight, ...cached, ...staged].map((candidate) => candidate.key.execution)),
			].sort(),
		};
	};

	const queueTaskEvent = (session: Session, turnID: string, completedAt: number): void => {
		const startedAt = session.taskStartedAt;
		if (startedAt === undefined) return;
		const timing = measureSpeculativeTask({
			startedAt,
			completedAt,
			actorPhases: session.actorPhaseIntervals,
			authoritativeTools: session.authoritativeToolIntervals,
		});
		session.taskStartedAt = undefined;
		session.lastActorArrivedAt = undefined;
		session.actorPhaseIntervals.length = 0;
		session.authoritativeToolIntervals.length = 0;
		session.authoritativeCandidateIDs.clear();
		const event: SpeculativeActionEvent<SessionID> = {
			type: "task",
			sessionID: session.id,
			turnID,
			timestamp: Date.now(),
			cache: cacheSnapshot(session, session.settings),
			timing,
		};
		session.effects.enqueue(() => emit(event));
	};

	const queueSourceRequestEvent = (
		session: Session,
		turnID: string,
		settings: SpeculativeActionSettings,
		result: SettledSourceRequest,
	): void => {
		const request: SettledSourceRequest = {
			request: result.request,
			startedAt: result.startedAt,
			durationMs: result.durationMs,
			settlement: result.settlement,
		};
		const event: SpeculativeActionEvent<SessionID> = {
			type: "source_request",
			sessionID: session.id,
			turnID,
			timestamp: Date.now(),
			cache: cacheSnapshot(session, settings),
			request,
		};
		session.effects.enqueue(() => emit(event));
	};

	const queueCandidateEvent = (session: Session, candidate: Candidate): void => {
		const state = candidateExecutionProjection(candidate);
		if (!state) return;
		const descriptor = candidateEventDescriptor(candidate);
		const event: SpeculativeActionEvent<SessionID> = {
			type: "candidate",
			sessionID: session.id,
			turnID: candidate.owner.startInput.turnID,
			timestamp: Date.now(),
			cache: cacheSnapshot(session, candidate.owner.settings),
			candidate: descriptor,
			state,
		};
		session.effects.enqueue(() => emit(event));
	};

	const emit = async (event: SpeculativeActionEvent<SessionID>): Promise<void> => {
		try {
			await adapter.onEvent?.(event);
		} catch {
			// Events are projections and cannot mutate settlement.
		}
	};

	return { startTurn, consume, actual, finishTurn, settingsChanged, releaseSession, disposeSession, dispose, inspect };

	function allCandidates(sessionID: SessionID): Candidate[] {
		return uniqueCandidates([...jobs.values(sessionID), ...results.values(sessionID), ...branches.values(sessionID)]);
	}

	function candidateByID(sessionID: SessionID, candidateID: string): Candidate | undefined {
		return allCandidates(sessionID).find((candidate) => candidate.id === candidateID);
	}

	function candidateExecutionDuration(session: Session, candidateID: string): number {
		const execution = candidateByID(session.id, candidateID)?.work.execution;
		return execution && "executionMs" in execution ? execution.executionMs : 0;
	}

	function recordValidation(candidate: Candidate, validation: ResourceValidation): void {
		candidate.validationMs += finiteMetric(validation.metrics.durationMs);
		candidate.validationBytes += finiteMetric(validation.metrics.bytesRead);
		candidate.validationFiles += finiteMetric(validation.metrics.filesRead);
		candidate.validationMode = validation.metrics.mode;
	}
}
