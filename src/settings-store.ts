import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SpeculativeAgentSettingsInput } from "./agent-integration.ts";

export interface SpeculativeActionPackageSettings extends SpeculativeAgentSettingsInput {
	readonly draftModel?: string;
	readonly isolation?: {
		readonly backend?: "auto" | "container" | "native";
		readonly runtime?: "auto" | "docker" | "podman";
		readonly image?: string;
		readonly guestShell?: string;
	};
}

export type SpeculativeSettingsScope = "global" | "project";

/** Extension-owned configuration; Pi's settings schema remains untouched. */
export class SpeculativeActionSettingsStore {
	private global: SpeculativeActionPackageSettings | undefined;
	private project: SpeculativeActionPackageSettings | undefined;
	private scopeValue: SpeculativeSettingsScope = "global";
	private writeQueue = Promise.resolve();

	readonly cwd: string;
	readonly agentDirectory: string;

	constructor(cwd: string, agentDirectory = getAgentDir()) {
		this.cwd = cwd;
		this.agentDirectory = agentDirectory;
	}

	async load(): Promise<void> {
		[this.global, this.project] = await Promise.all([readSettings(this.globalPath), readSettings(this.projectPath)]);
		this.scopeValue = this.project ? "project" : "global";
	}

	get scope(): SpeculativeSettingsScope {
		return this.scopeValue;
	}

	setScope(scope: SpeculativeSettingsScope): void {
		this.scopeValue = scope;
	}

	get(): SpeculativeActionPackageSettings | undefined {
		return mergeSettings(this.global, this.project);
	}

	set(value: SpeculativeActionPackageSettings | undefined): void {
		if (this.scopeValue === "project") this.project = clone(value);
		else this.global = clone(value);
		const target = this.scopeValue === "project" ? this.projectPath : this.globalPath;
		const snapshot = clone(value);
		this.writeQueue = this.writeQueue.then(() => writeSettings(target, snapshot));
	}

	flush(): Promise<void> {
		return this.writeQueue;
	}

	private get globalPath(): string {
		return path.join(this.agentDirectory, "speculative-action.json");
	}

	private get projectPath(): string {
		return path.join(this.cwd, ".pi", "speculative-action.json");
	}
}

async function readSettings(file: string): Promise<SpeculativeActionPackageSettings | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		return isRecord(parsed) ? (parsed as SpeculativeActionPackageSettings) : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

async function writeSettings(file: string, value: SpeculativeActionPackageSettings | undefined): Promise<void> {
	if (!value) {
		await rm(file, { force: true });
		return;
	}
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporary, file);
}

function mergeSettings(
	global: SpeculativeActionPackageSettings | undefined,
	project: SpeculativeActionPackageSettings | undefined,
): SpeculativeActionPackageSettings | undefined {
	if (!global) return clone(project);
	if (!project) return clone(global);
	return {
		...global,
		...project,
		patternAware: { ...global.patternAware, ...project.patternAware },
		tools: { ...global.tools, ...project.tools },
		isolation: { ...global.isolation, ...project.isolation },
	};
}

function clone<T>(value: T | undefined): T | undefined {
	return value === undefined ? undefined : structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
