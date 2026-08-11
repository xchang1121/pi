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

export type PlanUpdateResult =
	| {
			readonly accepted: true;
			readonly plan: MaterializedPlan;
			readonly upserted: readonly PlanAction[];
			readonly removed: readonly string[];
	  }
	| {
			readonly accepted: false;
			readonly reason:
				| "invalid_identity"
				| "invalid_revision"
				| "source_mismatch"
				| "proposal_missing"
				| "stale_revision"
				| "duplicate_action"
				| "invalid_action"
				| "invalid_dependency";
	  };

type MutablePlan = {
	id: string;
	source: string;
	revision: number;
	actions: Map<string, PlanAction>;
	draftTokens: number;
};

/** Small, deterministic materializer shared by every prediction source. */
export class PlanLedger {
	private readonly plans = new Map<string, MutablePlan>();

	apply(update: PlanUpdate): PlanUpdateResult {
		return isProposal(update) ? this.applyProposal(update) : this.applyDelta(update);
	}

	get(proposalID: string): MaterializedPlan | undefined {
		const plan = this.plans.get(proposalID);
		return plan ? snapshot(plan) : undefined;
	}

	delete(proposalID: string): boolean {
		return this.plans.delete(proposalID);
	}

	clear(): void {
		this.plans.clear();
	}

	values(): readonly MaterializedPlan[] {
		return [...this.plans.values()].map(snapshot);
	}

	private applyProposal(proposal: PlanProposal): PlanUpdateResult {
		const identity = validIdentity(proposal.id, proposal.source);
		if (!identity) return { accepted: false, reason: "invalid_identity" };
		if (!validRevision(proposal.revision)) return { accepted: false, reason: "invalid_revision" };
		const current = this.plans.get(proposal.id);
		if (current && current.source !== proposal.source) return { accepted: false, reason: "source_mismatch" };
		if (current && proposal.revision <= current.revision) return { accepted: false, reason: "stale_revision" };
		const validated = validateActions(proposal.actions);
		if (!validated.ok) return { accepted: false, reason: validated.reason };
		const actions = new Map(validated.actions.map((action) => [action.id, action]));
		if (!dependenciesAreValid(actions)) return { accepted: false, reason: "invalid_dependency" };
		const next: MutablePlan = {
			id: proposal.id,
			source: proposal.source,
			revision: proposal.revision,
			actions,
			draftTokens: finiteMetric(proposal.draftTokens),
		};
		const removed = current ? [...current.actions.keys()].filter((id) => !next.actions.has(id)) : [];
		this.plans.set(next.id, next);
		return { accepted: true, plan: snapshot(next), upserted: [...next.actions.values()], removed };
	}

	private applyDelta(delta: PlanDelta): PlanUpdateResult {
		const identity = validIdentity(delta.proposalID, delta.source);
		if (!identity) return { accepted: false, reason: "invalid_identity" };
		if (!validRevision(delta.revision)) return { accepted: false, reason: "invalid_revision" };
		const current = this.plans.get(delta.proposalID);
		if (!current) return { accepted: false, reason: "proposal_missing" };
		if (current.source !== delta.source) return { accepted: false, reason: "source_mismatch" };
		if (delta.revision <= current.revision) return { accepted: false, reason: "stale_revision" };
		const validated = validateActions(delta.upsert ?? []);
		if (!validated.ok) return { accepted: false, reason: validated.reason };
		const removals = new Set(delta.remove ?? []);
		if ([...removals].some((id) => !validToken(id))) return { accepted: false, reason: "invalid_action" };
		const actions = new Map(current.actions);
		for (const id of removals) actions.delete(id);
		for (const action of validated.actions) actions.set(action.id, action);
		if (!dependenciesAreValid(actions)) return { accepted: false, reason: "invalid_dependency" };
		const next: MutablePlan = {
			...current,
			revision: delta.revision,
			actions,
			draftTokens: current.draftTokens + finiteMetric(delta.draftTokens),
		};
		this.plans.set(next.id, next);
		return {
			accepted: true,
			plan: snapshot(next),
			upserted: validated.actions,
			removed: [...removals].filter((id) => current.actions.has(id)),
		};
	}
}

export function proposalAsDelta(proposal: PlanProposal): PlanDelta {
	return {
		proposalID: proposal.id,
		source: proposal.source,
		revision: proposal.revision,
		upsert: proposal.actions,
		...(proposal.draftTokens !== undefined ? { draftTokens: proposal.draftTokens } : {}),
	};
}

export function isProposal(update: PlanUpdate): update is PlanProposal {
	return "actions" in update;
}

function validateActions(
	actions: readonly PlanAction[],
):
	| { readonly ok: true; readonly actions: readonly PlanAction[] }
	| { readonly ok: false; readonly reason: "duplicate_action" | "invalid_action" | "invalid_dependency" } {
	const result: PlanAction[] = [];
	const ids = new Set<string>();
	for (const source of actions) {
		if (
			!validToken(source.id) ||
			!validToken(source.tool) ||
			(source.type !== "tool_call" && source.type !== "preparation_hint")
		) {
			return { ok: false, reason: "invalid_action" };
		}
		if (ids.has(source.id)) return { ok: false, reason: "duplicate_action" };
		ids.add(source.id);
		const dependsOn = source.dependsOn ? Object.freeze([...source.dependsOn]) : undefined;
		if (
			dependsOn?.some(
				(dependency) =>
					!validToken(dependency.actionID) ||
					(dependency.condition !== undefined &&
						dependency.condition !== "completed" &&
						dependency.condition !== "succeeded" &&
						dependency.condition !== "adopted"),
			)
		) {
			return { ok: false, reason: "invalid_dependency" };
		}
		result.push(Object.freeze({ ...source, ...(dependsOn ? { dependsOn } : {}) }));
	}
	return { ok: true, actions: Object.freeze(result) };
}

function dependenciesAreValid(actions: ReadonlyMap<string, PlanAction>): boolean {
	for (const action of actions.values()) {
		for (const dependency of action.dependsOn ?? []) {
			if (dependency.actionID === action.id || !actions.has(dependency.actionID)) return false;
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (actionID: string): boolean => {
		if (visiting.has(actionID)) return false;
		if (visited.has(actionID)) return true;
		visiting.add(actionID);
		for (const dependency of actions.get(actionID)?.dependsOn ?? []) {
			if (!visit(dependency.actionID)) return false;
		}
		visiting.delete(actionID);
		visited.add(actionID);
		return true;
	};
	return [...actions.keys()].every(visit);
}

function snapshot(plan: MutablePlan): MaterializedPlan {
	return Object.freeze({
		id: plan.id,
		source: plan.source,
		revision: plan.revision,
		actions: Object.freeze([...plan.actions.values()]),
		draftTokens: plan.draftTokens,
	});
}

function validIdentity(proposalID: string, source: string): boolean {
	return validToken(proposalID) && validToken(source);
}

function validToken(value: string): boolean {
	return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function finiteMetric(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
