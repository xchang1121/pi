import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type PatternAwareSettings = {
	readonly enabled: boolean;
	readonly maxContextLength: number;
	readonly maxFutureGap: number;
	readonly futureGapCoverage: number;
	readonly decayHalfLifeEvents: number;
	readonly minOccurrences: number;
	readonly minEmpiricalProbability: number;
	readonly maxPatterns: number;
};

export type PatternAwareEventSignature = {
	readonly tool: string;
	readonly outcome: "success" | "failure";
	readonly operation?: string;
	readonly outputShape?: string;
};

export type PatternAwareEventInput = {
	readonly sessionID: string;
	readonly turnID: string;
	readonly tool: string;
	readonly input: Record<string, unknown>;
	readonly actionKey?: string;
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
	readonly batchID?: string;
	readonly batchIndex?: number;
	readonly batchSize?: number;
};

export type PatternAwarePath = ReadonlyArray<string | number>;

export type PatternAwareDependencySource = {
	readonly relativeEvent: number;
	readonly field: "input" | "output" | "outputPaths";
	readonly path: PatternAwarePath;
	readonly itemPath?: PatternAwarePath;
};

export type PatternAwareDependency = {
	readonly targetPath: PatternAwarePath;
	readonly sources: ReadonlyArray<PatternAwareDependencySource>;
};

export type PatternAwareBinding = (
	| {
			readonly type: "event";
			readonly relativeEvent: number;
			readonly field: "input" | "output" | "outputPaths";
			readonly path: PatternAwarePath;
	  }
	| {
			readonly type: "each";
			readonly relativeEvent: number;
			readonly field: "input" | "output" | "outputPaths";
			readonly path: PatternAwarePath;
			readonly itemPath: PatternAwarePath;
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
	  }
	| {
			readonly type: "join";
			readonly operation: "concat" | "join_path" | "relative_path";
			readonly left: PatternAwareBinding;
			readonly right: PatternAwareBinding;
			readonly separator?: string;
	  }
) & {
	readonly variantCounts?: Readonly<Record<string, number>>;
};

export type PatternAwarePattern = {
	readonly id: string;
	readonly context: ReadonlyArray<PatternAwareEventSignature>;
	readonly targetTool: string;
	readonly bindings: Readonly<Record<string, PatternAwareBinding>>;
	readonly dependencies?: ReadonlyArray<PatternAwareDependency>;
	readonly targetSchemaHash?: string;
	readonly gapCounts: Readonly<Record<string, number>>;
	readonly gapLastSeen?: Readonly<Record<string, number>>;
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
	readonly conditionalProbability: number;
	readonly expectedDurationMs: number;
	readonly dependencies: ReadonlyArray<PatternAwareDependency>;
	readonly continuation: PatternAwareContinuation;
	readonly depth: number;
	readonly diagnostic: string;
};

export type PatternAwareContinuation = {
	readonly history: ReadonlyArray<PatternAwareEvent>;
	readonly visitedPatternIDs: ReadonlyArray<string>;
	readonly pathProbability: number;
};

export type PatternAwareRuntimeContext = {
	readonly store: PatternAwareStore;
	readonly continuation: PatternAwareContinuation;
};

export type PatternAwareObservation = {
	readonly output?: unknown;
	readonly outputPaths?: ReadonlyArray<string>;
};

type MutablePattern = {
	id: string;
	context: PatternAwareEventSignature[];
	targetTool: string;
	bindings: Record<string, PatternAwareBinding>;
	dependencies: PatternAwareDependency[];
	targetSchemaHash?: string;
	gapCounts: Record<string, number>;
	gapLastSeen: Record<string, number>;
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
	readonly pools?: ReadonlyArray<PatternPool>;
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
	inferred?: Record<string, PatternAwareBinding>;
	observations?: number;
	nextInferenceAt?: number;
	inferenceBackoff?: number;
};

type PendingValidation = {
	readonly patternID: string;
	readonly triggerSequence: number;
	readonly expectedInput?: Record<string, unknown>;
	remaining: number;
};

type TrieNode = {
	readonly children: Map<string, TrieNode>;
	readonly patterns: Set<string>;
};

export const PATTERN_AWARE_DEFAULTS: PatternAwareSettings = {
	enabled: true,
	maxContextLength: 6,
	maxFutureGap: 8,
	futureGapCoverage: 0.9,
	decayHalfLifeEvents: 2048,
	minOccurrences: 2,
	minEmpiricalProbability: 0.75,
	maxPatterns: 4096,
};

const MAX_BINDING_VARIANTS = 32;
const MAX_COMPOSABLE_SOURCES = 48;
const PERSIST_DEBOUNCE_MS = 200;
const PERSISTENCE_VERSION = 9;

class PredictiveContextTrie {
	private readonly root: TrieNode = { children: new Map(), patterns: new Set() };

	insert(pattern: Pick<MutablePattern, "id" | "context">) {
		let frontier = [this.root];
		for (let index = pattern.context.length - 1; index >= 0; index--) {
			const token = signatureToken(pattern.context[index]!);
			const next: TrieNode[] = [];
			for (const node of frontier) {
				const child = node.children.get(token) ?? { children: new Map(), patterns: new Set() };
				node.children.set(token, child);
				next.push(child);
			}
			frontier = next;
		}
		for (const node of frontier) node.patterns.add(pattern.id);
	}

	matching(history: ReadonlyArray<PatternAwareEvent>) {
		const result = new Set<string>();
		let frontier = [this.root];
		for (let index = history.length - 1; index >= 0 && frontier.length > 0; index--) {
			const token = signatureToken(signature(history[index]!));
			const next = new Set<TrieNode>();
			for (const node of frontier) {
				const child = node.children.get(token);
				if (!child) continue;
				next.add(child);
				for (const patternID of child.patterns) result.add(patternID);
			}
			frontier = [...next];
		}
		return result;
	}
}

export class PatternAwareStore {
	private readonly patterns = new Map<string, MutablePattern>();
	private readonly pools = new Map<string, PatternPool>();
	private readonly pending = new Map<string, PendingValidation[]>();
	private readonly history = new Map<string, PatternAwareEvent[]>();
	private trie = new PredictiveContextTrie();
	private indexDirty = true;
	private clock = 0;
	private write: Promise<void> = Promise.resolve();
	private writeError?: unknown;
	private dirty = false;
	private persistTimer?: ReturnType<typeof setTimeout>;
	private loaded = false;
	private settings: PatternAwareSettings;
	private readonly persistenceFile?: string;

	constructor(settings: PatternAwareSettings, persistenceFile?: string) {
		this.settings = settings;
		this.persistenceFile = persistenceFile;
	}

	configure(settings: PatternAwareSettings) {
		const resetInference =
			settings.minOccurrences !== this.settings.minOccurrences ||
			settings.maxContextLength !== this.settings.maxContextLength;
		this.settings = settings;
		if (resetInference) {
			for (const pool of this.pools.values()) {
				pool.nextInferenceAt = pool.observations ?? pool.samples.length;
				pool.inferenceBackoff = 1;
			}
		}
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
		if (!parsed || parsed.version !== PERSISTENCE_VERSION || !Array.isArray(parsed.patterns)) return;
		for (const item of parsed.patterns) {
			const pattern = mutablePattern(item);
			if (!pattern || pattern.context.some((event) => event.tool === "$llm")) continue;
			this.patterns.set(pattern.id, pattern);
			this.clock = Math.max(this.clock, pattern.lastSeenSequence);
		}
		if (Array.isArray(parsed.pools)) {
			for (const item of parsed.pools) {
				const pool = mutablePool(item);
				if (!pool || pool.context.some((event) => event.tool === "$llm")) continue;
				this.pools.set(pool.key, pool);
				for (const sample of pool.samples) {
					this.clock = Math.max(
						this.clock,
						sample.target.sequence,
						...sample.context.map((event) => event.sequence),
					);
				}
			}
		}
		this.indexDirty = true;
		this.trimPools();
		this.trimPatterns();
	}

	observe(input: PatternAwareEventInput, schemaHashes: Readonly<Record<string, string>> = {}) {
		return this.observeEvents([input], schemaHashes);
	}

	observeBatch(inputs: ReadonlyArray<PatternAwareEventInput>, schemaHashes: Readonly<Record<string, string>> = {}) {
		const first = inputs[0];
		if (!first) return [];
		if (inputs.some((input) => input.sessionID !== first.sessionID || input.turnID !== first.turnID)) {
			throw new Error("PatternAware batch actions must belong to one provider turn");
		}
		const ordered = inputs
			.map((input, index) => ({ input, index, key: canonicalBatchActionKey(input) }))
			.sort((left, right) => left.key.localeCompare(right.key) || left.index - right.index)
			.map((item) => item.input);
		return this.observeEvents(ordered, schemaHashes, first.turnID);
	}

	private observeEvents(
		inputs: ReadonlyArray<PatternAwareEventInput>,
		schemaHashes: Readonly<Record<string, string>>,
		batchID?: string,
	) {
		if (!this.settings.enabled) return [];
		const first = inputs[0];
		if (!first) return [];
		const events = inputs.map(
			(input, index): PatternAwareEvent => ({
				...input,
				sequence: ++this.clock,
				...(batchID ? { batchID, batchIndex: index, batchSize: inputs.length } : {}),
			}),
		);
		const history = this.history.get(first.sessionID) ?? [];
		const actions = events.filter(isActionEvent);
		if (actions.length) this.resolvePendingBatch(first.sessionID, actions);
		const prior = actionHistory(history);
		for (const event of actions) {
			if (event.learnTarget !== false) this.learn(prior, event);
		}
		history.push(...events);
		this.history.set(first.sessionID, history);
		if (actions.length) this.startPending(first.sessionID, actionHistory(history));
		this.trimSessionHistory(history);
		this.trimPools();
		this.trimPatterns();
		this.persist();
		return this.predict(first.sessionID, schemaHashes);
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
		this.clock = Math.max(this.clock, pattern.lastSeenSequence);
		this.indexDirty = true;
		this.trimPatterns();
		this.persist();
		return true;
	}

	predict(sessionID: string, schemaHashes: Readonly<Record<string, string>> = {}) {
		if (!this.settings.enabled) return [];
		const history = actionHistory(this.history.get(sessionID) ?? []);
		return this.predictHistory(history, schemaHashes, {
			history,
			visitedPatternIDs: [],
			pathProbability: 1,
		});
	}

	continue(
		continuation: PatternAwareContinuation,
		input: PatternAwareEventInput,
		schemaHashes: Readonly<Record<string, string>> = {},
		parentConfirmed = false,
	) {
		if (!this.settings.enabled) return [];
		const event: PatternAwareEvent = {
			...input,
			sequence: (continuation.history.at(-1)?.sequence ?? this.clock) + 1,
			learnTarget: false,
		};
		const history = actionHistory([...continuation.history, event]);
		this.trimSessionHistory(history);
		return this.predictHistory(history, schemaHashes, {
			history,
			visitedPatternIDs: continuation.visitedPatternIDs,
			pathProbability: parentConfirmed ? 1 : continuation.pathProbability,
		});
	}

	private predictHistory(
		history: ReadonlyArray<PatternAwareEvent>,
		schemaHashes: Readonly<Record<string, string>>,
		continuation: PatternAwareContinuation,
	) {
		const predictiveHistory = actionHistory(history);
		const result: PatternAwareCandidate[] = [];
		const groups = new Map<
			string,
			Array<{
				readonly pattern: MutablePattern;
				readonly type: "tool_call" | "preparation_hint";
				readonly input: Record<string, unknown>;
				readonly missing: ReadonlyArray<PatternAwarePath>;
				readonly variantProbability: number;
			}>
		>();
		this.ensureIndex();
		for (const patternID of this.trie.matching(predictiveHistory)) {
			const pattern = this.patterns.get(patternID);
			if (!pattern || !structurallyEligible(pattern, this.settings) || !runtimeEligible(pattern, this.settings))
				continue;
			if (continuation.visitedPatternIDs.includes(pattern.id)) continue;
			if (pattern.targetSchemaHash && schemaHashes[pattern.targetTool] !== pattern.targetSchemaHash) continue;
			if (!matchesSuffix(predictiveHistory, pattern.context)) continue;
			const context = predictiveHistory.slice(-pattern.context.length);
			for (const applied of applyBindingsPartialWeightedVariants(pattern.bindings, context)) {
				const type = applied.missing.length ? "preparation_hint" : "tool_call";
				const identity = stableStringify({
					type,
					tool: pattern.targetTool,
					input: applied.input,
					missing: applied.missing,
				});
				const group = groups.get(identity) ?? [];
				group.push({
					pattern,
					type,
					input: applied.input,
					missing: applied.missing,
					variantProbability: applied.probability,
				});
				groups.set(identity, group);
			}
		}
		const predictions = [...groups.values()]
			.map((group) => {
				const ordered = [...group].sort(
					(left, right) =>
						right.pattern.context.length - left.pattern.context.length ||
						right.pattern.occurrences - left.pattern.occurrences,
				);
				const representative = ordered[0]!;
				const horizon = learnedGroupHorizon(
					ordered.map((item) => item.pattern),
					this.settings,
					this.clock,
				);
				const gapCoverage = groupGapCoverage(
					ordered.map((item) => item.pattern),
					horizon,
					this.settings,
					this.clock,
				);
				const controlProbability =
					backoffProbability(
						ordered.map((item) => item.pattern),
						this.clock,
						this.settings.decayHalfLifeEvents,
					) * gapCoverage;
				const totalWeight = ordered.reduce(
					(total, item) =>
						total +
						Math.max(1, item.pattern.occurrences) *
							recencyWeight(item.pattern.lastSeenSequence, this.clock, this.settings.decayHalfLifeEvents),
					0,
				);
				const variantProbability =
					ordered.reduce(
						(total, item) =>
							total +
							item.variantProbability *
								Math.max(1, item.pattern.occurrences) *
								recencyWeight(item.pattern.lastSeenSequence, this.clock, this.settings.decayHalfLifeEvents),
						0,
					) / Math.max(1, totalWeight);
				const expectedDurationMs =
					ordered.reduce(
						(total, item) =>
							total +
							Math.max(0, item.pattern.averageDurationMs) *
								Math.max(1, item.pattern.occurrences) *
								recencyWeight(item.pattern.lastSeenSequence, this.clock, this.settings.decayHalfLifeEvents),
						0,
					) / Math.max(1, totalWeight);
				return {
					ordered,
					representative,
					horizon,
					gapCoverage,
					controlProbability,
					variantProbability,
					rawProbability: Math.max(0, controlProbability * variantProbability),
					expectedDurationMs,
				};
			})
			.filter((prediction) => prediction.controlProbability >= this.settings.minEmpiricalProbability);
		const probabilityScale = Math.max(
			1,
			predictions.reduce((total, prediction) => total + prediction.rawProbability, 0),
		);
		for (const prediction of predictions) {
			const {
				ordered,
				representative,
				horizon,
				gapCoverage,
				controlProbability,
				variantProbability,
				rawProbability,
				expectedDurationMs,
			} = prediction;
			const conditionalProbability = Math.max(0, Math.min(1, rawProbability / probabilityScale));
			const empiricalProbability = Math.max(0, Math.min(1, continuation.pathProbability * conditionalProbability));
			const nextContinuation: PatternAwareContinuation = {
				history: predictiveHistory,
				visitedPatternIDs: [...continuation.visitedPatternIDs, representative.pattern.id],
				pathProbability: empiricalProbability,
			};
			result.push({
				type: representative.type,
				source: "pattern_aware",
				tool: representative.pattern.targetTool,
				input: representative.input,
				missing: representative.missing,
				patternID: representative.pattern.id,
				horizon,
				empiricalProbability,
				conditionalProbability,
				expectedDurationMs,
				dependencies: representative.pattern.dependencies,
				continuation: nextContinuation,
				depth: nextContinuation.visitedPatternIDs.length,
				diagnostic: JSON.stringify(
					{
						source: "pattern_aware",
						patternID: representative.pattern.id,
						supportingPatterns: ordered.map((item) => item.pattern.id),
						context: representative.pattern.context,
						tool: representative.pattern.targetTool,
						input: representative.input,
						missing: representative.missing,
						empiricalProbability,
						conditionalProbability,
						controlProbability,
						variantProbability,
						gapCoverage,
						expectedDurationMs,
						dependencies: representative.pattern.dependencies,
						depth: nextContinuation.visitedPatternIDs.length,
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

	async flush(): Promise<void> {
		while (true) {
			if (this.persistTimer) {
				clearTimeout(this.persistTimer);
				this.persistTimer = undefined;
			}
			this.enqueuePersist();
			await this.write;
			if (this.writeError) {
				const error = this.writeError;
				this.writeError = undefined;
				throw error;
			}
			if (!this.dirty) return;
		}
	}

	private ensureIndex() {
		if (!this.indexDirty) return;
		this.trie = new PredictiveContextTrie();
		for (const pattern of this.patterns.values()) this.trie.insert(pattern);
		this.indexDirty = false;
	}

	private learn(history: ReadonlyArray<PatternAwareEvent>, target: PatternAwareEvent) {
		const batches = actionBatches(history);
		const maxGap = Math.min(this.settings.maxFutureGap, Math.max(0, batches.length - 1));
		for (let gap = 0; gap <= maxGap; gap++) {
			const contextEnd = batches.length - gap;
			const maxLength = Math.min(this.settings.maxContextLength, contextEnd);
			for (let length = 1; length <= maxLength; length++) {
				const context = batches.slice(contextEnd - length, contextEnd).flat();
				this.learnOccurrence(context, target, gap);
			}
		}
	}

	private learnOccurrence(context: ReadonlyArray<PatternAwareEvent>, target: PatternAwareEvent, gap: number) {
		const signatures = context.map(signature);
		const poolKey = hash(
			stableStringify({ context: signatures, targetTool: target.tool, targetSchemaHash: target.schemaHash, gap }),
		);
		const pool = this.pools.get(poolKey) ?? {
			key: poolKey,
			context: signatures,
			targetTool: target.tool,
			...(target.schemaHash ? { targetSchemaHash: target.schemaHash } : {}),
			samples: [],
		};
		pool.samples.push({ context: [...context], target, gap });
		pool.observations = (pool.observations ?? pool.samples.length - 1) + 1;
		const sampleLimit = Math.max(this.settings.minOccurrences * 4, this.settings.maxContextLength * 4);
		if (pool.samples.length > sampleLimit) pool.samples.splice(0, pool.samples.length - sampleLimit);
		this.pools.set(poolKey, pool);
		if (pool.samples.length < this.settings.minOccurrences) return;
		let inferred = pool.inferred;
		const invalidated = inferred !== undefined && !bindingsMatchSample(inferred, pool.samples.at(-1)!);
		if (!inferred || invalidated) {
			if (!invalidated && pool.observations < (pool.nextInferenceAt ?? this.settings.minOccurrences)) return;
			inferred = inferBindingsFromSamples(pool.samples, Math.max(4, this.settings.minOccurrences * 2));
			pool.inferred = inferred;
			if (!inferred) {
				pool.inferenceBackoff = Math.min(8, Math.max(2, (pool.inferenceBackoff ?? 1) * 2));
				pool.nextInferenceAt = pool.observations + pool.inferenceBackoff;
				return;
			}
			pool.inferenceBackoff = 1;
			pool.nextInferenceAt = pool.observations + 1;
		}
		const replayMatches = pool.samples.filter((sample) => {
			return applyBindingsVariants(inferred, sample.context).some((concrete) =>
				sameValue(concrete, sample.target.input),
			);
		}).length;
		const empiricalProbability = replayMatches / pool.samples.length;
		if (empiricalProbability < this.settings.minEmpiricalProbability) return;
		const id = hash(
			stableStringify({
				context: signatures,
				targetTool: target.tool,
				bindings: bindingMapStructure(inferred),
				targetSchemaHash: target.schemaHash,
			}),
		);
		const existing = this.patterns.get(id);
		if (existing) {
			existing.bindings = inferred;
			existing.dependencies = bindingDependencies(inferred);
			existing.occurrences = pool.samples.length;
			existing.replayMatches = replayMatches;
			existing.historicalOpportunities = Math.max(existing.historicalOpportunities, pool.samples.length);
			existing.historicalMatches = Math.max(existing.historicalMatches, replayMatches);
			existing.gapCounts[String(gap)] = (existing.gapCounts[String(gap)] ?? 0) + 1;
			existing.gapLastSeen[String(gap)] = target.sequence;
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
			dependencies: bindingDependencies(inferred),
			...(target.schemaHash ? { targetSchemaHash: target.schemaHash } : {}),
			gapCounts: { [String(gap)]: 1 },
			gapLastSeen: { [String(gap)]: target.sequence },
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
		this.indexDirty = true;
	}

	private resolvePendingBatch(sessionID: string, events: ReadonlyArray<PatternAwareEvent>) {
		const pending = this.pending.get(sessionID);
		if (!pending?.length) return;
		const remaining: PendingValidation[] = [];
		for (const item of pending) {
			const pattern = this.patterns.get(item.patternID);
			if (!pattern) continue;
			const matched = events.some(
				(event) =>
					event.tool === pattern.targetTool &&
					item.expectedInput !== undefined &&
					sameValue(item.expectedInput, event.input),
			);
			if (matched) {
				this.recordValidation(item.patternID, true);
				continue;
			}
			if (item.remaining <= 0) {
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
		this.ensureIndex();
		for (const patternID of this.trie.matching(history)) {
			const pattern = this.patterns.get(patternID);
			if (!pattern) continue;
			if (!structurallyEligible(pattern, this.settings) || !matchesSuffix(history, pattern.context)) continue;
			if (pending.some((item) => item.patternID === pattern.id && item.triggerSequence === triggerSequence))
				continue;
			const context = history.slice(-pattern.context.length);
			pending.push({
				patternID: pattern.id,
				triggerSequence,
				expectedInput: applyBindings(pattern.bindings, context),
				remaining: learnedHorizon(pattern, this.settings, this.clock),
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
		const batches = indexedActionBatches(history);
		const controls = history.flatMap((event, index) => (isActionEvent(event) ? [] : [index]));
		if (batches.length <= limit && controls.length <= limit) return;
		const keep = new Set([...batches.slice(-limit).flat(), ...controls.slice(-limit)]);
		history.splice(0, history.length, ...history.filter((_, index) => keep.has(index)));
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
				(left, right) =>
					patternRank(left, this.clock, this.settings.decayHalfLifeEvents) -
						patternRank(right, this.clock, this.settings.decayHalfLifeEvents) ||
					left.lastSeenSequence - right.lastSeenSequence,
			)
			.slice(0, this.patterns.size - limit);
		for (const pattern of evicted) this.patterns.delete(pattern.id);
		if (evicted.length) this.indexDirty = true;
	}

	private persist() {
		if (!this.persistenceFile || !this.loaded) return;
		this.dirty = true;
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			this.enqueuePersist();
		}, PERSIST_DEBOUNCE_MS);
		this.persistTimer.unref?.();
	}

	private enqueuePersist() {
		if (!this.persistenceFile || !this.loaded || !this.dirty) return;
		this.dirty = false;
		const state: PersistedState = {
			version: PERSISTENCE_VERSION,
			patterns: this.snapshot(),
			pools: this.persistedPools(),
		};
		const target = this.persistenceFile;
		this.write = this.write
			.catch(() => undefined)
			.then(async () => {
				await fs.mkdir(path.dirname(target), { recursive: true });
				const temporary = `${target}.${process.pid}.tmp`;
				await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, "utf8");
				await fs.rename(temporary, target).catch(async () => {
					await fs.rm(target, { force: true });
					await fs.rename(temporary, target);
				});
				this.writeError = undefined;
			})
			.catch((error) => {
				this.writeError = error;
				this.dirty = true;
			});
	}

	private persistedPools(): ReadonlyArray<PatternPool> {
		const sampleLimit = Math.max(1, this.settings.minOccurrences);
		return [...this.pools.values()]
			.sort(
				(left, right) =>
					(right.samples.at(-1)?.target.sequence ?? 0) - (left.samples.at(-1)?.target.sequence ?? 0) ||
					right.samples.length - left.samples.length,
			)
			.slice(0, this.settings.maxPatterns)
			.map(({ inferred: _, observations: __, nextInferenceAt: ___, inferenceBackoff: ____, ...pool }) => ({
				...pool,
				samples: pool.samples.slice(-sampleLimit),
			}));
	}
}

type PooledPatternAwareStore = {
	readonly store: Promise<PatternAwareStore>;
	references: number;
};

export type PatternAwareStoreLease = {
	readonly store: PatternAwareStore;
	readonly release: () => Promise<void>;
};

const stores = new Map<string, PooledPatternAwareStore>();

export async function acquirePatternAwareStore(
	workspace: string,
	settings: PatternAwareSettings,
	stateDirectory?: string,
): Promise<PatternAwareStoreLease> {
	const file = patternAwarePersistenceFile(workspace, stateDirectory);
	let pooled = stores.get(file);
	if (!pooled) {
		const store = Promise.resolve(new PatternAwareStore(settings, file)).then(async (value) => {
			await value.load();
			return value;
		});
		pooled = { store, references: 0 };
		stores.set(file, pooled);
	}
	pooled.references++;
	let store: PatternAwareStore;
	try {
		store = await pooled.store;
	} catch (error) {
		pooled.references--;
		if (pooled.references === 0 && stores.get(file) === pooled) stores.delete(file);
		throw error;
	}
	store.configure(settings);
	let released = false;
	return {
		store,
		release: async () => {
			if (released) return;
			released = true;
			pooled.references = Math.max(0, pooled.references - 1);
			try {
				await store.flush();
			} finally {
				if (pooled.references === 0 && stores.get(file) === pooled) stores.delete(file);
			}
		},
	};
}

export function patternAwareSettings(value: unknown): PatternAwareSettings {
	const record = asRecord(value);
	return {
		enabled: typeof record?.enabled === "boolean" ? record.enabled : PATTERN_AWARE_DEFAULTS.enabled,
		maxContextLength: positiveInteger(record?.maxContextLength, PATTERN_AWARE_DEFAULTS.maxContextLength),
		maxFutureGap: nonNegativeInteger(record?.maxFutureGap, PATTERN_AWARE_DEFAULTS.maxFutureGap),
		futureGapCoverage: probabilitySetting(record?.futureGapCoverage, PATTERN_AWARE_DEFAULTS.futureGapCoverage),
		decayHalfLifeEvents: positiveInteger(record?.decayHalfLifeEvents, PATTERN_AWARE_DEFAULTS.decayHalfLifeEvents),
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

export function patternAwareRuntimeContext(
	store: PatternAwareStore,
	candidate: Pick<PatternAwareCandidate, "continuation">,
): PatternAwareRuntimeContext {
	return { store, continuation: candidate.continuation };
}

export function asPatternAwareRuntimeContext(value: unknown): PatternAwareRuntimeContext | undefined {
	const record = asRecord(value);
	if (!(record?.store instanceof PatternAwareStore)) return;
	const continuation = asRecord(record.continuation);
	if (!continuation || !Array.isArray(continuation.history) || !Array.isArray(continuation.visitedPatternIDs)) return;
	if (typeof continuation.pathProbability !== "number") return;
	return value as PatternAwareRuntimeContext;
}

export function projectPatternAwareObservation(
	output: unknown,
	outputPaths: ReadonlyArray<string> = [],
	resourceRoot?: string,
): PatternAwareObservation {
	const structured = normalizeStructuredPaths(structuredOutput(output), "", resourceRoot);
	const paths = uniqueStrings([...outputPaths, ...structuredPaths(structured)]).map((item) =>
		normalizeResourcePath(item, resourceRoot),
	);
	return {
		...(structured !== undefined ? { output: structured } : {}),
		...(paths.length ? { outputPaths: paths } : {}),
	};
}

export function inferBindings(
	context: ReadonlyArray<PatternAwareEvent>,
	target: Record<string, unknown>,
): Record<string, PatternAwareBinding> {
	const bindings: Record<string, PatternAwareBinding> = {};
	for (const [targetPath, value] of leaves(target)) {
		const key = encodePath(targetPath);
		bindings[key] = findBinding(context, value, targetPath) ?? { type: "constant", value };
	}
	return bindings;
}

function inferBindingsFromSamples(
	samples: ReadonlyArray<PatternSample>,
	constantSupport = 4,
): Record<string, PatternAwareBinding> | undefined {
	const first = samples[0];
	if (!first) return;
	const bindings: Record<string, PatternAwareBinding> = {};
	for (const [targetPath, firstTarget] of leaves(first.target.input)) {
		const targets = samples.map((sample) => getPath(sample.target.input, targetPath));
		if (targets.some((value) => value === MISSING)) return;
		const constant = targets.every((value) => sameValue(value, firstTarget));
		if (constant && !requiresProvenance(targetPath, firstTarget)) {
			bindings[encodePath(targetPath)] = { type: "constant", value: firstTarget };
			continue;
		}
		const targetIsPath = isPathField(String(targetPath.at(-1) ?? ""));
		const direct = candidateBindings(first.context, firstTarget, false, targetIsPath);
		let selected = direct.find((candidate) =>
			samples.every((sample, index) => bindingMatches(candidate, sample.context, targets[index])),
		);
		if (!selected && typeof firstTarget === "string") {
			selected = candidateBindings(first.context, firstTarget, true, targetIsPath).find((candidate) =>
				samples.every((sample, index) => bindingMatches(candidate, sample.context, targets[index])),
			);
		}
		if (!selected) {
			const fallbackSources = uniqueBindings(
				samples.flatMap((sample, index) =>
					candidateBindings(sample.context, targets[index], false, targetIsPath).filter(
						(binding) => binding.type === "event" || binding.type === "transform",
					),
				),
			);
			if (fallbackSources.length > 1) {
				const fallback: PatternAwareBinding = { type: "coalesce", sources: fallbackSources };
				if (samples.every((sample, index) => bindingMatches(fallback, sample.context, targets[index])))
					selected = fallback;
			}
		}
		if (selected) selected = withObservedVariantCounts(selected, samples, targets);
		if (!selected && constant && stablePayloadConstant(samples, constantSupport)) {
			selected = { type: "constant", value: firstTarget };
		}
		if (!selected) return;
		bindings[encodePath(targetPath)] = selected;
	}
	return bindings;
}

function withObservedVariantCounts(
	binding: PatternAwareBinding,
	samples: ReadonlyArray<PatternSample>,
	targets: ReadonlyArray<unknown>,
): PatternAwareBinding {
	const counts = new Map<number, number>();
	let width = 1;
	for (const [index, sample] of samples.entries()) {
		const values = bindingValues(binding, sample.context);
		width = Math.max(width, values.length);
		const selected = values.findIndex((value) => sameValue(value, targets[index]));
		if (selected >= 0) counts.set(selected, (counts.get(selected) ?? 0) + 1);
	}
	if (width <= 1 || counts.size === 0) return binding;
	return {
		...binding,
		variantCounts: Object.fromEntries([...counts.entries()].map(([index, count]) => [String(index), count])),
	};
}

function requiresProvenance(targetPath: PatternAwarePath, value: unknown): boolean {
	const key = String(targetPath.at(-1) ?? "")
		.toLowerCase()
		.replaceAll("_", "");
	if (isPathField(key)) return true;
	if (typeof value !== "string") return false;
	return [
		"command",
		"content",
		"newstring",
		"oldstring",
		"patch",
		"pattern",
		"query",
		"replacement",
		"script",
		"text",
		"url",
	].some((name) => key === name || key.endsWith(name));
}

function stablePayloadConstant(samples: ReadonlyArray<PatternSample>, minimum: number): boolean {
	if (samples.length < minimum) return false;
	return new Set(samples.map((sample) => `${sample.target.sessionID}:${sample.target.turnID}`)).size >= minimum;
}

function bindingsMatchSample(bindings: Readonly<Record<string, PatternAwareBinding>>, sample: PatternSample) {
	return applyBindingsVariants(bindings, sample.context).some((input) => sameValue(input, sample.target.input));
}

const MISSING = Symbol("missing");
const MULTI = Symbol("multi");
type MultiValue = { readonly [MULTI]: true; readonly values: ReadonlyArray<unknown> };

export function applyBindingsVariants(
	bindings: Readonly<Record<string, PatternAwareBinding>>,
	context: ReadonlyArray<PatternAwareEvent>,
	limit = MAX_BINDING_VARIANTS,
): ReadonlyArray<Record<string, unknown>> {
	return applyBindingsPartialWeightedVariants(bindings, context, limit)
		.filter((variant) => variant.missing.length === 0)
		.map((variant) => variant.input);
}

export function applyBindings(
	bindings: Readonly<Record<string, PatternAwareBinding>>,
	context: ReadonlyArray<PatternAwareEvent>,
): Record<string, unknown> | undefined {
	return applyBindingsVariants(bindings, context, 1)[0];
}

export function applyBindingsPartial(
	bindings: Readonly<Record<string, PatternAwareBinding>>,
	context: ReadonlyArray<PatternAwareEvent>,
): { readonly input: Record<string, unknown>; readonly missing: ReadonlyArray<PatternAwarePath> } {
	return applyBindingsPartialVariants(bindings, context, 1)[0] ?? { input: {}, missing: [] };
}

export function applyBindingsPartialVariants(
	bindings: Readonly<Record<string, PatternAwareBinding>>,
	context: ReadonlyArray<PatternAwareEvent>,
	limit = MAX_BINDING_VARIANTS,
): ReadonlyArray<{ readonly input: Record<string, unknown>; readonly missing: ReadonlyArray<PatternAwarePath> }> {
	return applyBindingsPartialWeightedVariants(bindings, context, limit).map(({ input, missing }) => ({
		input,
		missing,
	}));
}

function applyBindingsPartialWeightedVariants(
	bindings: Readonly<Record<string, PatternAwareBinding>>,
	context: ReadonlyArray<PatternAwareEvent>,
	limit = MAX_BINDING_VARIANTS,
): ReadonlyArray<{
	readonly input: Record<string, unknown>;
	readonly missing: ReadonlyArray<PatternAwarePath>;
	readonly probability: number;
}> {
	let variants: Array<{ input: Record<string, unknown>; missing: PatternAwarePath[]; probability: number }> = [
		{ input: {}, missing: [], probability: 1 },
	];
	for (const [encoded, binding] of Object.entries(bindings)) {
		const targetPath = decodePath(encoded);
		const values = weightedBindingValues(binding, context);
		if (!values.length) {
			for (const variant of variants) variant.missing.push(targetPath);
			continue;
		}
		const next: Array<{ input: Record<string, unknown>; missing: PatternAwarePath[]; probability: number }> = [];
		for (const variant of variants) {
			for (const value of values) {
				const candidate = {
					input: structuredClone(variant.input),
					missing: [...variant.missing],
					probability: variant.probability * value.probability,
				};
				if (!setPath(candidate.input, targetPath, value.value)) candidate.missing.push(targetPath);
				next.push(candidate);
			}
		}
		variants = next.sort((left, right) => right.probability - left.probability).slice(0, limit);
	}
	return variants;
}

function weightedBindingValues(binding: PatternAwareBinding, context: ReadonlyArray<PatternAwareEvent>) {
	const values = bindingValues(binding, context);
	if (values.length <= 1) return values.map((value) => ({ value, probability: 1 }));
	const counts = binding.variantCounts;
	if (!counts) {
		const probability = 1 / values.length;
		return values.map((value) => ({ value, probability }));
	}
	const smoothing = 0.5;
	const total = values.reduce<number>((sum, _, index) => sum + variantCount(counts, index), 0);
	const denominator = total + smoothing * values.length;
	return values.map((value, index) => ({
		value,
		probability: (variantCount(counts, index) + smoothing) / denominator,
	}));
}

function variantCount(counts: Readonly<Record<string, number>>, index: number): number {
	const value = counts[String(index)];
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function findBinding(
	context: ReadonlyArray<PatternAwareEvent>,
	target: unknown,
	targetPath: PatternAwarePath,
): PatternAwareBinding | undefined {
	return candidateBindings(context, target, true, isPathField(String(targetPath.at(-1) ?? "")))[0];
}

function candidateBindings(
	context: ReadonlyArray<PatternAwareEvent>,
	target: unknown,
	includeCompositions = true,
	targetIsPath = false,
): PatternAwareBinding[] {
	if (!includeCompositions) return indexedBindings(context, target, targetIsPath);
	const result: PatternAwareBinding[] = [];
	const composable: Array<{ readonly binding: PatternAwareBinding; readonly value: string; readonly path: boolean }> =
		[];
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
				const pathSource = typeof source === "string" && isPathSource(field, sourcePath, source);
				if (sameValue(source, target) && (!targetIsPath || pathSource)) result.push(direct);
				if (typeof source !== "string" || typeof target !== "string") continue;
				if ((!targetIsPath || pathSource) && composable.length < MAX_COMPOSABLE_SOURCES)
					composable.push({ binding: direct, value: source, path: pathSource });
				const sources: PatternAwareBinding[] = [direct];
				const operations = ["trim", "lowercase", "uppercase"] as const;
				for (const operation of operations) {
					const transformed: PatternAwareBinding = { type: "transform", operation, source: direct };
					if (transform(operation, source) === target && (!targetIsPath || pathSource)) result.push(transformed);
				}
				if (!pathSource) continue;
				for (const operation of ["dirname", "basename", "normalize_path"] as const) {
					const transformed: PatternAwareBinding = { type: "transform", operation, source: direct };
					if (transform(operation, source) === target) result.push(transformed);
					sources.push(transformed);
					const value = evaluateBinding(transformed, context);
					if (typeof value === "string" && composable.length < MAX_COMPOSABLE_SOURCES)
						composable.push({ binding: transformed, value, path: true });
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
			for (const item of collectionBindings(value, target)) {
				if (
					targetIsPath &&
					typeof target === "string" &&
					!isPathSource(field, [...item.path, ...item.itemPath], target)
				)
					continue;
				result.push({
					type: "each",
					relativeEvent,
					field,
					path: item.path,
					itemPath: item.itemPath,
				});
			}
		}
	}
	if (includeCompositions && typeof target === "string") {
		const sources = uniqueComposable(composable);
		const components = sources.filter((item) => item.value.length > 0 && target.includes(item.value));
		for (const left of components) {
			for (const right of components) {
				if (left.binding === right.binding) continue;
				for (const separator of ["", " ", "=", ":", "/"]) {
					if (`${left.value}${separator}${right.value}` !== target) continue;
					result.push({
						type: "join",
						operation: "concat",
						left: left.binding,
						right: right.binding,
						...(separator ? { separator } : {}),
					});
				}
				if (
					left.path &&
					right.path &&
					normalizePath(path.join(left.value, right.value)) === normalizePath(target)
				) {
					result.push({ type: "join", operation: "join_path", left: left.binding, right: right.binding });
				}
			}
		}
		const normalizedTarget = normalizePath(target);
		const pathSources = sources.filter((item) => item.path);
		const relativeRights = pathSources.filter((item) => normalizePath(item.value).endsWith(normalizedTarget));
		for (const left of pathSources) {
			for (const right of relativeRights) {
				if (
					left.binding !== right.binding &&
					normalizePath(path.relative(left.value, right.value)) === normalizedTarget
				) {
					result.push({ type: "join", operation: "relative_path", left: left.binding, right: right.binding });
				}
			}
		}
	}
	return uniqueBindings(result);
}

function indexedBindings(
	context: ReadonlyArray<PatternAwareEvent>,
	target: unknown,
	targetIsPath: boolean,
): PatternAwareBinding[] {
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
			for (const sourcePath of indexedLeaves(value, target)) {
				if (targetIsPath && typeof target === "string" && !isPathSource(field, sourcePath, target)) continue;
				result.push({ type: "event", relativeEvent, field, path: sourcePath });
			}
			for (const item of indexedCollections(value, target)) {
				if (
					targetIsPath &&
					typeof target === "string" &&
					!isPathSource(field, [...item.path, ...item.itemPath], target)
				)
					continue;
				result.push({
					type: "each",
					relativeEvent,
					field,
					path: item.path,
					itemPath: item.itemPath,
				});
			}
		}
	}
	return uniqueBindings(result);
}

type ValueIndex = ReadonlyMap<string, ReadonlyArray<PatternAwarePath>>;

const leafIndexCache = new WeakMap<object, ValueIndex>();

function indexedLeaves(value: unknown, target: unknown): ReadonlyArray<PatternAwarePath> {
	return valueIndex(value, leaves, leafIndexCache).get(stableStringify(target)) ?? [];
}

type CollectionValueIndex = ReadonlyMap<
	string,
	ReadonlyArray<{ readonly path: PatternAwarePath; readonly itemPath: PatternAwarePath }>
>;

const collectionIndexCache = new WeakMap<object, CollectionValueIndex>();

function indexedCollections(
	value: unknown,
	target: unknown,
): ReadonlyArray<{ readonly path: PatternAwarePath; readonly itemPath: PatternAwarePath }> {
	if (isObject(value)) {
		const cached = collectionIndexCache.get(value);
		if (cached) return cached.get(stableStringify(target)) ?? [];
	}
	const mutable = new Map<string, Array<{ path: PatternAwarePath; itemPath: PatternAwarePath }>>();
	for (const entry of collectionEntries(value)) {
		const key = stableStringify(entry.value);
		const paths = mutable.get(key) ?? [];
		paths.push({ path: entry.path, itemPath: entry.itemPath });
		mutable.set(key, paths);
	}
	if (isObject(value)) collectionIndexCache.set(value, mutable);
	return mutable.get(stableStringify(target)) ?? [];
}

function valueIndex(
	value: unknown,
	entries: (value: unknown) => ReadonlyArray<[PatternAwarePath, unknown]>,
	cache: WeakMap<object, ValueIndex>,
): ValueIndex {
	if (isObject(value)) {
		const cached = cache.get(value);
		if (cached) return cached;
	}
	const mutable = new Map<string, PatternAwarePath[]>();
	for (const [sourcePath, item] of entries(value)) {
		const key = stableStringify(item);
		const paths = mutable.get(key) ?? [];
		paths.push(sourcePath);
		mutable.set(key, paths);
	}
	if (isObject(value)) cache.set(value, mutable);
	return mutable;
}

function collectionBindings(
	value: unknown,
	target: unknown,
): Array<{ readonly path: PatternAwarePath; readonly itemPath: PatternAwarePath }> {
	const paths = new Map<string, PatternAwarePath>();
	const result: Array<{ readonly path: PatternAwarePath; readonly itemPath: PatternAwarePath }> = [];
	for (const item of collectionEntries(value)) {
		if (!sameValue(item.value, target)) continue;
		const key = `${encodePath(item.path)}:${encodePath(item.itemPath)}`;
		if (paths.has(key)) continue;
		paths.set(key, item.itemPath);
		result.push({ path: item.path, itemPath: item.itemPath });
	}
	return result;
}

type CollectionEntry = {
	readonly path: PatternAwarePath;
	readonly itemPath: PatternAwarePath;
	readonly value: unknown;
};

const collectionCache = new WeakMap<object, ReadonlyArray<CollectionEntry>>();

function collectionEntries(value: unknown, prefix: PatternAwarePath = []): ReadonlyArray<CollectionEntry> {
	const cacheable = prefix.length === 0 && isObject(value);
	if (cacheable) {
		const cached = collectionCache.get(value);
		if (cached) return cached;
	}
	let result: ReadonlyArray<CollectionEntry>;
	if (Array.isArray(value)) {
		result = value.flatMap((item) =>
			leaves(item).map(([itemPath, candidate]) => ({ path: prefix, itemPath, value: candidate })),
		);
	} else {
		const record = asRecord(value);
		result = record ? Object.entries(record).flatMap(([key, item]) => collectionEntries(item, [...prefix, key])) : [];
	}
	if (cacheable) collectionCache.set(value, result);
	return result;
}

function structuredOutput(value: unknown): unknown {
	const record = asRecord(value);
	if (!record) return value;
	if ("structured" in record) return record.structured;
	if ("metadata" in record) return record.metadata;
	if ("output" in record && asRecord(record.output)) return structuredOutput(record.output);
	const result = asRecord(record.result);
	if (result && "value" in result) return result.value;
	return value;
}

function structuredPaths(value: unknown, key = ""): string[] {
	if (typeof value === "string") return isPathField(key) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap((item) => structuredPaths(item, key));
	const record = asRecord(value);
	if (!record) return [];
	return Object.entries(record).flatMap(([name, item]) => structuredPaths(item, name));
}

function normalizeStructuredPaths(value: unknown, key: string, resourceRoot?: string): unknown {
	if (typeof value === "string") return isPathField(key) ? normalizeResourcePath(value, resourceRoot) : value;
	if (Array.isArray(value)) return value.map((item) => normalizeStructuredPaths(item, key, resourceRoot));
	if (ArrayBuffer.isView(value)) return value;
	const record = asRecord(value);
	if (!record) return value;
	return Object.fromEntries(
		Object.entries(record).map(([name, item]) => [name, normalizeStructuredPaths(item, name, resourceRoot)]),
	);
}

function normalizeResourcePath(value: string, resourceRoot?: string) {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
	if (!resourceRoot || !path.isAbsolute(value)) return normalizePath(value);
	const relative = path.relative(resourceRoot, value);
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		return normalizePath(value);
	return normalizePath(relative);
}

function isPathField(key: string) {
	const normalized = key.toLowerCase();
	return (
		normalized === "path" ||
		normalized === "paths" ||
		normalized === "file" ||
		normalized === "files" ||
		normalized === "filepath" ||
		normalized === "filename" ||
		normalized === "directory" ||
		normalized === "cwd" ||
		normalized === "root" ||
		normalized === "uri" ||
		normalized.endsWith("path") ||
		normalized.endsWith("paths")
	);
}

function uniqueComposable(
	values: ReadonlyArray<{ readonly binding: PatternAwareBinding; readonly value: string; readonly path: boolean }>,
) {
	const seen = new Set<string>();
	return values.filter((item) => {
		const key = stableStringify(bindingStructure(item.binding));
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function uniqueBindings(bindings: ReadonlyArray<PatternAwareBinding>) {
	const seen = new Set<string>();
	return bindings.filter((binding) => {
		const key = stableStringify(bindingStructure(binding));
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function bindingMapStructure(bindings: Readonly<Record<string, PatternAwareBinding>>) {
	return Object.fromEntries(Object.entries(bindings).map(([key, binding]) => [key, bindingStructure(binding)]));
}

function bindingStructure(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(bindingStructure);
	const record = asRecord(value);
	if (!record) return value;
	return Object.fromEntries(
		Object.entries(record)
			.filter(([key]) => key !== "variantCounts")
			.map(([key, item]) => [key, bindingStructure(item)]),
	);
}

function bindingDependencies(bindings: Readonly<Record<string, PatternAwareBinding>>): PatternAwareDependency[] {
	return Object.entries(bindings).flatMap(([encoded, binding]) => {
		const sources = uniqueDependencySources(bindingSources(binding));
		return sources.length ? [{ targetPath: decodePath(encoded), sources }] : [];
	});
}

function bindingSources(binding: PatternAwareBinding): PatternAwareDependencySource[] {
	if (binding.type === "event") {
		return [
			{
				relativeEvent: binding.relativeEvent,
				field: binding.field,
				path: binding.path,
			},
		];
	}
	if (binding.type === "each") {
		return [
			{
				relativeEvent: binding.relativeEvent,
				field: binding.field,
				path: binding.path,
				itemPath: binding.itemPath,
			},
		];
	}
	if (binding.type === "constant") return [];
	if (binding.type === "coalesce") return binding.sources.flatMap(bindingSources);
	if (binding.type === "join") return [...bindingSources(binding.left), ...bindingSources(binding.right)];
	return bindingSources(binding.source);
}

function uniqueDependencySources(sources: ReadonlyArray<PatternAwareDependencySource>) {
	const seen = new Set<string>();
	return sources.filter((source) => {
		const key = stableStringify(source);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isPathSource(field: "input" | "output" | "outputPaths", sourcePath: PatternAwarePath, value: string) {
	if (field === "outputPaths") return true;
	if (!value.length || /[\r\n"'|&<>]/.test(value)) return false;
	const key = String(sourcePath.at(-1) ?? "").toLowerCase();
	if (
		field === "output" &&
		["content", "diff", "message", "output", "preview", "stderr", "stdout", "text"].includes(key)
	)
		return false;
	return (
		key.includes("path") ||
		key.includes("file") ||
		key.includes("dir") ||
		key === "cwd" ||
		key === "root" ||
		key === "name" ||
		/[\\/]/.test(value)
	);
}

function evaluateBinding(binding: PatternAwareBinding, context: ReadonlyArray<PatternAwareEvent>): unknown {
	if (binding.type === "constant") return binding.value;
	if (binding.type === "each") {
		const index = context.length + binding.relativeEvent;
		const event = context[index];
		if (!event) return MISSING;
		const collection = getPath(event[binding.field], binding.path);
		if (!Array.isArray(collection)) return MISSING;
		const values = collection.map((item) => getPath(item, binding.itemPath)).filter((value) => value !== MISSING);
		return values.length ? multiValue(values) : MISSING;
	}
	if (binding.type === "join") {
		const left = evaluateBinding(binding.left, context);
		const right = evaluateBinding(binding.right, context);
		const values = bindingValuesFromResult(left).flatMap((leftValue) =>
			bindingValuesFromResult(right).flatMap((rightValue) => {
				if (typeof leftValue !== "string" || typeof rightValue !== "string") return [];
				if (binding.operation === "join_path") return [normalizePath(path.join(leftValue, rightValue))];
				if (binding.operation === "relative_path") return [normalizePath(path.relative(leftValue, rightValue))];
				return [`${leftValue}${binding.separator ?? ""}${rightValue}`];
			}),
		);
		return values.length > 1 ? multiValue(values) : (values[0] ?? MISSING);
	}
	if (binding.type === "coalesce") {
		for (const source of binding.sources) {
			const value = evaluateBinding(source, context);
			if (value !== MISSING) return value;
		}
		return MISSING;
	}
	if (binding.type === "template") {
		const source = evaluateBinding(binding.source, context);
		const values = bindingValuesFromResult(source).flatMap((value) =>
			typeof value === "string" ? [`${binding.prefix}${value}${binding.suffix}`] : [],
		);
		return values.length > 1 ? multiValue(values) : (values[0] ?? MISSING);
	}
	if (binding.type === "transform") {
		const source = evaluateBinding(binding.source, context);
		const values = bindingValuesFromResult(source).flatMap((value) =>
			typeof value === "string" ? [transform(binding.operation, value)] : [],
		);
		return values.length > 1 ? multiValue(values) : (values[0] ?? MISSING);
	}
	const index = context.length + binding.relativeEvent;
	const event = context[index];
	if (!event) return MISSING;
	return getPath(event[binding.field], binding.path);
}

function bindingValues(binding: PatternAwareBinding, context: ReadonlyArray<PatternAwareEvent>) {
	return bindingValuesFromResult(evaluateBinding(binding, context));
}

function bindingValuesFromResult(value: unknown): ReadonlyArray<unknown> {
	if (value === MISSING) return [];
	return isMultiValue(value) ? value.values : [value];
}

function bindingMatches(binding: PatternAwareBinding, context: ReadonlyArray<PatternAwareEvent>, target: unknown) {
	return bindingValues(binding, context).some((value) => sameValue(value, target));
}

function multiValue(values: ReadonlyArray<unknown>): MultiValue {
	const seen = new Set<string>();
	return {
		[MULTI]: true,
		values: values.filter((value) => {
			const key = stableStringify(value);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	};
}

function isMultiValue(value: unknown): value is MultiValue {
	return Boolean(value && typeof value === "object" && MULTI in value);
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

const leavesCache = new WeakMap<object, ReadonlyArray<[PatternAwarePath, unknown]>>();

function leaves(value: unknown, prefix: Array<string | number> = []): Array<[Array<string | number>, unknown]> {
	const cacheable = prefix.length === 0 && isObject(value);
	if (cacheable) {
		const cached = leavesCache.get(value);
		if (cached) return cached.map(([path, item]) => [[...path], item]);
	}
	let result: Array<[Array<string | number>, unknown]>;
	if (Array.isArray(value)) {
		result = value.length ? value.flatMap((item, index) => leaves(item, [...prefix, index])) : [[prefix, []]];
	} else if (value && typeof value === "object") {
		const entries = Object.entries(value);
		result = entries.length ? entries.flatMap(([key, item]) => leaves(item, [...prefix, key])) : [[prefix, {}]];
	} else {
		result = [[prefix, value]];
	}
	if (cacheable) leavesCache.set(value, result);
	return result;
}

function eligible(pattern: MutablePattern, settings: PatternAwareSettings) {
	if (!structurallyEligible(pattern, settings)) return false;
	if (probability(pattern) < settings.minEmpiricalProbability) return false;
	return runtimeEligible(pattern, settings);
}

function runtimeEligible(pattern: MutablePattern, settings: PatternAwareSettings) {
	if (pattern.opportunities < settings.minOccurrences) return true;
	const useful = pattern.consumed * pattern.averageDurationMs;
	const wasted = pattern.unused * pattern.averageDurationMs;
	return useful >= wasted;
}

function structurallyEligible(pattern: MutablePattern, settings: PatternAwareSettings) {
	return (
		pattern.occurrences >= settings.minOccurrences &&
		pattern.replayMatches / Math.max(1, pattern.occurrences) >= settings.minEmpiricalProbability
	);
}

function learnedHorizon(pattern: MutablePattern, settings: PatternAwareSettings, clock: number) {
	const gaps = weightedGaps(pattern, settings, clock).filter(([gap]) => gap <= settings.maxFutureGap);
	if (!gaps.length) return 0;
	const total = gaps.reduce((sum, [, weight]) => sum + weight, 0);
	const target = total * settings.futureGapCoverage;
	let covered = 0;
	for (const [gap, weight] of gaps) {
		covered += weight;
		if (covered >= target) return gap;
	}
	return gaps.at(-1)?.[0] ?? 0;
}

function learnedGroupHorizon(patterns: ReadonlyArray<MutablePattern>, settings: PatternAwareSettings, clock: number) {
	const gaps = combineWeightedGaps(patterns, settings, clock);
	if (!gaps.length) return 0;
	const total = gaps.reduce((sum, [, weight]) => sum + weight, 0);
	const target = total * settings.futureGapCoverage;
	let covered = 0;
	for (const [gap, weight] of gaps) {
		covered += weight;
		if (covered >= target) return gap;
	}
	return gaps.at(-1)?.[0] ?? 0;
}

function groupGapCoverage(
	patterns: ReadonlyArray<MutablePattern>,
	horizon: number,
	settings: PatternAwareSettings,
	clock: number,
) {
	const gaps = combineWeightedGaps(patterns, settings, clock);
	const total = gaps.reduce((sum, [, weight]) => sum + weight, 0);
	if (total <= 0) return 0;
	return Math.max(
		0,
		Math.min(1, gaps.filter(([gap]) => gap <= horizon).reduce((sum, [, weight]) => sum + weight, 0) / total),
	);
}

function combineWeightedGaps(patterns: ReadonlyArray<MutablePattern>, settings: PatternAwareSettings, clock: number) {
	const combined = new Map<number, number>();
	for (const pattern of patterns) {
		for (const [gap, weight] of weightedGaps(pattern, settings, clock)) {
			if (gap > settings.maxFutureGap) continue;
			combined.set(gap, (combined.get(gap) ?? 0) + weight);
		}
	}
	return [...combined.entries()].sort(([left], [right]) => left - right);
}

function weightedGaps(pattern: MutablePattern, settings: PatternAwareSettings, clock: number) {
	return Object.entries(pattern.gapCounts)
		.map(([value, count]) => {
			const gap = Number.parseInt(value, 10);
			const lastSeen = pattern.gapLastSeen[value] ?? pattern.lastSeenSequence;
			return [
				Number.isFinite(gap) ? Math.max(0, gap) : 0,
				Math.max(0, count) * recencyWeight(lastSeen, clock, settings.decayHalfLifeEvents),
			] as const;
		})
		.filter(([, weight]) => weight > 0)
		.sort(([left], [right]) => left - right);
}

function matchesSuffix(history: ReadonlyArray<PatternAwareEvent>, context: ReadonlyArray<PatternAwareEventSignature>) {
	if (!context.length || history.length < context.length) return false;
	return sameSignatures(history.slice(-context.length).map(signature), context);
}

function canonicalBatchActionKey(input: PatternAwareEventInput) {
	return stableStringify({
		tool: input.tool,
		outcome: input.outcome,
		...(input.operation ? { operation: input.operation } : {}),
		input: input.input,
	});
}

function actionHistory(history: ReadonlyArray<PatternAwareEvent>) {
	return history.filter(isActionEvent);
}

function actionBatches(history: ReadonlyArray<PatternAwareEvent>) {
	return indexedActionBatches(history).map((batch) => batch.map((index) => history[index]!));
}

function indexedActionBatches(history: ReadonlyArray<PatternAwareEvent>) {
	const batches: number[][] = [];
	let activeBatchID: string | undefined;
	for (const [index, event] of history.entries()) {
		if (!isActionEvent(event)) continue;
		if (event.batchID && event.batchID === activeBatchID) {
			batches.at(-1)!.push(index);
			continue;
		}
		batches.push([index]);
		activeBatchID = event.batchID;
	}
	return batches;
}

function isActionEvent(event: PatternAwareEvent) {
	return event.tool !== "$llm";
}

function signature(event: PatternAwareEvent): PatternAwareEventSignature {
	const outputShape = semanticOutputShape(event.output);
	return {
		tool: event.tool,
		outcome: event.outcome,
		...(event.operation ? { operation: event.operation } : {}),
		...(outputShape ? { outputShape } : {}),
	};
}

function sameSignatures(
	left: ReadonlyArray<PatternAwareEventSignature>,
	right: ReadonlyArray<PatternAwareEventSignature>,
) {
	if (left.length !== right.length) return false;
	return left.every((item, index) => {
		const expected = right[index]!;
		return (
			item.tool === expected.tool &&
			item.outcome === expected.outcome &&
			item.operation === expected.operation &&
			(expected.outputShape === undefined ||
				item.outputShape === undefined ||
				item.outputShape === expected.outputShape)
		);
	});
}

function signatureToken(value: PatternAwareEventSignature) {
	return stableStringify({
		tool: value.tool,
		outcome: value.outcome,
		...(value.operation ? { operation: value.operation } : {}),
	});
}

function semanticOutputShape(value: unknown) {
	const discriminants: string[] = [];
	const visit = (item: unknown, key = "", depth = 0) => {
		if (depth > 4) return;
		if (
			(typeof item === "string" || typeof item === "number" || typeof item === "boolean") &&
			(key === "kind" || key === "operation" || key === "status" || key === "type")
		) {
			discriminants.push(`${key}:${item}`);
			return;
		}
		if (Array.isArray(item)) {
			if (item.length) visit(item[0], key, depth + 1);
			return;
		}
		const record = asRecord(item);
		if (record) for (const [name, child] of Object.entries(record)) visit(child, name, depth + 1);
	};
	visit(value);
	if (!discriminants.length) return;
	return hash(stableStringify(discriminants.sort()));
}

function backoffProbability(patterns: ReadonlyArray<MutablePattern>, clock: number, halfLife: number) {
	const byLength = new Map<number, MutablePattern>();
	for (const pattern of patterns) {
		const current = byLength.get(pattern.context.length);
		if (!current || current.historicalOpportunities < pattern.historicalOpportunities)
			byLength.set(pattern.context.length, pattern);
	}
	let estimate = 0.5;
	for (const pattern of [...byLength.values()].sort((left, right) => left.context.length - right.context.length)) {
		const weight = recencyWeight(pattern.lastSeenSequence, clock, halfLife);
		const opportunities = Math.max(1, (pattern.historicalOpportunities + pattern.opportunities) * weight);
		const matches = Math.min(opportunities, (pattern.historicalMatches + pattern.consumed) * weight);
		const local = matches / opportunities;
		const escapeProbability = 1 / (opportunities + 1);
		estimate = local * (1 - escapeProbability) + estimate * escapeProbability;
	}
	return Math.max(0, Math.min(1, estimate));
}

function patternRank(pattern: MutablePattern, clock: number, halfLife: number) {
	return (
		(pattern.consumed * 4 + pattern.replayMatches * 2 + probability(pattern) - pattern.unused) *
		recencyWeight(pattern.lastSeenSequence, clock, halfLife)
	);
}

function recencyWeight(lastSeen: number, clock: number, halfLife: number) {
	if (halfLife <= 0) return 1;
	return 2 ** (-Math.max(0, clock - lastSeen) / halfLife);
}

function readonlyPattern(pattern: MutablePattern): PatternAwarePattern {
	return {
		...pattern,
		empiricalProbability: probability(pattern),
		context: pattern.context.map((item) => ({ ...item })),
		bindings: structuredClone(pattern.bindings),
		dependencies: structuredClone(pattern.dependencies),
		gapCounts: { ...pattern.gapCounts },
		gapLastSeen: { ...pattern.gapLastSeen },
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
		dependencies: bindingDependencies(value.bindings),
		...(value.targetSchemaHash ? { targetSchemaHash: value.targetSchemaHash } : {}),
		gapCounts: { ...value.gapCounts },
		gapLastSeen: Object.fromEntries(
			Object.keys(value.gapCounts ?? {}).map((gap) => [
				gap,
				isFiniteNumber(value.gapLastSeen?.[gap]) ? value.gapLastSeen[gap]! : finite(value.lastSeenSequence),
			]),
		),
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

function mutablePool(value: unknown): PatternPool | undefined {
	const record = asRecord(value);
	if (
		!record ||
		typeof record.key !== "string" ||
		typeof record.targetTool !== "string" ||
		!Array.isArray(record.context) ||
		!record.context.every(isEventSignature) ||
		!Array.isArray(record.samples)
	)
		return;
	const samples = record.samples.flatMap((item) => {
		const sample = asRecord(item);
		if (
			!sample ||
			!Array.isArray(sample.context) ||
			!sample.context.every(isPersistedEvent) ||
			!isPersistedEvent(sample.target) ||
			!isFiniteNumber(sample.gap)
		)
			return [];
		return [
			{
				context: structuredClone(sample.context) as PatternAwareEvent[],
				target: structuredClone(sample.target) as PatternAwareEvent,
				gap: Math.max(0, Math.floor(sample.gap)),
			},
		];
	});
	if (!samples.length) return;
	return {
		key: record.key,
		context: structuredClone(record.context) as PatternAwareEventSignature[],
		targetTool: record.targetTool,
		...(typeof record.targetSchemaHash === "string" ? { targetSchemaHash: record.targetSchemaHash } : {}),
		samples,
	};
}

function isEventSignature(value: unknown): value is PatternAwareEventSignature {
	const record = asRecord(value);
	return (
		!!record &&
		typeof record.tool === "string" &&
		(record.outcome === "success" || record.outcome === "failure") &&
		(record.operation === undefined || typeof record.operation === "string") &&
		(record.outputShape === undefined || typeof record.outputShape === "string")
	);
}

function isPersistedEvent(value: unknown): value is PatternAwareEvent {
	const record = asRecord(value);
	return (
		!!record &&
		typeof record.sessionID === "string" &&
		typeof record.turnID === "string" &&
		typeof record.tool === "string" &&
		!!asRecord(record.input) &&
		(record.outcome === "success" || record.outcome === "failure") &&
		isFiniteNumber(record.durationMs) &&
		isFiniteNumber(record.sequence)
	);
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

function uniqueStrings(values: ReadonlyArray<string>) {
	return [...new Set(values.filter((value) => value.length > 0))];
}

function normalizePath(value: string) {
	return path.normalize(value).replaceAll("\\", "/");
}

function hash(value: string) {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isObject(value: unknown): value is object {
	return value !== null && typeof value === "object";
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
