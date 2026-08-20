import type { SpeculativeExecution } from "./action-semantics.ts";
import type { WorldCompatibilityEvidence } from "./execution-world.ts";
import type {
	SpeculativeResourceBudget,
	SpeculativeResourceClass,
	SpeculativeResourceProfile,
} from "./resource-budget.ts";
import { resourceProfile, speculativeResourceBudget } from "./resource-budget.ts";

export interface PredictionForecast {
	readonly tool: string;
	readonly execution: SpeculativeExecution;
	readonly expectedDurationMs?: number;
	readonly resourceDemand?: number;
	readonly decisionBatchesUntilCall?: number;
	readonly sourceLatencyMs?: number;
	readonly criticalPathMs?: number;
	readonly expectedLatencyBenefitMs?: number;
}

export interface ScheduledWork {
	readonly expectedDurationMs: number;
	readonly resource: SpeculativeResourceProfile;
	readonly decisionBatchesUntilCall: number;
	readonly criticalPathMs: number;
	readonly priorityMs: number;
}

export type SchedulerAdmission =
	| { readonly admitted: true; readonly work: ScheduledWork }
	| {
			readonly admitted: false;
			readonly work: ScheduledWork;
			readonly reason: "budget_exhausted";
	  };

export type WorldCompatibilityDecision =
	| { readonly compatible: true }
	| {
			readonly compatible: false;
			readonly code: "backend_incompatible" | "backend_indeterminate" | "execution_fingerprint_changed";
			readonly detail?: string;
	  };

interface SchedulerEntry<Job> {
	readonly job: Job;
	work: ScheduledWork;
	readonly sequence: number;
}

/** Owns forecast aggregation, timing observations, capacity, and preemption. */
export class SpeculationScheduler<Job extends object> {
	private readonly entries = new Map<Job, SchedulerEntry<Job>>();
	private readonly serviceTimes = new Map<string, SampleWindow>();
	private readonly actorDecisionIntervals = new SampleWindow();
	private sequence = 0;

	admit(
		job: Job,
		forecasts: readonly PredictionForecast[],
		capacity: number | SpeculativeResourceBudget,
	): SchedulerAdmission {
		const work = this.evaluate(forecasts);
		const budget = normalizeBudget(capacity);
		if (!fits([...this.entries.values()], work.resource, budget)) {
			return { admitted: false, work, reason: "budget_exhausted" };
		}
		this.entries.set(job, { job, work, sequence: this.sequence++ });
		return { admitted: true, work };
	}

	refresh(job: Job, forecasts: readonly PredictionForecast[]): ScheduledWork | undefined {
		const entry = this.entries.get(job);
		if (!entry) return undefined;
		entry.work = this.evaluate(forecasts);
		return entry.work;
	}

	complete(job: Job): boolean {
		return this.entries.delete(job);
	}

	discard(job: Job): boolean {
		return this.entries.delete(job);
	}

	preemptForAuthoritative(
		resource: SpeculativeResourceProfile,
		capacity: number | SpeculativeResourceBudget,
		canPreempt: (job: Job) => boolean = () => true,
	): readonly Job[] {
		const budget = normalizeBudget(capacity);
		const remaining = [...this.entries.values()];
		const victims: SchedulerEntry<Job>[] = [];
		while (
			!fits(
				remaining.filter((entry) => !victims.includes(entry)),
				resource,
				budget,
			)
		) {
			const victim = remaining
				.filter((entry) => !victims.includes(entry) && canPreempt(entry.job))
				.sort(compareVictim)[0];
			if (!victim) break;
			victims.push(victim);
		}
		for (const victim of victims) this.entries.delete(victim.job);
		return victims.map((entry) => entry.job);
	}

	evaluate(forecasts: readonly PredictionForecast[]): ScheduledWork {
		if (forecasts.length === 0) return emptyWork();
		const evaluated = forecasts.map((forecast) => this.evaluateOne(forecast));
		const resource = evaluated.reduce(
			(current, item) => mergeResource(current, item.resource),
			evaluated[0]!.resource,
		);
		return {
			expectedDurationMs: Math.max(...evaluated.map((item) => item.expectedDurationMs)),
			resource,
			decisionBatchesUntilCall: Math.min(...evaluated.map((item) => item.decisionBatchesUntilCall)),
			criticalPathMs: Math.max(...evaluated.map((item) => item.criticalPathMs)),
			priorityMs: Math.max(...evaluated.map((item) => item.priorityMs)),
		};
	}

	launchDelay(forecast: PredictionForecast, safetyMarginMs = 10): number {
		const decisionBatchesUntilCall = sequence(forecast.decisionBatchesUntilCall);
		if (decisionBatchesUntilCall <= 1) return 0;
		const duration = this.duration(forecast, 0.9);
		const actorDecisionMs = this.actorDecisionIntervals.quantile(0.25, Math.max(50, duration * 2));
		return Math.max(
			0,
			decisionBatchesUntilCall * actorDecisionMs -
				duration -
				finite(forecast.sourceLatencyMs) -
				finite(safetyMarginMs),
		);
	}

	assessCompatibility(
		evidence: WorldCompatibilityEvidence,
		actorExecutionFingerprint: string,
	): WorldCompatibilityDecision {
		if (evidence.status !== "compatible") {
			return {
				compatible: false,
				code: evidence.status === "incompatible" ? "backend_incompatible" : "backend_indeterminate",
				detail: evidence.detail ?? evidence.code,
			};
		}
		return evidence.executionFingerprint === actorExecutionFingerprint
			? { compatible: true }
			: { compatible: false, code: "execution_fingerprint_changed" };
	}

	observeActorDecisionInterval(durationMs: number): void {
		this.actorDecisionIntervals.observe(durationMs);
	}

	observeService(tool: string, durationMs: number): void {
		const samples = this.serviceTimes.get(tool) ?? new SampleWindow();
		samples.observe(durationMs);
		this.serviceTimes.set(tool, samples);
	}

	snapshot(): readonly { readonly job: Job; readonly work: ScheduledWork }[] {
		return [...this.entries.values()]
			.sort((left, right) => left.sequence - right.sequence)
			.map(({ job, work }) => ({ job, work }));
	}

	private evaluateOne(forecast: PredictionForecast): ScheduledWork {
		const expectedDurationMs = this.duration(forecast);
		const baseResource = resourceProfile(forecast.execution);
		const resource = {
			class: baseResource.class,
			units: Math.max(baseResource.units, units(forecast.resourceDemand)),
		};
		const criticalPathMs = Math.max(expectedDurationMs, finite(forecast.criticalPathMs));
		return {
			expectedDurationMs,
			resource,
			decisionBatchesUntilCall: sequence(forecast.decisionBatchesUntilCall),
			criticalPathMs,
			priorityMs:
				forecast.expectedLatencyBenefitMs === undefined
					? criticalPathMs
					: finite(forecast.expectedLatencyBenefitMs),
		};
	}

	private duration(forecast: PredictionForecast, quantile = 0.5): number {
		return (
			this.serviceTimes.get(forecast.tool)?.quantile(quantile, positive(forecast.expectedDurationMs, 1)) ??
			positive(forecast.expectedDurationMs, 1)
		);
	}
}

class SampleWindow {
	private readonly values: number[] = [];

	observe(value: number): void {
		const normalized = finite(value);
		if (normalized <= 0) return;
		this.values.push(normalized);
		if (this.values.length > 64) this.values.shift();
	}

	quantile(value: number, fallback: number): number {
		if (!this.values.length) return positive(fallback, 1);
		const sorted = [...this.values].sort((left, right) => left - right);
		return sorted[Math.floor((sorted.length - 1) * Math.max(0, Math.min(1, value)))]!;
	}
}

function emptyWork(): ScheduledWork {
	return {
		expectedDurationMs: 0,
		resource: { class: "filesystem", units: 1 },
		decisionBatchesUntilCall: 0,
		criticalPathMs: 0,
		priorityMs: 0,
	};
}

function compareVictim<Job>(left: SchedulerEntry<Job>, right: SchedulerEntry<Job>): number {
	return (
		right.work.decisionBatchesUntilCall - left.work.decisionBatchesUntilCall ||
		left.work.priorityMs - right.work.priorityMs ||
		left.work.criticalPathMs - right.work.criticalPathMs ||
		right.sequence - left.sequence
	);
}

function normalizeBudget(capacity: number | SpeculativeResourceBudget): SpeculativeResourceBudget {
	return typeof capacity === "number" ? speculativeResourceBudget(capacity) : capacity;
}

function mergeResource(
	left: SpeculativeResourceProfile,
	right: SpeculativeResourceProfile,
): SpeculativeResourceProfile {
	return {
		class: left.class === right.class ? left.class : "global",
		units: Math.max(left.units, right.units),
	};
}

function fits<Job>(
	entries: readonly SchedulerEntry<Job>[],
	incoming: SpeculativeResourceProfile,
	budget: SpeculativeResourceBudget,
): boolean {
	if (totalUnits(entries) + incoming.units > budget.total) return false;
	for (const resourceClass of resourceClasses()) {
		const incomingUnits = incoming.class === resourceClass || incoming.class === "global" ? incoming.units : 0;
		if (classUnits(entries, resourceClass) + incomingUnits > budget.classes[resourceClass]) return false;
	}
	return true;
}

function totalUnits<Job>(entries: readonly SchedulerEntry<Job>[]): number {
	return entries.reduce((total, entry) => total + entry.work.resource.units, 0);
}

function classUnits<Job>(entries: readonly SchedulerEntry<Job>[], resourceClass: SpeculativeResourceClass): number {
	return entries.reduce(
		(total, entry) =>
			total +
			(entry.work.resource.class === resourceClass || entry.work.resource.class === "global"
				? entry.work.resource.units
				: 0),
		0,
	);
}

function resourceClasses(): readonly SpeculativeResourceClass[] {
	return ["filesystem", "workspace", "process", "global"];
}

function units(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function finite(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function positive(value: number | undefined, fallback: number): number {
	const normalized = finite(value);
	return normalized > 0 ? normalized : Math.max(1, finite(fallback));
}

function sequence(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
