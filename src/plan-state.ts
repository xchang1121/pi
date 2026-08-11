import { isDeepStrictEqual } from "node:util";
import type { SpeculativeExecution } from "./action-semantics.ts";
import type {
	MaterializedPlan,
	PlanAction,
	PlanActionDependency,
	PlanActionDependencyCondition,
	PlanDelta,
	PlanProposal,
	PlanUpdate,
} from "./plan-proposal.ts";

export type PlanExecutionState = "deferred" | "launching" | "running" | "succeeded" | "adopted" | "failed" | "blocked";

export interface PlanExecutionNode {
	readonly proposalID: string;
	readonly source: string;
	readonly revision: number;
	readonly action: PlanAction;
	readonly anchorActionSeq: number;
	/** Actor action sequence at which this action is expected to be requested. */
	readonly expectedActionSeq: number;
	/** Last settled actor sequence required before speculative execution should start. */
	readonly launchActionSeq: number;
	readonly state: PlanExecutionState;
}

export type PlanPromotion =
	| { readonly status: "claimed"; readonly node: PlanExecutionNode }
	| { readonly status: "waiting" | "active" | "terminal" | "missing" };

export type PlanUpdateResult =
	| {
			readonly accepted: true;
			readonly plan: MaterializedPlan;
			readonly upserted: readonly PlanAction[];
			readonly removed: readonly string[];
			/** Previous lifecycle nodes removed or replaced by this atomic update. */
			readonly retired: readonly PlanExecutionNode[];
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
	draftTokens: number;
	nodes: Map<string, MutableNode>;
};

type MutableNode = {
	action: PlanAction;
	anchorActionSeq: number;
	expectedActionSeq: number;
	launchActionSeq: number;
	resolvedActionSeq?: number;
	state: PlanExecutionState;
	blockedReported: boolean;
};

/** Materialized proposal and source-neutral scheduler lifecycle stored as one state graph. */
export class PlanState {
	private readonly plans = new Map<string, MutablePlan>();
	private readonly actionExecution: (action: PlanAction) => SpeculativeExecution | undefined;

	constructor(
		actionExecution: (action: PlanAction) => SpeculativeExecution | undefined = (action) => action.execution,
	) {
		this.actionExecution = actionExecution;
	}

	apply(update: PlanUpdate, anchorActionSeq: number): PlanUpdateResult {
		return "actions" in update
			? this.applyProposal(update, anchorActionSeq)
			: this.applyDelta(update, anchorActionSeq);
	}

	plan(proposalID: string): MaterializedPlan | undefined {
		const plan = this.plans.get(proposalID);
		return plan ? planSnapshot(plan) : undefined;
	}

	takeReady(actionSequence: number): readonly PlanExecutionNode[] {
		const settledSequence = sequence(actionSequence);
		for (const plan of this.plans.values()) this.blockImpossible(plan);
		const ready = this.mutableValues()
			.filter(
				({ plan, node }) =>
					node.state === "deferred" &&
					node.launchActionSeq <= settledSequence &&
					this.dependenciesSatisfied(plan, node),
			)
			.sort(
				(left, right) =>
					left.node.launchActionSeq - right.node.launchActionSeq ||
					left.node.expectedActionSeq - right.node.expectedActionSeq ||
					left.plan.id.localeCompare(right.plan.id) ||
					left.node.action.id.localeCompare(right.node.action.id),
			);
		for (const { node } of ready) node.state = "launching";
		return ready.map(({ plan, node }) => nodeSnapshot(plan, node));
	}

	promote(proposalID: string, actionID: string): PlanPromotion {
		const value = this.mutable(proposalID, actionID);
		if (!value) return { status: "missing" };
		this.blockImpossible(value.plan);
		if (value.node.state === "blocked" || terminal(value.node.state)) return { status: "terminal" };
		if (value.node.state !== "deferred") return { status: "active" };
		if (!this.dependenciesSatisfied(value.plan, value.node)) return { status: "waiting" };
		value.node.state = "launching";
		return { status: "claimed", node: nodeSnapshot(value.plan, value.node) };
	}

	markRunning(proposalID: string, actionID: string): void {
		const node = this.mutable(proposalID, actionID)?.node;
		if (node?.state === "launching") node.state = "running";
	}

	defer(proposalID: string, actionID: string): void {
		const node = this.mutable(proposalID, actionID)?.node;
		if (node?.state === "launching") node.state = "deferred";
	}

	markSucceeded(proposalID: string, actionID: string): void {
		const value = this.mutable(proposalID, actionID);
		if (!value || value.node.state === "adopted") return;
		if (value.node.state === "launching" || value.node.state === "running") value.node.state = "succeeded";
		this.blockImpossible(value.plan);
	}

	markAdopted(proposalID: string, actionID: string, actionSequence?: number): void {
		const value = this.mutable(proposalID, actionID);
		if (!value || value.node.state === "blocked") return;
		if (actionSequence !== undefined) value.node.resolvedActionSeq = sequence(actionSequence);
		value.node.state = "adopted";
		this.recompute(value.plan);
		this.blockImpossible(value.plan);
	}

	markFailed(proposalID: string, actionID: string): void {
		const value = this.mutable(proposalID, actionID);
		if (!value || value.node.state === "adopted" || value.node.state === "blocked") return;
		value.node.state = "failed";
		this.blockImpossible(value.plan);
	}

	get(proposalID: string, actionID: string): PlanExecutionNode | undefined {
		const value = this.mutable(proposalID, actionID);
		return value ? nodeSnapshot(value.plan, value.node) : undefined;
	}

	canAdopt(proposalID: string, actionID: string): boolean {
		const value = this.mutable(proposalID, actionID);
		return Boolean(
			value &&
				value.node.state !== "adopted" &&
				value.node.state !== "blocked" &&
				this.dependenciesSatisfied(value.plan, value.node),
		);
	}

	values(): readonly PlanExecutionNode[] {
		return this.mutableValues().map(({ plan, node }) => nodeSnapshot(plan, node));
	}

	deferred(): readonly PlanExecutionNode[] {
		return this.mutableValues()
			.filter(({ node }) => node.state === "deferred")
			.map(({ plan, node }) => nodeSnapshot(plan, node));
	}

	drainBlocked(): readonly PlanExecutionNode[] {
		for (const plan of this.plans.values()) this.blockImpossible(plan);
		const blocked = this.mutableValues().filter(({ node }) => node.state === "blocked" && !node.blockedReported);
		for (const { node } of blocked) node.blockedReported = true;
		return blocked.map(({ plan, node }) => nodeSnapshot(plan, node));
	}

	clear(): void {
		this.plans.clear();
	}

	private applyProposal(proposal: PlanProposal, anchorActionSeq: number): PlanUpdateResult {
		if (!validIdentity(proposal.id, proposal.source)) return { accepted: false, reason: "invalid_identity" };
		if (!validRevision(proposal.revision)) return { accepted: false, reason: "invalid_revision" };
		const current = this.plans.get(proposal.id);
		if (current && current.source !== proposal.source) return { accepted: false, reason: "source_mismatch" };
		if (current && proposal.revision <= current.revision) return { accepted: false, reason: "stale_revision" };
		const validated = validateActions(proposal.actions);
		if (!validated.ok) return { accepted: false, reason: validated.reason };
		const actions = new Map(validated.actions.map((action) => [action.id, action]));
		if (!dependenciesAreValid(actions)) return { accepted: false, reason: "invalid_dependency" };
		return this.commit({
			id: proposal.id,
			source: proposal.source,
			revision: proposal.revision,
			draftTokens: finiteMetric(proposal.draftTokens),
			actions,
			upserted: validated.actions,
			anchorActionSeq,
		});
	}

	private applyDelta(delta: PlanDelta, anchorActionSeq: number): PlanUpdateResult {
		if (!validIdentity(delta.proposalID, delta.source)) return { accepted: false, reason: "invalid_identity" };
		if (!validRevision(delta.revision)) return { accepted: false, reason: "invalid_revision" };
		const current = this.plans.get(delta.proposalID);
		if (!current) return { accepted: false, reason: "proposal_missing" };
		if (current.source !== delta.source) return { accepted: false, reason: "source_mismatch" };
		if (delta.revision <= current.revision) return { accepted: false, reason: "stale_revision" };
		const validated = validateActions(delta.upsert ?? []);
		if (!validated.ok) return { accepted: false, reason: validated.reason };
		const removals = new Set(delta.remove ?? []);
		if ([...removals].some((id) => !validToken(id))) return { accepted: false, reason: "invalid_action" };
		const actions = new Map([...current.nodes].map(([id, node]) => [id, node.action]));
		for (const id of removals) actions.delete(id);
		for (const action of validated.actions) actions.set(action.id, action);
		if (!dependenciesAreValid(actions)) return { accepted: false, reason: "invalid_dependency" };
		return this.commit({
			id: current.id,
			source: current.source,
			revision: delta.revision,
			draftTokens: current.draftTokens + finiteMetric(delta.draftTokens),
			actions,
			upserted: validated.actions,
			anchorActionSeq,
		});
	}

	private commit(input: {
		readonly id: string;
		readonly source: string;
		readonly revision: number;
		readonly draftTokens: number;
		readonly actions: ReadonlyMap<string, PlanAction>;
		readonly upserted: readonly PlanAction[];
		readonly anchorActionSeq: number;
	}): PlanUpdateResult {
		const current = this.plans.get(input.id);
		const touched = new Set(input.upserted.map((action) => action.id));
		const replaced = new Set(
			input.upserted.flatMap((action) => {
				const previous = current?.nodes.get(action.id)?.action;
				return previous && !samePlanActionExecution(previous, action) ? [action.id] : [];
			}),
		);
		const removed = current ? [...current.nodes.keys()].filter((id) => !input.actions.has(id)) : [];
		const retired = current
			? [...new Set([...removed, ...replaced])].flatMap((id) => {
					const node = current.nodes.get(id);
					return node ? [nodeSnapshot(current, node)] : [];
				})
			: [];
		const fresh = new Set<string>();
		const anchor = sequence(input.anchorActionSeq);
		const nodes = new Map<string, MutableNode>();
		for (const [id, action] of input.actions) {
			const previous = current?.nodes.get(id);
			if (previous && !replaced.has(id)) {
				previous.action = action;
				if (touched.has(id) && previous.state === "deferred") previous.anchorActionSeq = anchor;
				nodes.set(id, previous);
				continue;
			}
			fresh.add(id);
			nodes.set(id, newNode(action, anchor));
		}
		const next: MutablePlan = {
			id: input.id,
			source: input.source,
			revision: input.revision,
			draftTokens: input.draftTokens,
			nodes,
		};
		for (const node of nodes.values()) {
			if (node.state !== "blocked" || !dependsOnAny(node.action.id, fresh, input.actions)) continue;
			node.state = "deferred";
			node.blockedReported = false;
		}
		this.plans.set(next.id, next);
		this.recompute(next);
		this.blockImpossible(next);
		return {
			accepted: true,
			plan: planSnapshot(next),
			upserted: input.upserted,
			removed,
			retired: Object.freeze(retired),
		};
	}

	private mutable(
		proposalID: string,
		actionID: string,
	): { readonly plan: MutablePlan; readonly node: MutableNode } | undefined {
		const plan = this.plans.get(proposalID);
		const node = plan?.nodes.get(actionID);
		return plan && node ? { plan, node } : undefined;
	}

	private mutableValues(): Array<{ readonly plan: MutablePlan; readonly node: MutableNode }> {
		return [...this.plans.values()].flatMap((plan) => [...plan.nodes.values()].map((node) => ({ plan, node })));
	}

	private recompute(plan: MutablePlan): void {
		const memo = new Map<string, number>();
		const visiting = new Set<string>();
		const expected = (node: MutableNode): number => {
			const cached = memo.get(node.action.id);
			if (cached !== undefined) return cached;
			if (visiting.has(node.action.id)) return node.anchorActionSeq + horizon(node.action) + 1;
			visiting.add(node.action.id);
			let value = node.resolvedActionSeq ?? node.anchorActionSeq + horizon(node.action) + 1;
			for (const dependency of node.action.dependsOn ?? []) {
				const parent = plan.nodes.get(dependency.actionID);
				if (parent) value = Math.max(value, expected(parent) + 1);
			}
			visiting.delete(node.action.id);
			memo.set(node.action.id, value);
			return value;
		};
		for (const node of plan.nodes.values()) {
			node.expectedActionSeq = expected(node);
			node.launchActionSeq = Math.max(node.anchorActionSeq, node.expectedActionSeq - 1);
		}
	}

	private dependenciesSatisfied(plan: MutablePlan, node: MutableNode): boolean {
		return (node.action.dependsOn ?? []).every((dependency) => {
			const parent = plan.nodes.get(dependency.actionID);
			return parent
				? conditionSatisfied(parent.state, this.dependencyCondition(parent.action, dependency.condition))
				: false;
		});
	}

	private blockImpossible(plan: MutablePlan): void {
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of plan.nodes.values()) {
				if (node.state !== "deferred") continue;
				const impossible = (node.action.dependsOn ?? []).some((dependency) => {
					const parent = plan.nodes.get(dependency.actionID);
					return (
						!parent ||
						conditionImpossible(parent.state, this.dependencyCondition(parent.action, dependency.condition))
					);
				});
				if (!impossible) continue;
				node.state = "blocked";
				changed = true;
			}
		}
	}

	private dependencyCondition(
		parent: PlanAction,
		declared: PlanActionDependencyCondition | undefined,
	): PlanActionDependencyCondition | undefined {
		return this.actionExecution(parent) === "sandbox" ? "adopted" : declared;
	}
}

function newNode(action: PlanAction, anchorActionSeq: number): MutableNode {
	return {
		action,
		anchorActionSeq,
		expectedActionSeq: anchorActionSeq + horizon(action) + 1,
		launchActionSeq: anchorActionSeq + horizon(action),
		state: "deferred",
		blockedReported: false,
	};
}

function planSnapshot(plan: MutablePlan): MaterializedPlan {
	return Object.freeze({
		id: plan.id,
		source: plan.source,
		revision: plan.revision,
		actions: Object.freeze([...plan.nodes.values()].map((node) => node.action)),
		draftTokens: plan.draftTokens,
	});
}

function nodeSnapshot(plan: MutablePlan, node: MutableNode): PlanExecutionNode {
	return Object.freeze({
		proposalID: plan.id,
		source: plan.source,
		revision: plan.revision,
		action: node.action,
		anchorActionSeq: node.anchorActionSeq,
		expectedActionSeq: node.expectedActionSeq,
		launchActionSeq: node.launchActionSeq,
		state: node.state,
	});
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

function samePlanActionExecution(left: PlanAction, right: PlanAction): boolean {
	return (
		left.type === right.type &&
		left.tool === right.tool &&
		left.execution === right.execution &&
		isDeepStrictEqual(left.input, right.input) &&
		isDeepStrictEqual(left.missing ?? [], right.missing ?? []) &&
		isDeepStrictEqual(normalizedDependencies(left), normalizedDependencies(right))
	);
}

function normalizedDependencies(action: PlanAction): ReadonlyArray<Required<PlanActionDependency>> {
	return (action.dependsOn ?? [])
		.map(
			(dependency): Required<PlanActionDependency> => ({
				actionID: dependency.actionID,
				condition: dependency.condition ?? "completed",
			}),
		)
		.sort(
			(left, right) => left.actionID.localeCompare(right.actionID) || left.condition.localeCompare(right.condition),
		);
}

function dependsOnAny(
	actionID: string,
	targets: ReadonlySet<string>,
	actions: ReadonlyMap<string, PlanAction>,
): boolean {
	const visited = new Set<string>();
	const visit = (current: string): boolean => {
		if (visited.has(current)) return false;
		visited.add(current);
		for (const dependency of actions.get(current)?.dependsOn ?? []) {
			if (targets.has(dependency.actionID) || visit(dependency.actionID)) return true;
		}
		return false;
	};
	return visit(actionID);
}

function conditionSatisfied(state: PlanExecutionState, condition: PlanActionDependencyCondition | undefined): boolean {
	if (condition === "adopted") return state === "adopted";
	if (condition === "succeeded") return state === "succeeded" || state === "adopted";
	return state === "succeeded" || state === "adopted" || state === "failed";
}

function conditionImpossible(state: PlanExecutionState, condition: PlanActionDependencyCondition | undefined): boolean {
	if (state === "blocked") return true;
	if (condition === "completed") return false;
	return state === "failed";
}

function terminal(state: PlanExecutionState): boolean {
	return state === "succeeded" || state === "adopted" || state === "failed" || state === "blocked";
}

function horizon(action: PlanAction): number {
	if (action.type === "preparation_hint") return 0;
	return sequence(action.horizon ?? 0);
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

function sequence(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
