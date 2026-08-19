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
	readonly sandboxMode: "none" | "workspace_snapshot" | "file_mutation";
	readonly probability?: number;
	readonly expectedDurationMs?: number;
	readonly expectedLatencyBenefitMs?: number;
	readonly resourceDemand?: number;
}

export interface ScheduledWork {
	readonly expectedDurationMs: number;
	readonly expectedBenefitMs: number;
	readonly resource: SpeculativeResourceProfile;
	readonly utility: number;
}

export type SchedulerAdmission<Job> =
	| { readonly admitted: true; readonly work: ScheduledWork; readonly preempted: readonly Job[] }
	| {
			readonly admitted: false;
			readonly work: ScheduledWork;
			readonly reason: "insufficient_expected_benefit" | "budget_exhausted";
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
	private readonly serviceTimes = new Map<string, Average>();
	private actorStep = emptyAverage();
	private sequence = 0;

	admit(
		job: Job,
		forecasts: readonly PredictionForecast[],
		capacity: number | SpeculativeResourceBudget,
	): SchedulerAdmission<Job> {
		const work = this.evaluate(forecasts);
		if (work.utility <= 0) return { admitted: false, work, reason: "insufficient_expected_benefit" };
		const budget = normalizeBudget(capacity);
		const remaining = [...this.entries.values()];
		const victims: SchedulerEntry<Job>[] = [];
		if (!fits(remaining, work.resource, budget)) {
			for (const entry of [...remaining].sort(compareEntry)) {
				if (entry.work.utility >= work.utility) break;
				victims.push(entry);
				const retained = remaining.filter((candidate) => !victims.includes(candidate));
				if (fits(retained, work.resource, budget)) break;
			}
		}
		const retained = remaining.filter((entry) => !victims.includes(entry));
		if (!fits(retained, work.resource, budget)) return { admitted: false, work, reason: "budget_exhausted" };
		for (const victim of victims) this.entries.delete(victim.job);
		this.entries.set(job, { job, work, sequence: this.sequence++ });
		return { admitted: true, work, preempted: victims.map((entry) => entry.job) };
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
				.sort(compareEntry)[0];
			if (!victim) break;
			victims.push(victim);
		}
		for (const victim of victims) this.entries.delete(victim.job);
		return victims.map((entry) => entry.job);
	}

	evaluate(forecasts: readonly PredictionForecast[]): ScheduledWork {
		if (forecasts.length === 0) return emptyWork();
		const evaluated = forecasts.map((forecast) => this.evaluateOne(forecast));
		return evaluated.reduce((best, current) => (current.utility > best.utility ? current : best));
	}

	launchDelay(forecast: PredictionForecast, stepsUntilCall: number, safetyMarginMs = 10): number {
		const duration = this.duration(forecast);
		if (stepsUntilCall <= 1) return 0;
		const averageStepMs = this.actorStep.count > 0 ? this.actorStep.average : Math.max(50, duration * 2);
		return Math.max(0, finite(stepsUntilCall) * averageStepMs - duration - finite(safetyMarginMs));
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

	observeActorStep(durationMs: number): void {
		this.actorStep = observe(this.actorStep, durationMs);
	}

	observeService(tool: string, durationMs: number): void {
		this.serviceTimes.set(tool, observe(this.serviceTimes.get(tool) ?? emptyAverage(), durationMs));
	}

	snapshot(): readonly { readonly job: Job; readonly work: ScheduledWork }[] {
		return [...this.entries.values()]
			.sort((left, right) => left.sequence - right.sequence)
			.map(({ job, work }) => ({ job, work }));
	}

	private evaluateOne(forecast: PredictionForecast): ScheduledWork {
		const expectedDurationMs = this.duration(forecast);
		const probability = finiteProbability(forecast.probability, 1);
		const expectedBenefitMs = Math.min(
			expectedDurationMs,
			forecast.expectedLatencyBenefitMs === undefined
				? probability * expectedDurationMs
				: finite(forecast.expectedLatencyBenefitMs),
		);
		const baseResource = resourceProfile(forecast.execution, forecast.sandboxMode);
		const resource = {
			class: baseResource.class,
			units: Math.max(baseResource.units, units(forecast.resourceDemand)),
		};
		return {
			expectedDurationMs,
			expectedBenefitMs,
			resource,
			utility: expectedBenefitMs,
		};
	}

	private duration(forecast: PredictionForecast): number {
		return positive(forecast.expectedDurationMs, this.serviceTimes.get(forecast.tool)?.average ?? 1);
	}
}

interface Average {
	readonly count: number;
	readonly average: number;
}

function emptyAverage(): Average {
	return { count: 0, average: 0 };
}

function observe(current: Average, value: number): Average {
	const next = finite(value);
	const count = current.count + 1;
	return { count, average: current.average + (next - current.average) / count };
}

function emptyWork(): ScheduledWork {
	return {
		expectedDurationMs: 0,
		expectedBenefitMs: 0,
		resource: { class: "filesystem", units: 1 },
		utility: 0,
	};
}

function compareEntry<Job>(left: SchedulerEntry<Job>, right: SchedulerEntry<Job>): number {
	return left.work.utility - right.work.utility || left.sequence - right.sequence;
}

function normalizeBudget(capacity: number | SpeculativeResourceBudget): SpeculativeResourceBudget {
	return typeof capacity === "number" ? speculativeResourceBudget(capacity) : capacity;
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

function finiteProbability(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}
