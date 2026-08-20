import type { ActionProjectionRule } from "./action-key-projection.ts";
import {
	type ActionKey,
	type ActionSemanticsRegistry,
	PI_ACTION_SEMANTICS,
	type SpeculativeExecution,
} from "./action-semantics.ts";
import type { DrafterToolDefinition } from "./common.ts";
import type { SpeculativeActionEvent } from "./events.ts";
import type { WorldBranch } from "./execution-world.ts";
import type { PlanAction, PlanProposal, PlanUpdate } from "./plan-proposal.ts";
import { makeStructuralSpeculativeActionRuntime } from "./runtime-engine.ts";
import type { PredictionSettlement, ResourceValidation } from "./settlement.ts";

export { diagnosticAction, diagnosticJson, redactDiagnostics } from "./diagnostics.ts";

export type {
	CandidateEventDescriptor,
	CandidateExecutionProjection,
	SpeculativeActionEvent,
	SpeculativeCacheSnapshot,
} from "./events.ts";

export interface SpeculativeActionSettings {
	readonly enabled: boolean;
	readonly drafterEnabled?: boolean;
	readonly candidateLimit?: number;
	readonly maxConcurrentActions?: number;
	readonly resourceCacheMaxEntries: number;
	readonly resourceCacheMaxBytes?: number;
	readonly predictionTimeoutMs: number;
	/** Source-owned configuration. The runtime treats every value as opaque. */
	readonly sourceConfig?: Readonly<Record<string, unknown>>;
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
	readonly latestHorizon?: number;
	readonly empiricalProbability?: number;
	readonly conditionalProbability?: number;
	readonly expectedDurationMs?: number;
	readonly expectedLatencyBenefitMs?: number;
	readonly resourceDemand?: number;
	readonly depth?: number;
}

export type CandidatePreflight =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string; readonly detail?: string };

/** Read-only execution view passed to host callbacks. Prediction facts are supplied separately. */
export interface SpeculativeCandidate {
	readonly id: string;
	readonly key: ActionKey;
	readonly tool: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly resourceVersion?: unknown;
	readonly work?: { readonly execution?: { readonly executionMs?: number } };
	readonly source?: string;
	readonly empiricalProbability?: number;
	readonly conditionalProbability?: number;
	readonly depth?: number;
	readonly planDependencies?: PlanAction["dependsOn"];
}

interface TurnInput<SessionID> {
	readonly sessionID: SessionID;
	readonly turnID: string;
	readonly terminal?: boolean;
}

type MaybePromise<T> = T | Promise<T>;

export interface SpeculativePlanSource<
	SessionID,
	Output,
	StartInput extends TurnInput<SessionID>,
	ConsumeInput extends TurnInput<SessionID>,
	StateData,
> {
	readonly id: string;
	readonly enabled: (settings: SpeculativeActionSettings) => boolean;
	readonly timeoutMs?: (settings: SpeculativeActionSettings) => number | undefined;
	/** Stop requests that can only predict the next Actor action once that intent arrives. */
	readonly requestLifetime?: "actor_action" | "turn";
	readonly multiStepEnabled?: (settings: SpeculativeActionSettings) => boolean;
	readonly proposalCount?: (settings: SpeculativeActionSettings) => number;
	readonly propose: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly definitions: readonly DrafterToolDefinition[];
		readonly candidateNames: readonly string[];
		readonly proposalIndex: number;
		readonly proposalCount: number;
		readonly signal: AbortSignal;
	}) => MaybePromise<PlanProposal | readonly PlanProposal[] | undefined>;
	readonly continue?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeCandidate;
		readonly proposalID: string;
		readonly actionID: string;
		readonly revision: number;
		readonly feedback: unknown;
		readonly output: Output;
		readonly trigger: "execution_succeeded" | "actor_adopted";
		readonly signal: AbortSignal;
	}) => MaybePromise<PlanUpdate | readonly PlanUpdate[] | undefined>;
	/** Restrict continuation callbacks without coupling Runtime scheduling to a concrete source. */
	readonly continueOn?: readonly ("execution_succeeded" | "actor_adopted")[];
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
		readonly order: number;
	}) => MaybePromise<PlanUpdate | readonly PlanUpdate[] | undefined>;
	readonly onIssued?: (input: {
		readonly proposalID: string;
		readonly actionID: string;
		readonly feedback: unknown;
	}) => MaybePromise<void>;
	readonly onSettled?: (input: {
		readonly proposalID: string;
		readonly actionID: string;
		readonly feedback: unknown;
		readonly settlement: PredictionSettlement;
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
	readonly actual: (input: ConsumeInput) => { readonly id?: string; readonly tool: string; readonly input: unknown };
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
		readonly parentWorld?: WorldBranch<Output>;
	}) => MaybePromise<Output | WorldBranch<Output>>;
	readonly prepareCandidate?: (input: {
		readonly startInput: StartInput;
		readonly data: StateData;
		readonly settings: SpeculativeActionSettings;
		readonly candidate: SpeculativeDraftCandidate;
		readonly action?: ActionKey;
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
	readonly validateResourceVersion?: (input: {
		readonly stateData: StateData;
		readonly consumeInput?: ConsumeInput;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
	}) => MaybePromise<ResourceValidation>;
	readonly watchResourceVersion?: (input: {
		readonly stateData: StateData;
		readonly action: ActionKey;
		readonly candidate: SpeculativeCandidate;
		readonly onInvalidated: (changedPath?: string) => void;
	}) => MaybePromise<(() => void) | undefined>;
	readonly projectionRules?: readonly ActionProjectionRule<Output>[];
	readonly rejectCandidateOutput?: (input: {
		readonly output: Output;
		readonly candidate: SpeculativeCandidate;
	}) => string | undefined;
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
	readonly exclusiveCandidates: number;
	readonly sharedCandidates: number;
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

export const makeSpeculativeActionRuntime = makeStructuralSpeculativeActionRuntime;

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
	const value = candidate.work?.execution?.executionMs;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
