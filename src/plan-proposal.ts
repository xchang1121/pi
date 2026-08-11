import type { SpeculativeExecution } from "./action-semantics.ts";

export type PlanActionDependencyCondition = "completed" | "succeeded" | "adopted";

/** A scheduler-visible edge. The producer may add actions in later deltas. */
export interface PlanActionDependency {
	readonly actionID: string;
	readonly condition?: PlanActionDependencyCondition;
}

export interface PlanAction {
	/** Stable within one proposal across revisions. */
	readonly id: string;
	readonly type: "tool_call" | "preparation_hint";
	readonly tool: string;
	readonly input: unknown;
	readonly missing?: readonly (readonly (string | number)[])[];
	readonly execution?: SpeculativeExecution;
	readonly diagnostic?: string;
	readonly horizon?: number;
	readonly empiricalProbability?: number;
	readonly conditionalProbability?: number;
	readonly expectedDurationMs?: number;
	readonly expectedLatencyBenefitMs?: number;
	readonly resourceDemand?: number;
	readonly depth?: number;
	readonly dependsOn?: readonly PlanActionDependency[];
	/** Opaque producer-owned state. The runtime only returns it in feedback/continuation calls. */
	readonly feedback?: unknown;
}

export interface PlanProposal {
	/** Stable producer-chosen identity for the whole evolving plan. */
	readonly id: string;
	/** Opaque source identity; cache and action equivalence never depend on it. */
	readonly source: string;
	readonly revision: number;
	readonly actions: readonly PlanAction[];
	readonly draftTokens?: number;
}

/** Incremental update to a proposal. Revisions must be strictly increasing. */
export interface PlanDelta {
	readonly proposalID: string;
	readonly source: string;
	readonly revision: number;
	readonly upsert?: readonly PlanAction[];
	readonly remove?: readonly string[];
	readonly draftTokens?: number;
}

export type PlanUpdate = PlanProposal | PlanDelta;

export interface MaterializedPlan {
	readonly id: string;
	readonly source: string;
	readonly revision: number;
	readonly actions: readonly PlanAction[];
	readonly draftTokens: number;
}
