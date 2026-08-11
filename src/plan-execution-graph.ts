import type { MaterializedPlan, PlanAction, PlanActionDependencyCondition } from "./plan-proposal.ts";

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

type MutableNode = {
	proposalID: string;
	source: string;
	revision: number;
	action: PlanAction;
	anchorActionSeq: number;
	expectedActionSeq: number;
	launchActionSeq: number;
	resolvedActionSeq?: number;
	state: PlanExecutionState;
	blockedReported: boolean;
};

/**
 * Source-neutral lifecycle for an evolving action DAG.
 *
 * The graph deliberately does not execute tools or reserve resources. It only
 * decides when a node may be handed to the tool scheduler. A future-horizon
 * node is released one actor action before its expected use, while dependency
 * edges enforce at least one actor slot between ordered actions.
 */
export class PlanExecutionGraph {
	private readonly plans = new Map<string, Map<string, MutableNode>>();

	upsert(
		plan: MaterializedPlan,
		actions: readonly PlanAction[],
		anchorActionSeq: number,
	): readonly PlanExecutionNode[] {
		const nodes = this.plans.get(plan.id) ?? new Map<string, MutableNode>();
		this.plans.set(plan.id, nodes);
		const anchor = sequence(anchorActionSeq);
		for (const action of actions) {
			const current = nodes.get(action.id);
			if (current) {
				current.source = plan.source;
				current.revision = plan.revision;
				current.action = action;
				if (current.state === "deferred") current.anchorActionSeq = anchor;
				continue;
			}
			nodes.set(action.id, {
				proposalID: plan.id,
				source: plan.source,
				revision: plan.revision,
				action,
				anchorActionSeq: anchor,
				expectedActionSeq: anchor + horizon(action) + 1,
				launchActionSeq: anchor + horizon(action),
				state: "deferred",
				blockedReported: false,
			});
		}
		this.recompute(plan.id);
		this.blockImpossible(plan.id);
		return actions.flatMap((action) => {
			const node = nodes.get(action.id);
			return node ? [snapshot(node)] : [];
		});
	}

	remove(proposalID: string, actionIDs: readonly string[]): readonly PlanExecutionNode[] {
		const nodes = this.plans.get(proposalID);
		if (!nodes) return [];
		const removed: PlanExecutionNode[] = [];
		for (const actionID of actionIDs) {
			const node = nodes.get(actionID);
			if (!node) continue;
			removed.push(snapshot(node));
			nodes.delete(actionID);
		}
		if (!nodes.size) this.plans.delete(proposalID);
		else {
			this.recompute(proposalID);
			this.blockImpossible(proposalID);
		}
		return removed;
	}

	takeReady(actionSequence: number): readonly PlanExecutionNode[] {
		const settledSequence = sequence(actionSequence);
		for (const proposalID of this.plans.keys()) this.blockImpossible(proposalID);
		const ready = this.mutableValues()
			.filter(
				(node) =>
					node.state === "deferred" && node.launchActionSeq <= settledSequence && this.dependenciesSatisfied(node),
			)
			.sort(
				(left, right) =>
					left.launchActionSeq - right.launchActionSeq ||
					left.expectedActionSeq - right.expectedActionSeq ||
					left.proposalID.localeCompare(right.proposalID) ||
					left.action.id.localeCompare(right.action.id),
			);
		for (const node of ready) node.state = "launching";
		return ready.map(snapshot);
	}

	promote(proposalID: string, actionID: string): PlanPromotion {
		const node = this.mutable(proposalID, actionID);
		if (!node) return { status: "missing" };
		this.blockImpossible(proposalID);
		if (node.state === "blocked" || terminal(node.state)) return { status: "terminal" };
		if (node.state !== "deferred") return { status: "active" };
		if (!this.dependenciesSatisfied(node)) return { status: "waiting" };
		node.state = "launching";
		return { status: "claimed", node: snapshot(node) };
	}

	markRunning(proposalID: string, actionID: string): void {
		const node = this.mutable(proposalID, actionID);
		if (node?.state === "launching") node.state = "running";
	}

	defer(proposalID: string, actionID: string): void {
		const node = this.mutable(proposalID, actionID);
		if (node?.state === "launching") node.state = "deferred";
	}

	markSucceeded(proposalID: string, actionID: string): void {
		const node = this.mutable(proposalID, actionID);
		if (!node || node.state === "adopted") return;
		if (node.state === "launching" || node.state === "running") node.state = "succeeded";
		this.blockImpossible(proposalID);
	}

	markAdopted(proposalID: string, actionID: string, actionSequence?: number): void {
		const node = this.mutable(proposalID, actionID);
		if (!node || node.state === "blocked") return;
		if (actionSequence !== undefined) node.resolvedActionSeq = sequence(actionSequence);
		node.state = "adopted";
		this.recompute(proposalID);
		this.blockImpossible(proposalID);
	}

	markFailed(proposalID: string, actionID: string): void {
		const node = this.mutable(proposalID, actionID);
		if (!node || node.state === "adopted" || node.state === "blocked") return;
		node.state = "failed";
		this.blockImpossible(proposalID);
	}

	get(proposalID: string, actionID: string): PlanExecutionNode | undefined {
		const node = this.mutable(proposalID, actionID);
		return node ? snapshot(node) : undefined;
	}

	canAdopt(proposalID: string, actionID: string): boolean {
		const node = this.mutable(proposalID, actionID);
		return Boolean(node && node.state !== "adopted" && node.state !== "blocked" && this.dependenciesSatisfied(node));
	}

	values(): readonly PlanExecutionNode[] {
		return this.mutableValues().map(snapshot);
	}

	deferred(): readonly PlanExecutionNode[] {
		return this.mutableValues()
			.filter((node) => node.state === "deferred")
			.map(snapshot);
	}

	drainBlocked(): readonly PlanExecutionNode[] {
		for (const proposalID of this.plans.keys()) this.blockImpossible(proposalID);
		const blocked = this.mutableValues().filter((node) => node.state === "blocked" && !node.blockedReported);
		for (const node of blocked) node.blockedReported = true;
		return blocked.map(snapshot);
	}

	clear(): void {
		this.plans.clear();
	}

	private mutable(proposalID: string, actionID: string): MutableNode | undefined {
		return this.plans.get(proposalID)?.get(actionID);
	}

	private mutableValues(): MutableNode[] {
		return [...this.plans.values()].flatMap((nodes) => [...nodes.values()]);
	}

	private recompute(proposalID: string): void {
		const nodes = this.plans.get(proposalID);
		if (!nodes) return;
		const memo = new Map<string, number>();
		const visiting = new Set<string>();
		const expected = (node: MutableNode): number => {
			const cached = memo.get(node.action.id);
			if (cached !== undefined) return cached;
			if (visiting.has(node.action.id)) return node.anchorActionSeq + horizon(node.action) + 1;
			visiting.add(node.action.id);
			let value = node.resolvedActionSeq ?? node.anchorActionSeq + horizon(node.action) + 1;
			for (const dependency of node.action.dependsOn ?? []) {
				const parent = nodes.get(dependency.actionID);
				if (parent) value = Math.max(value, expected(parent) + 1);
			}
			visiting.delete(node.action.id);
			memo.set(node.action.id, value);
			return value;
		};
		for (const node of nodes.values()) {
			node.expectedActionSeq = expected(node);
			node.launchActionSeq = Math.max(node.anchorActionSeq, node.expectedActionSeq - 1);
		}
	}

	private dependenciesSatisfied(node: MutableNode): boolean {
		const nodes = this.plans.get(node.proposalID);
		if (!nodes) return false;
		return (node.action.dependsOn ?? []).every((dependency) => {
			const parent = nodes.get(dependency.actionID);
			return parent ? conditionSatisfied(parent.state, dependency.condition) : false;
		});
	}

	private blockImpossible(proposalID: string): void {
		const nodes = this.plans.get(proposalID);
		if (!nodes) return;
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of nodes.values()) {
				if (node.state !== "deferred") continue;
				const impossible = (node.action.dependsOn ?? []).some((dependency) => {
					const parent = nodes.get(dependency.actionID);
					return !parent || conditionImpossible(parent.state, dependency.condition);
				});
				if (!impossible) continue;
				node.state = "blocked";
				changed = true;
			}
		}
	}
}

function snapshot(node: MutableNode): PlanExecutionNode {
	return Object.freeze({
		proposalID: node.proposalID,
		source: node.source,
		revision: node.revision,
		action: node.action,
		anchorActionSeq: node.anchorActionSeq,
		expectedActionSeq: node.expectedActionSeq,
		launchActionSeq: node.launchActionSeq,
		state: node.state,
	});
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

function sequence(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
