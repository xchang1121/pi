import type { SpeculativeExecution } from "./action-semantics.ts";

export type SpeculativeResourceClass = "filesystem" | "workspace" | "process" | "global";

export interface SpeculativeResourceProfile {
	readonly class: SpeculativeResourceClass;
	readonly units: number;
}

export interface SpeculativeResourceBudget {
	readonly total: number;
	readonly classes: Readonly<Record<SpeculativeResourceClass, number>>;
}

export function speculativeResourceBudget(capacity: number): SpeculativeResourceBudget {
	const total = units(capacity);
	return {
		total,
		classes: { filesystem: total, workspace: total, process: total, global: total },
	};
}

export function resourceProfile(execution: SpeculativeExecution): SpeculativeResourceProfile {
	if (execution === "resource_snapshot") return { class: "filesystem", units: 1 };
	if (execution === "file_mutation") return { class: "workspace", units: 1 };
	return { class: "global", units: 1 };
}

function units(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
