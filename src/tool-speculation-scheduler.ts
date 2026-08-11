import type { SandboxActionMode, SpeculativeExecution } from "./action-semantics.ts";

export type SpeculativeResourceClass = "filesystem" | "workspace" | "process" | "global";

export type SpeculativeResourceProfile = {
	readonly class: SpeculativeResourceClass;
	readonly units: number;
};

export type SpeculativeResourceBudget = {
	readonly total: number;
	readonly classes: Readonly<Record<SpeculativeResourceClass, number>>;
};

export type SpeculativeSchedulingMetadata = {
	readonly expectedDurationMs: number;
	readonly expectedLeadMs?: number;
	readonly expectedBenefitMs: number;
	readonly overheadCostMs?: number;
	readonly resource: SpeculativeResourceProfile;
};

export type SpeculativeSchedulerEntry<Job> = {
	readonly job: Job;
	readonly metadata: SpeculativeSchedulingMetadata;
	readonly utility: number;
	readonly sequence: number;
};

export type SpeculativeAdmission<Job> =
	| { readonly admitted: true; readonly preempted: ReadonlyArray<Job>; readonly utility: number }
	| { readonly admitted: false; readonly reason: "budget_exhausted" | "insufficient_expected_benefit" };

export class ToolSpeculationScheduler<Job extends object> {
	private readonly running = new Map<Job, SpeculativeSchedulerEntry<Job>>();
	private sequence = 0;

	admit(
		job: Job,
		metadata: SpeculativeSchedulingMetadata,
		capacity: number | SpeculativeResourceBudget,
	): SpeculativeAdmission<Job> {
		const normalized = normalizeMetadata(metadata);
		const utility = expectedUtility(normalized);
		if (utility <= 0) {
			return { admitted: false, reason: "insufficient_expected_benefit" };
		}
		const budget = normalizeBudget(capacity);
		const victims: SpeculativeSchedulerEntry<Job>[] = [];
		let remaining = [...this.running.values()];
		if (!fits(remaining, normalized.resource, budget)) {
			for (const entry of this.lowestUtility()) {
				if (entry.utility >= utility) break;
				if (!helpsFit(remaining, entry, normalized.resource, budget)) continue;
				victims.push(entry);
				remaining = remaining.filter((item) => item !== entry);
				if (fits(remaining, normalized.resource, budget)) break;
			}
			if (!fits(remaining, normalized.resource, budget)) return { admitted: false, reason: "budget_exhausted" };
		}
		for (const victim of victims) this.running.delete(victim.job);
		this.running.set(job, { job, metadata: normalized, utility, sequence: ++this.sequence });
		return { admitted: true, preempted: victims.map((entry) => entry.job), utility };
	}

	complete(job: Job) {
		this.running.delete(job);
	}

	update(job: Job, metadata: SpeculativeSchedulingMetadata) {
		const current = this.running.get(job);
		if (!current) return false;
		const normalized = normalizeMetadata(metadata);
		this.running.set(job, { ...current, metadata: normalized, utility: expectedUtility(normalized) });
		return true;
	}

	discard(job: Job) {
		this.running.delete(job);
	}

	promote(job: Job) {
		return this.running.delete(job);
	}

	preemptForAuthoritative(
		resource: SpeculativeResourceProfile,
		capacity?: number | SpeculativeResourceBudget,
	): ReadonlyArray<Job> {
		if (capacity === undefined) {
			const required = normalizeUnits(resource.units);
			const ordered = this.lowestUtility();
			const conflicting = ordered.filter((entry) => conflicts(entry.metadata.resource, resource));
			const fallback = ordered.filter((entry) => !conflicting.includes(entry));
			const victims: SpeculativeSchedulerEntry<Job>[] = [];
			let reclaimed = 0;
			for (const entry of [...conflicting, ...fallback]) {
				victims.push(entry);
				reclaimed += entry.metadata.resource.units;
				if (reclaimed >= required) break;
			}
			for (const victim of victims) this.running.delete(victim.job);
			return victims.map((entry) => entry.job);
		}
		const requested = { class: resource.class, units: normalizeUnits(resource.units) };
		const budget = normalizeBudget(capacity);
		let remaining = [...this.running.values()];
		if (fits(remaining, requested, budget)) return [];
		const ordered = this.lowestUtility();
		const conflicting = ordered.filter((entry) => conflicts(entry.metadata.resource, resource));
		const fallback = ordered.filter((entry) => !conflicting.includes(entry));
		const victims: SpeculativeSchedulerEntry<Job>[] = [];
		for (const entry of [...conflicting, ...fallback]) {
			if (!helpsFit(remaining, entry, requested, budget)) continue;
			victims.push(entry);
			remaining = remaining.filter((item) => item !== entry);
			if (fits(remaining, requested, budget)) break;
		}
		for (const victim of victims) this.running.delete(victim.job);
		return victims.map((entry) => entry.job);
	}

	metadata(job: Job) {
		return this.running.get(job)?.metadata;
	}

	snapshot() {
		return this.lowestUtility().map((entry) => ({
			...entry,
			metadata: { ...entry.metadata, resource: { ...entry.metadata.resource } },
		}));
	}

	private lowestUtility() {
		return [...this.running.values()].sort(
			(left, right) => left.utility - right.utility || left.sequence - right.sequence,
		);
	}
}

export function speculativeResourceBudget(capacity: number): SpeculativeResourceBudget {
	const total = normalizeUnits(capacity);
	return {
		total,
		classes: {
			filesystem: total,
			workspace: total,
			process: total,
			global: total,
		},
	};
}

export function expectedUtility(metadata: SpeculativeSchedulingMetadata) {
	const normalized = normalizeMetadata(metadata);
	return (normalized.expectedBenefitMs - (normalized.overheadCostMs ?? 0)) / normalized.resource.units;
}

export function resourceProfile(
	execution: SpeculativeExecution,
	sandboxMode?: SandboxActionMode,
): SpeculativeResourceProfile {
	if (execution === "resource_cached") return { class: "filesystem", units: 1 };
	if (sandboxMode === "workspace_snapshot") return { class: "process", units: 1 };
	if (sandboxMode === "file_mutation") return { class: "workspace", units: 1 };
	return { class: "global", units: 1 };
}

function normalizeMetadata(metadata: SpeculativeSchedulingMetadata): SpeculativeSchedulingMetadata {
	const expectedDurationMs = Math.max(0, finite(metadata.expectedDurationMs));
	const expectedLeadMs =
		metadata.expectedLeadMs === undefined
			? undefined
			: Math.min(expectedDurationMs, Math.max(0, finite(metadata.expectedLeadMs)));
	const expectedBenefitMs = Math.min(expectedDurationMs, Math.max(0, finite(metadata.expectedBenefitMs)));
	const overheadCostMs = Math.max(0, finite(metadata.overheadCostMs ?? 0));
	return {
		expectedDurationMs,
		...(expectedLeadMs !== undefined ? { expectedLeadMs } : {}),
		expectedBenefitMs,
		overheadCostMs,
		resource: { class: metadata.resource.class, units: normalizeUnits(metadata.resource.units) },
	};
}

function conflicts(left: SpeculativeResourceProfile, right: SpeculativeResourceProfile) {
	return left.class === "global" || right.class === "global" || left.class === right.class;
}

function normalizeBudget(value: number | SpeculativeResourceBudget): SpeculativeResourceBudget {
	if (typeof value === "number") {
		const total = normalizeUnits(value);
		return {
			total,
			classes: { filesystem: total, workspace: total, process: total, global: total },
		};
	}
	return {
		total: normalizeUnits(value.total),
		classes: {
			filesystem: normalizeUnits(value.classes.filesystem),
			workspace: normalizeUnits(value.classes.workspace),
			process: normalizeUnits(value.classes.process),
			global: normalizeUnits(value.classes.global),
		},
	};
}

function fits<Job>(
	entries: ReadonlyArray<SpeculativeSchedulerEntry<Job>>,
	requested: SpeculativeResourceProfile,
	budget: SpeculativeResourceBudget,
) {
	if (units(entries) + requested.units > budget.total) return false;
	if (requested.class === "global") {
		return (Object.keys(budget.classes) as SpeculativeResourceClass[]).every(
			(resourceClass) => classUnits(entries, resourceClass) + requested.units <= budget.classes[resourceClass],
		);
	}
	return classUnits(entries, requested.class) + requested.units <= budget.classes[requested.class];
}

function helpsFit<Job>(
	entries: ReadonlyArray<SpeculativeSchedulerEntry<Job>>,
	candidate: SpeculativeSchedulerEntry<Job>,
	requested: SpeculativeResourceProfile,
	budget: SpeculativeResourceBudget,
) {
	const remaining = entries.filter((entry) => entry !== candidate);
	if (units(entries) + requested.units > budget.total) return true;
	if (requested.class === "global") {
		return (Object.keys(budget.classes) as SpeculativeResourceClass[]).some(
			(resourceClass) =>
				classUnits(entries, resourceClass) + requested.units > budget.classes[resourceClass] &&
				classUnits(remaining, resourceClass) < classUnits(entries, resourceClass),
		);
	}
	return (
		classUnits(entries, requested.class) + requested.units > budget.classes[requested.class] &&
		classUnits(remaining, requested.class) < classUnits(entries, requested.class)
	);
}

function units<Job>(entries: ReadonlyArray<SpeculativeSchedulerEntry<Job>>) {
	return entries.reduce((total, entry) => total + entry.metadata.resource.units, 0);
}

function classUnits<Job>(
	entries: ReadonlyArray<SpeculativeSchedulerEntry<Job>>,
	resourceClass: SpeculativeResourceClass,
) {
	return entries.reduce(
		(total, entry) =>
			total +
			(entry.metadata.resource.class === resourceClass || entry.metadata.resource.class === "global"
				? entry.metadata.resource.units
				: 0),
		0,
	);
}

function normalizeUnits(value: number) {
	return Math.max(1, Math.floor(finite(value)));
}

function finite(value: number) {
	return Number.isFinite(value) ? value : 0;
}
