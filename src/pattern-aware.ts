import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type PatternAwareSettings = {
	readonly enabled: boolean;
	readonly maxContextLength: number;
	readonly maxFutureGap: number;
	readonly minOccurrences: number;
	readonly minEmpiricalProbability: number;
	readonly maxPatterns: number;
};

export type PatternAwareEventSignature = {
	readonly tool: string;
	readonly outcome: "success" | "failure";
	readonly operation?: string;
};

export type PatternAwareEventInput = {
	readonly sessionID: string;
	readonly turnID: string;
	readonly tool: string;
	readonly input: Record<string, unknown>;
	readonly actionKey: string;
	readonly outcome: "success" | "failure";
	readonly output?: unknown;
	readonly outputPaths?: ReadonlyArray<string>;
	readonly durationMs: number;
	readonly operation?: string;
	readonly schemaHash?: string;
	readonly learnTarget?: boolean;
};

export type PatternAwareEvent = PatternAwareEventInput & {
	readonly sequence: number;
};

export type PatternAwarePath = ReadonlyArray<string | number>;

export type PatternAwareBinding =
	| {
			readonly type: "event";
			readonly relativeEvent: number;
			readonly field: "input" | "output" | "outputPaths";
			readonly path: PatternAwarePath;
	  }
	| {
			readonly type: "constant";
			readonly value: unknown;
	  }
	| {
			readonly type: "transform";
			readonly operation: "dirname" | "basename" | "normalize_path" | "trim" | "lowercase" | "uppercase";
			readonly source: PatternAwareBinding;
	  }
	| {
			readonly type: "coalesce";
			readonly sources: ReadonlyArray<PatternAwareBinding>;
	  }
	| {
			readonly type: "template";
			readonly source: PatternAwareBinding;
			readonly prefix: string;
			readonly suffix: string;
	  };

export type PatternAwarePattern = {
	readonly id: string;
	readonly context: ReadonlyArray<PatternAwareEventSignature>;
	readonly targetTool: string;
	readonly bindings: Readonly<Record<string, PatternAwareBinding>>;
	readonly targetSchemaHash?: string;
	readonly gapCounts: Readonly<Record<string, number>>;
	readonly occurrences: number;
	readonly replayMatches: number;
	readonly historicalOpportunities: number;
	readonly historicalMatches: number;
	readonly empiricalProbability: number;
	readonly opportunities: number;
	readonly consumed: number;
	readonly unused: number;
	readonly averageDurationMs: number;
	readonly lastSeenSequence: number;
};

export type PatternAwareCandidate = {
	readonly type: "tool_call" | "preparation_hint";
	readonly source: "pattern_aware";
	readonly tool: string;
	readonly input: Record<string, unknown>;
	readonly missing: ReadonlyArray<PatternAwarePath>;
	readonly patternID: string;
	readonly horizon: number;
	readonly empiricalProbability: number;
	readonly expectedDurationMs: number;
	readonly expectedLatencyBenefitMs: number;
	readonly resourceDemand: number;
	readonly diagnostic: string;
};

type MutablePattern = {
	id: string;
	context: PatternAwareEventSignature[];
	targetTool: string;
	bindings: Record<string, PatternAwareBinding>;
	targetSchemaHash?: string;
	gapCounts: Record<string, number>;
	occurrences: number;
	replayMatches: number;
	historicalOpportunities: number;
	historicalMatches: number;
	opportunities: number;
	consumed: number;
	unused: number;
	averageDurationMs: number;
	lastSeenSequence: number;
};

type PersistedState = {
	readonly version: number;
	readonly patterns: ReadonlyArray<PatternAwarePattern>;
};

type PatternSample = {
	readonly context: ReadonlyArray<PatternAwareEvent>;
	readonly target: PatternAwareEvent;
	readonly gap: number;
};

type PatternPool = {
	readonly key: string;
	readonly context: ReadonlyArray<PatternAwareEventSignature>;
	readonly targetTool: string;
	readonly targetSchemaHash?: string;
	readonly samples: PatternSample[];
};

type PendingValidation = {
	readonly patternID: string;
	readonly triggerSequence: number;
	readonly expectedInput?: Record<string, unknown>;
	remaining: number;
};

export const PATTERN_AWARE_DEFAULTS: PatternAwareSettings = {
	enabled: true,
	maxContextLength: 6,
	maxFutureGap: 8,
	minOccurrences: 2,
	minEmpiricalProbability: 0.75,
	maxPatterns: 4096,
};

export class PatternAwareStore {
	private readonly patterns = new Map<string, MutablePattern>();
	private readonly pools = new Map<string, PatternPool>();
	private readonly pending = new Map<string, PendingValidation[]>();
	private readonly history = new Map<string, PatternAwareEvent[]>();
	private readonly sequence = new Map<string, number>();
	private write: Promise<void> = Promise.resolve();
	private loaded = false;
	private settings: PatternAwareSettings;
	private readonly persistenceFile?: string;

	constructor(settings: PatternAwareSettings, persistenceFile?: string) {
		this.settings = settings;
		this.persistenceFile = persistenceFile;
	}

	configure(settings: PatternAwareSettings) {
		this.settings = settings;
		this.trimPatterns();
		this.trimPools();
		this.trimHistory();
	}

	async load() {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.persistenceFile) return;
		const parsed = await fs
			.readFile(this.persistenceFile, "utf8")
			.then((value) => JSON.parse(value) as PersistedState)
			.catch(() => undefined);
		if (!parsed || ![2, 3].includes(parsed.version) || !Array.isArray(parsed.patterns)) return;
		for (const item of parsed.patterns) {
			const pattern = mutablePattern(item);
			if (!pattern) continue;
			this.patterns.set(pattern.id, pattern);
		}
		this.trimPatterns();
	}

	observe(input: PatternAwareEventInput) {
		if (!this.settings.enabled) return [];
		const sequence = (this.sequence.get(input.sessionID) ?? 0) + 1;
		this.sequence.set(input.sessionID, sequence);
		const event: PatternAwareEvent = { ...input, sequence };
		const history = this.history.get(input.sessionID) ?? [];
		this.resolvePending(input.sessionID, event);
		if (input.learnTarget !== false) this.learn(history, event);
		history.push(event);
		this.history.set(input.sessionID, history);
		this.startPending(input.sessionID, history);
		this.trimSessionHistory(history);
		this.trimPools();
		this.trimPatterns();
		this.persist();
		return this.predict(input.sessionID);
	}

	observeTurn(input: {
		readonly sessionID: string;
		readonly turnID: string;
		readonly phase: "start" | "finish";
		readonly durationMs?: number;
		readonly terminal?: boolean;
		readonly agent?: string;
		readonly model?: string;
	}) {
		return this.observe({
			sessionID: input.sessionID,
			turnID: input.turnID,
			tool: "$llm",
			input: {
				phase: input.phase,
				...(input.agent ? { agent: input.agent } : {}),
				...(input.model ? { model: input.model } : {}),
				...(input.terminal !== undefined ? { terminal: input.terminal } : {}),
			},
			actionKey: `$llm:${input.turnID}:${input.phase}`,
			outcome: "success",
			durationMs: Math.max(0, input.durationMs ?? 0),
			operation: `turn_${input.phase}`,
			learnTarget: false,
		});
	}

	finishSession(sessionID: string) {
		const pending = this.pending.get(sessionID);
		for (const item of pending ?? []) this.recordValidation(item.patternID, false);
		this.pending.delete(sessionID);
		this.history.delete(sessionID);
		this.sequence.delete(sessionID);
		this.persist();
	}

	ingestTrace(trace: ReadonlyArray<PatternAwareEventInput>) {
		const sessions = new Set<string>();
		for (const event of trace) this.observe(event);
		for (const event of trace) sessions.add(event.sessionID);
		for (const sessionID of sessions) this.finishSession(sessionID);
	}

	registerValidatedPattern(input: PatternAwarePattern) {
		const pattern = mutablePattern(input);
		if (!pattern || !eligible(pattern, this.settings)) return false;
		this.patterns.set(pattern.id, pattern);
		this.trimPatterns();
		this.persist();
		return true;
	}

	predict(sessionID: string, schemaHashes: Readonly<Record<string, string>> = {}) {
		if (!this.settings.enabled) return [];
		const history = this.history.get(sessionID) ?? [];
		const result: PatternAwareCandidate[] = [];
		const seen = new Set<string>();
		for (const pattern of this.patterns.values()) {
			if (!eligible(pattern, this.settings)) continue;
			if (pattern.targetSchemaHash && schemaHashes[pattern.targetTool] !== pattern.targetSchemaHash) continue;
			if (!matchesSuffix(history, pattern.context)) continue;
			const context = history.slice(-pattern.context.length);
			const applied = applyBindingsPartial(pattern.bindings, context);
			const type = applied.missing.length ? "preparation_hint" : "tool_call";
			const identity = stableStringify({
				type,
				tool: pattern.targetTool,
				input: applied.input,
				missing: applied.missing,
			});
			if (seen.has(identity)) continue;
			seen.add(identity);
			const empiricalProbability = probability(pattern);
			const expectedDurationMs = Math.max(0, pattern.averageDurationMs);
			const expectedLatencyBenefitMs = empiricalProbability * expectedDurationMs;
			result.push({
				type,
				source: "pattern_aware",
				tool: pattern.targetTool,
				input: applied.input,
				missing: applied.missing,
				patternID: pattern.id,
				horizon: learnedHorizon(pattern, this.settings.maxFutureGap),
				empiricalProbability,
				expectedDurationMs,
				expectedLatencyBenefitMs,
				resourceDemand: 1,
				diagnostic: JSON.stringify(
					{
						source: "pattern_aware",
						patternID: pattern.id,
						context: pattern.context,
						tool: pattern.targetTool,
						input: applied.input,
						missing: applied.missing,
						empiricalProbability,
						expectedDurationMs,
						expectedLatencyBenefitMs,
					},
					null,
					2,
				),
			});
		}
		return result;
	}

	launched(patternID: string) {
		const pattern = this.patterns.get(patternID);
		if (!pattern) return;
		pattern.opportunities++;
		this.persist();
	}

	resolved(patternID: string, outcome: "consumed" | "unused") {
		const pattern = this.patterns.get(patternID);
		if (!pattern) return;
		pattern[outcome]++;
		this.persist();
	}

	snapshot(): ReadonlyArray<PatternAwarePattern> {
		return [...this.patterns.values()].map(readonlyPattern);
	}

	recent(sessionID: string): ReadonlyArray<PatternAwareEvent> {
		return [...(this.history.get(sessionID) ?? [])];
	}

	async flush() {
		await this.write;
	}

	private learn(history: ReadonlyArray<PatternAwareEvent>, target: PatternAwareEvent) {
		const maxGap = Math.min(this.settings.maxFutureGap, Math.max(0, history.length - 1));
		for (let gap = 0; gap <= maxGap; gap++) {
			const contextEnd = history.length - gap;
			const maxLength = Math.min(this.settings.maxContextLength, contextEnd);
			for (let length = 1; length <= maxLength; length++) {
				const context = history.slice(contextEnd - length, contextEnd);
				this.learnOccurrence(context, target, gap);
			}
		}
	}

	private learnOccurrence(context: ReadonlyArray<PatternAwareEvent>, target: PatternAwareEvent, gap: number) {
		const signatures = context.map(signature);
		const poolKey = hash(
			stableStringify({ context: signatures, targetTool: target.tool, targetSchemaHash: target.schemaHash }),
		);
		const pool = this.pools.get(poolKey) ?? {
			key: poolKey,
			context: signatures,
			targetTool: target.tool,
			...(target.schemaHash ? { targetSchemaHash: target.schemaHash } : {}),
			samples: [],
		};
		pool.samples.push({ context: [...context], target, gap });
		const sampleLimit = Math.max(this.settings.minOccurrences * 4, this.settings.maxContextLength * 4);
		if (pool.samples.length > sampleLimit) pool.samples.splice(0, pool.samples.length - sampleLimit);
		this.pools.set(poolKey, pool);
		if (pool.samples.length < this.settings.minOccurrences) return;
		const inferred = inferBindingsFromSamples(pool.samples);
		if (!inferred) return;
		const replayMatches = pool.samples.filter((sample) => {
			const concrete = applyBindings(inferred, sample.context);
			return concrete && stableStringify(concrete) === stableStringify(sample.target.input);
		}).length;
		const empiricalProbability = replayMatches / pool.samples.length;
		if (empiricalProbability < this.settings.minEmpiricalProbability) return;
		const id = hash(
			stableStringify({
				context: signatures,
				targetTool: target.tool,
				bindings: inferred,
				targetSchemaHash: target.schemaHash,
			}),
		);
		const existing = this.patterns.get(id);
		if (existing) {
			existing.occurrences = pool.samples.length;
			existing.replayMatches = replayMatches;
			existing.historicalOpportunities = Math.max(existing.historicalOpportunities, pool.samples.length);
			existing.historicalMatches = Math.max(existing.historicalMatches, replayMatches);
			existing.gapCounts[String(gap)] = (existing.gapCounts[String(gap)] ?? 0) + 1;
			existing.averageDurationMs +=
				(Math.max(0, target.durationMs) - existing.averageDurationMs) / Math.max(1, existing.occurrences);
			existing.lastSeenSequence = target.sequence;
			return;
		}
		this.patterns.set(id, {
			id,
			context: signatures,
			targetTool: target.tool,
			bindings: inferred,
			...(target.schemaHash ? { targetSchemaHash: target.schemaHash } : {}),
			gapCounts: { [String(gap)]: 1 },
			occurrences: pool.samples.length,
			replayMatches,
			historicalOpportunities: pool.samples.length,
			historicalMatches: replayMatches,
			opportunities: 0,
			consumed: 0,
			unused: 0,
			averageDurationMs: Math.max(0, target.durationMs),
			lastSeenSequence: target.sequence,
		});
	}

	private resolvePending(sessionID: string, event: PatternAwareEvent) {
		const pending = this.pending.get(sessionID);
		if (!pending?.length) return;
		const remaining: PendingValidation[] = [];
		for (const item of pending) {
			const pattern = this.patterns.get(item.patternID);
			if (!pattern) continue;
			const sameTarget = event.tool === pattern.targetTool;
			const matched = sameTarget && item.expectedInput !== undefined && sameValue(item.expectedInput, event.input);
			if (matched) {
				this.recordValidation(item.patternID, true);
				continue;
			}
			if (sameTarget || item.remaining <= 0) {
				this.recordValidation(item.patternID, false);
				continue;
			}
			item.remaining--;
			remaining.push(item);
		}
		if (remaining.length) this.pending.set(sessionID, remaining);
		else this.pending.delete(sessionID);
	}

	private startPending(sessionID: string, history: ReadonlyArray<PatternAwareEvent>) {
		const pending = this.pending.get(sessionID) ?? [];
		const triggerSequence = history.at(-1)?.sequence;
		if (triggerSequence === undefined) return;
		for (const pattern of this.patterns.values()) {
			if (!structurallyEligible(pattern, this.settings) || !matchesSuffix(history, pattern.context)) continue;
			if (pending.some((item) => item.patternID === pattern.id && item.triggerSequence === triggerSequence))
				continue;
			const context = history.slice(-pattern.context.length);
			pending.push({
				patternID: pattern.id,
				triggerSequence,
				expectedInput: applyBindings(pattern.bindings, context),
				remaining: learnedHorizon(pattern, this.settings.maxFutureGap),
			});
		}
		if (pending.length) this.pending.set(sessionID, pending);
	}

	private recordValidation(patternID: string, matched: boolean) {
		const pattern = this.patterns.get(patternID);
		if (!pattern) return;
		pattern.historicalOpportunities++;
		if (matched) pattern.historicalMatches++;
	}

	private trimHistory() {
		for (const history of this.history.values()) this.trimSessionHistory(history);
	}

	private trimSessionHistory(history: PatternAwareEvent[]) {
		const limit = this.settings.maxContextLength + this.settings.maxFutureGap + 1;
		if (history.length > limit) history.splice(0, history.length - limit);
	}

	private trimPools() {
		const limit = Math.max(1, Math.floor(this.settings.maxPatterns * 2));
		if (this.pools.size <= limit) return;
		const evicted = [...this.pools.values()]
			.sort((left, right) => left.samples.length - right.samples.length)
			.slice(0, this.pools.size - limit);
		for (const pool of evicted) this.pools.delete(pool.key);
	}

	private trimPatterns() {
		const limit = Math.max(1, Math.floor(this.settings.maxPatterns));
		if (this.patterns.size <= limit) return;
		const evicted = [...this.patterns.values()]
			.sort(
				(left, right) => patternRank(left) - patternRank(right) || left.lastSeenSequence - right.lastSeenSequence,
			)
			.slice(0, this.patterns.size - limit);
		for (const pattern of evicted) this.patterns.delete(pattern.id);
	}

	private persist() {
		if (!this.persistenceFile || !this.loaded) return;
		const state: PersistedState = { version: 3, patterns: this.snapshot() };
		const target = this.persistenceFile;
		this.write = this.write
			.then(async () => {
				await fs.mkdir(path.dirname(target), { recursive: true });
				const temporary = `${target}.${process.pid}.tmp`;
				await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
				await fs.rename(temporary, target).catch(async () => {
					await fs.rm(target, { force: true });
					await fs.rename(temporary, target);
				});
			})
			.catch(() => undefined);
	}
}

const stores = new Map<string, Promise<PatternAwareStore>>();

export function openPatternAwareStore(workspace: string, settings: PatternAwareSettings, stateDirectory?: string) {
	const file = patternAwarePersistenceFile(workspace, stateDirectory);
	const existing = stores.get(file);
	if (existing) {
		return existing.then((store) => {
			store.configure(settings);
			return store;
		});
	}
	const opened = Promise.resolve(new PatternAwareStore(settings, file)).then(async (store) => {
		await store.load();
		return store;
	});
	stores.set(file, opened);
	return opened;
}

export function patternAwareSettings(value: unknown): PatternAwareSettings {
	const record = asRecord(value);
	return {
		enabled: typeof record?.enabled === "boolean" ? record.enabled : PATTERN_AWARE_DEFAULTS.enabled,
		maxContextLength: positiveInteger(record?.maxContextLength, PATTERN_AWARE_DEFAULTS.maxContextLength),
		maxFutureGap: nonNegativeInteger(record?.maxFutureGap, PATTERN_AWARE_DEFAULTS.maxFutureGap),
		minOccurrences: positiveInteger(record?.minOccurrences, PATTERN_AWARE_DEFAULTS.minOccurrences),
		minEmpiricalProbability: probabilitySetting(
			record?.minEmpiricalProbability,
			PATTERN_AWARE_DEFAULTS.minEmpiricalProbability,
		),
		maxPatterns: positiveInteger(record?.maxPatterns, PATTERN_AWARE_DEFAULTS.maxPatterns),
	};
}

export function patternAwarePersistenceFile(workspace: string, stateDirectory?: string) {
	const root = stateDirectory
		? path.resolve(stateDirectory)
		: process.env.PI_STATE_DIR
			? path.resolve(process.env.PI_STATE_DIR)
			: process.platform === "win32"
				? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "pi")
				: path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi");
	return path.join(root, "pattern-aware", `${hash(path.resolve(workspace))}.json`);
}

export function inferBindings(
	context: ReadonlyArray<PatternAwareEvent>,
	target: Record<string, unknown>,
): Record<string, PatternAwareBinding> {
	const bindings: Record<string, PatternAwareBinding> = {};
	for (const [targetPath, value] of leaves(target)) {
		const key = encodePath(targetPath);
		bindings[key] = findBinding(context, value) ?? { type: "constant", value };
	}
	return bindings;
}

function inferBindingsFromSamples(
	samples: ReadonlyArray<PatternSample>,
): Record<string, PatternAwareBinding> | undefined {
	const first = samples[0];
	if (!first) return;
	const bindings: Record<string, PatternAwareBinding> = {};
	for (const [targetPath, firstTarget] of leaves(first.target.input)) {
		const targets = samples.map((sample) => getPath(sample.target.input, targetPath));
		if (targets.some((value) => value === MISSING)) return;
		const candidates = candidateBindings(first.context, firstTarget);
		let selected = candidates.find((candidate) =>
			samples.every((sample, index) => sameValue(evaluateBinding(candidate, sample.context), targets[index])),
		);
		if (!selected) {
			const fallbackSources = uniqueBindings(
				samples.flatMap((sample, index) =>
					candidateBindings(sample.context, targets[index]).filter(
						(binding) => binding.type === "event" || binding.type === "transform",
					),
				),
			);
			if (fallbackSources.length > 1) {
				const fallback: PatternAwareBinding = { type: "coalesce", sources: fallbackSources };
				if (samples.every((sample, index) => sameValue(evaluateBinding(fallback, sample.context), targets[index])))
					selected = fallback;
			}
		}
		if (!selected && targets.every((value) => sameValue(value, firstTarget))) {
			selected = { type: "constant", value: firstTarget };
		}
		if (!selected) return;
		bindings[encodePath(targetPath)] = selected;
	}
	return bindings;
}

export function applyBindings(
	bindings: Readonly<Record<string, PatternAwareBinding>>,
	context: ReadonlyArray<PatternAwareEvent>,
): Record<string, unknown> | undefined {
	const result: Record<string, unknown> = {};
	for (const [encoded, binding] of Object.entries(bindings)) {
		const value = evaluateBinding(binding, context);
		if (value === MISSING) return undefined;
		if (!setPath(result, decodePath(encoded), value)) return undefined;
	}
	return result;
}

export function applyBindingsPartial(
	bindings: Readonly<Record<string, PatternAwareBinding>>,
	context: ReadonlyArray<PatternAwareEvent>,
): { readonly input: Record<string, unknown>; readonly missing: ReadonlyArray<PatternAwarePath> } {
	const input: Record<string, unknown> = {};
	const missing: PatternAwarePath[] = [];
	for (const [encoded, binding] of Object.entries(bindings)) {
		const targetPath = decodePath(encoded);
		const value = evaluateBinding(binding, context);
		if (value === MISSING) {
			missing.push(targetPath);
			continue;
		}
		if (!setPath(input, targetPath, value)) missing.push(targetPath);
	}
	return { input, missing };
}

function findBinding(context: ReadonlyArray<PatternAwareEvent>, target: unknown): PatternAwareBinding | undefined {
	return candidateBindings(context, target)[0];
}

function candidateBindings(context: ReadonlyArray<PatternAwareEvent>, target: unknown): PatternAwareBinding[] {
	const result: PatternAwareBinding[] = [];
	for (let index = context.length - 1; index >= 0; index--) {
		const event = context[index]!;
		const relativeEvent = index - context.length;
		const fields = [
			["input", event.input],
			["output", event.output],
			["outputPaths", event.outputPaths],
		] as const;
		for (const [field, value] of fields) {
			for (const [sourcePath, source] of leaves(value)) {
				const direct: PatternAwareBinding = { type: "event", relativeEvent, field, path: sourcePath };
				if (sameValue(source, target)) result.push(direct);
				if (typeof source !== "string" || typeof target !== "string") continue;
				const sources: PatternAwareBinding[] = [direct];
				const operations = ["trim", "lowercase", "uppercase"] as const;
				for (const operation of operations) {
					const transformed: PatternAwareBinding = { type: "transform", operation, source: direct };
					if (transform(operation, source) === target) result.push(transformed);
				}
				if (!isPathSource(field, sourcePath, source)) continue;
				for (const operation of ["dirname", "basename", "normalize_path"] as const) {
					const transformed: PatternAwareBinding = { type: "transform", operation, source: direct };
					if (transform(operation, source) === target) result.push(transformed);
					sources.push(transformed);
				}
				for (const binding of sources) {
					const value = evaluateBinding(binding, context);
					if (typeof value !== "string" || value.length < 3) continue;
					const offset = target.indexOf(value);
					if (offset < 0) continue;
					result.push({
						type: "template",
						source: binding,
						prefix: target.slice(0, offset),
						suffix: target.slice(offset + value.length),
					});
				}
			}
		}
	}
	return uniqueBindings(result);
}

function uniqueBindings(bindings: ReadonlyArray<PatternAwareBinding>) {
	const seen = new Set<string>();
	return bindings.filter((binding) => {
		const key = stableStringify(binding);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isPathSource(field: "input" | "output" | "outputPaths", sourcePath: PatternAwarePath, value: string) {
	if (field === "outputPaths") return true;
	if (field !== "input" || !value.length || /[\r\n"'|&<>]/.test(value)) return false;
	const key = String(sourcePath.at(-1) ?? "").toLowerCase();
	return key.includes("path") || key.includes("file") || key.includes("dir") || key === "cwd" || key === "root";
}

const MISSING = Symbol("missing");

function evaluateBinding(binding: PatternAwareBinding, context: ReadonlyArray<PatternAwareEvent>): unknown {
	if (binding.type === "constant") return binding.value;
	if (binding.type === "coalesce") {
		for (const source of binding.sources) {
			const value = evaluateBinding(source, context);
			if (value !== MISSING) return value;
		}
		return MISSING;
	}
	if (binding.type === "template") {
		const source = evaluateBinding(binding.source, context);
		return typeof source === "string" ? `${binding.prefix}${source}${binding.suffix}` : MISSING;
	}
	if (binding.type === "transform") {
		const source = evaluateBinding(binding.source, context);
		return typeof source === "string" ? transform(binding.operation, source) : MISSING;
	}
	const index = context.length + binding.relativeEvent;
	const event = context[index];
	if (!event) return MISSING;
	return getPath(event[binding.field], binding.path);
}

function transform(
	operation: "dirname" | "basename" | "normalize_path" | "trim" | "lowercase" | "uppercase",
	value: string,
) {
	if (operation === "dirname") return path.dirname(value);
	if (operation === "basename") return path.basename(value);
	if (operation === "trim") return value.trim();
	if (operation === "lowercase") return value.toLowerCase();
	if (operation === "uppercase") return value.toUpperCase();
	return path.normalize(value).replaceAll("\\", "/");
}

function getPath(value: unknown, segments: PatternAwarePath): unknown {
	let current = value;
	for (const segment of segments) {
		if (current === null || typeof current !== "object") return MISSING;
		if (typeof segment === "number") {
			if (!Array.isArray(current) || segment < 0 || segment >= current.length) return MISSING;
			current = current[segment];
			continue;
		}
		if (!(segment in current)) return MISSING;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function setPath(target: Record<string, unknown>, segments: PatternAwarePath, value: unknown) {
	if (!segments.length) return false;
	let current: Record<string, unknown> | unknown[] = target;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!;
		if (segment === "__proto__" || segment === "prototype" || segment === "constructor") return false;
		const final = index === segments.length - 1;
		if (final) {
			(current as Record<string | number, unknown>)[segment] = value;
			return true;
		}
		const next = segments[index + 1]!;
		const container: Record<string, unknown> | unknown[] = typeof next === "number" ? [] : {};
		(current as Record<string | number, unknown>)[segment] = container;
		current = container;
	}
	return false;
}

function leaves(value: unknown, prefix: Array<string | number> = []): Array<[Array<string | number>, unknown]> {
	if (Array.isArray(value)) {
		if (!value.length) return [[prefix, []]];
		return value.flatMap((item, index) => leaves(item, [...prefix, index]));
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		if (!entries.length) return [[prefix, {}]];
		return entries.flatMap(([key, item]) => leaves(item, [...prefix, key]));
	}
	return [[prefix, value]];
}

function eligible(pattern: MutablePattern, settings: PatternAwareSettings) {
	if (!structurallyEligible(pattern, settings)) return false;
	if (probability(pattern) < settings.minEmpiricalProbability) return false;
	if (pattern.opportunities < settings.minOccurrences) return true;
	const useful = pattern.consumed * pattern.averageDurationMs;
	const wasted = pattern.unused * pattern.averageDurationMs;
	return useful > wasted;
}

function structurallyEligible(pattern: MutablePattern, settings: PatternAwareSettings) {
	return (
		pattern.occurrences >= settings.minOccurrences &&
		pattern.replayMatches / Math.max(1, pattern.occurrences) >= settings.minEmpiricalProbability
	);
}

function learnedHorizon(pattern: MutablePattern, maximum: number) {
	return Math.min(
		maximum,
		Math.max(0, ...Object.keys(pattern.gapCounts).map((value) => Number.parseInt(value, 10) || 0)),
	);
}

function matchesSuffix(history: ReadonlyArray<PatternAwareEvent>, context: ReadonlyArray<PatternAwareEventSignature>) {
	if (!context.length || history.length < context.length) return false;
	return sameSignatures(history.slice(-context.length).map(signature), context);
}

function signature(event: PatternAwareEvent): PatternAwareEventSignature {
	return {
		tool: event.tool,
		outcome: event.outcome,
		...(event.operation ? { operation: event.operation } : {}),
	};
}

function sameSignatures(
	left: ReadonlyArray<PatternAwareEventSignature>,
	right: ReadonlyArray<PatternAwareEventSignature>,
) {
	return stableStringify(left) === stableStringify(right);
}

function patternRank(pattern: MutablePattern) {
	return pattern.consumed * 4 + pattern.replayMatches * 2 + probability(pattern) - pattern.unused;
}

function readonlyPattern(pattern: MutablePattern): PatternAwarePattern {
	return {
		...pattern,
		empiricalProbability: probability(pattern),
		context: pattern.context.map((item) => ({ ...item })),
		bindings: structuredClone(pattern.bindings),
		gapCounts: { ...pattern.gapCounts },
	};
}

function mutablePattern(value: PatternAwarePattern): MutablePattern | undefined {
	if (!value || typeof value !== "object" || typeof value.id !== "string" || !Array.isArray(value.context)) return;
	if (typeof value.targetTool !== "string" || !value.bindings || typeof value.bindings !== "object") return;
	return {
		id: value.id,
		context: value.context.map((item) => ({ ...item })),
		targetTool: value.targetTool,
		bindings: structuredClone(value.bindings),
		...(value.targetSchemaHash ? { targetSchemaHash: value.targetSchemaHash } : {}),
		gapCounts: { ...value.gapCounts },
		occurrences: finite(value.occurrences),
		replayMatches: finite(value.replayMatches),
		historicalOpportunities: Math.max(
			1,
			isFiniteNumber(value.historicalOpportunities) ? value.historicalOpportunities : finite(value.occurrences),
		),
		historicalMatches: isFiniteNumber(value.historicalMatches)
			? Math.max(0, value.historicalMatches)
			: finite(value.replayMatches),
		opportunities: finite(value.opportunities),
		consumed: finite(value.consumed),
		unused: finite(value.unused),
		averageDurationMs: finite(value.averageDurationMs),
		lastSeenSequence: finite(value.lastSeenSequence),
	};
}

function encodePath(segments: PatternAwarePath) {
	return JSON.stringify(segments);
}

function decodePath(value: string): Array<string | number> {
	const parsed = JSON.parse(value);
	return Array.isArray(parsed) ? parsed : [];
}

function sameValue(left: unknown, right: unknown) {
	return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown) {
	return JSON.stringify(stable(value));
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stable(item)]),
	);
}

function hash(value: string) {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function positiveInteger(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function probabilitySetting(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function probability(pattern: Pick<MutablePattern, "historicalMatches" | "historicalOpportunities">) {
	return Math.max(0, Math.min(1, pattern.historicalMatches / Math.max(1, pattern.historicalOpportunities)));
}

function finite(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
