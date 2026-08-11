import type { ActionKey, ActionKeyMatch, ActionKeyProjector, ProjectedActionKeyMatch } from "./common.ts";
import { actionKeyMatch, actionKeyProjectionPartitions } from "./common.ts";

export interface ActionStoreEntry {
	readonly key: ActionKey;
}

export interface SizedActionStoreEntry extends ActionStoreEntry {
	readonly estimatedBytes: number;
}

export interface ActionStoreLookup<Entry> {
	readonly entry: Entry;
	readonly match: ActionKeyMatch;
}

export interface ActionStoreInsertResult<Entry> extends ActionStoreLookup<Entry> {
	readonly inserted: boolean;
}

export interface ActionStoreLimits {
	readonly maxEntries: number;
	readonly maxBytes: number;
}

export interface ActionStoreSnapshot {
	readonly entries: number;
	readonly bytes: number;
}

interface IndexedActionStoreLookup<Entry> extends ActionStoreLookup<Entry> {
	readonly recency: number;
}

interface IndexedScope<Entry> {
	readonly entries: Map<string, Entry>;
	readonly partitions: Map<string, Set<Entry>>;
}

/** Scoped action identity, projection lookup, recency, and bounded storage. */
export class ActionStore<Scope, Entry extends SizedActionStoreEntry> {
	private readonly scopesByID = new Map<Scope, IndexedScope<Entry>>();
	private readonly projectors: readonly ActionKeyProjector[];

	constructor(projectors: readonly ActionKeyProjector[] = []) {
		this.projectors = [...projectors];
	}

	insert(scope: Scope, entry: Entry): Entry | undefined {
		const state = this.ensureScope(scope);
		const existing = state.entries.get(entry.key.key);
		if (existing) return existing;
		state.entries.set(entry.key.key, entry);
		this.addToPartitions(state, entry);
		return undefined;
	}

	insertOrGetCompatible(
		scope: Scope,
		entry: Entry,
		canReuseProjected: (existing: Entry, match: ProjectedActionKeyMatch) => boolean = () => false,
	): ActionStoreInsertResult<Entry> {
		const state = this.ensureScope(scope);
		const exact = state.entries.get(entry.key.key);
		if (exact) return { entry: exact, match: { kind: "exact", distance: 0 }, inserted: false };
		for (const candidate of this.lookupRecords(state, entry.key)) {
			if (candidate.match.kind === "exact") {
				return { entry: candidate.entry, match: candidate.match, inserted: false };
			}
			if (!canReuseProjected(candidate.entry, candidate.match)) continue;
			return { entry: candidate.entry, match: candidate.match, inserted: false };
		}
		state.entries.set(entry.key.key, entry);
		this.addToPartitions(state, entry);
		return { entry, match: { kind: "exact", distance: 0 }, inserted: true };
	}

	getExact(scope: Scope, action: ActionKey): Entry | undefined {
		return this.scopesByID.get(scope)?.entries.get(action.key);
	}

	lookup(scope: Scope, action: ActionKey): readonly ActionStoreLookup<Entry>[] {
		const state = this.scopesByID.get(scope);
		return state ? this.lookupRecords(state, action).map(({ entry, match }) => ({ entry, match })) : [];
	}

	touch(scope: Scope, entry: Entry): boolean {
		const state = this.scopesByID.get(scope);
		if (!state || state.entries.get(entry.key.key) !== entry) return false;
		state.entries.delete(entry.key.key);
		state.entries.set(entry.key.key, entry);
		return true;
	}

	delete(scope: Scope, entry: Entry): boolean {
		const state = this.scopesByID.get(scope);
		if (!state || state.entries.get(entry.key.key) !== entry) return false;
		state.entries.delete(entry.key.key);
		this.removeFromPartitions(state, entry);
		if (state.entries.size === 0) this.scopesByID.delete(scope);
		return true;
	}

	values(scope: Scope): readonly Entry[] {
		return [...(this.scopesByID.get(scope)?.entries.values() ?? [])];
	}

	allValues(): readonly Entry[] {
		return [...this.scopesByID.values()].flatMap((state) => [...state.entries.values()]);
	}

	scopes(): readonly Scope[] {
		return [...this.scopesByID.keys()];
	}

	snapshot(scope: Scope): ActionStoreSnapshot {
		const entries = this.values(scope);
		return { entries: entries.length, bytes: entries.reduce((total, entry) => total + entryBytes(entry), 0) };
	}

	trim(scope: Scope, limits: ActionStoreLimits, canEvict: (entry: Entry) => boolean = () => true): Entry[] {
		const maxEntries = finiteLimit(limits.maxEntries);
		const maxBytes = finiteLimit(limits.maxBytes);
		let entries = this.values(scope);
		let bytes = entries.reduce((total, entry) => total + entryBytes(entry), 0);
		const evicted: Entry[] = [];
		while (entries.length > maxEntries || bytes > maxBytes) {
			const victim = entries.find(canEvict);
			if (!victim) break;
			bytes -= entryBytes(victim);
			this.delete(scope, victim);
			evicted.push(victim);
			entries = this.values(scope);
		}
		return evicted;
	}

	private lookupRecords(state: IndexedScope<Entry>, action: ActionKey): readonly IndexedActionStoreLookup<Entry>[] {
		const candidates = new Set<Entry>();
		const exact = state.entries.get(action.key);
		if (exact) candidates.add(exact);
		for (const key of actionKeyProjectionPartitions(action, this.projectors)) {
			for (const entry of state.partitions.get(key) ?? []) candidates.add(entry);
		}
		const recency = new Map<Entry, number>();
		let index = 0;
		for (const entry of state.entries.values()) recency.set(entry, index++);
		const ranked: IndexedActionStoreLookup<Entry>[] = [];
		for (const entry of candidates) {
			const match = actionKeyMatch(entry.key, action, this.projectors);
			if (!match) continue;
			ranked.push({ entry, match, recency: recency.get(entry) ?? 0 });
		}
		ranked.sort((left, right) => left.match.distance - right.match.distance || right.recency - left.recency);
		return ranked;
	}

	private ensureScope(scope: Scope): IndexedScope<Entry> {
		const existing = this.scopesByID.get(scope);
		if (existing) return existing;
		const created: IndexedScope<Entry> = { entries: new Map(), partitions: new Map() };
		this.scopesByID.set(scope, created);
		return created;
	}

	private addToPartitions(state: IndexedScope<Entry>, entry: Entry): void {
		for (const key of actionKeyProjectionPartitions(entry.key, this.projectors)) {
			const partition = state.partitions.get(key) ?? new Set<Entry>();
			partition.add(entry);
			state.partitions.set(key, partition);
		}
	}

	private removeFromPartitions(state: IndexedScope<Entry>, entry: Entry): void {
		for (const key of actionKeyProjectionPartitions(entry.key, this.projectors)) {
			const partition = state.partitions.get(key);
			if (!partition) continue;
			partition.delete(entry);
			if (partition.size === 0) state.partitions.delete(key);
		}
	}
}

export type ResultCacheEntryState = "probation" | "protected";

export interface ResultCacheLimits {
	readonly maxEntries: number;
	readonly maxBytes: number;
	/** Maximum protected share; older protected entries are demoted before eviction pressure. */
	readonly protectedFraction?: number;
}

export interface ResultCacheProbationPolicy {
	readonly maxAgeMs: number;
	readonly maxOpportunities: number;
}

export interface SpeculativeCacheValueMetrics {
	readonly executionMs: number;
	readonly validationMs: number;
	readonly projectionMs: number;
	readonly bytes: number;
	readonly hits: number;
	readonly createdAt: number;
	readonly lastHitAt?: number;
}

export const CACHE_HIT_HALF_LIFE_MS = 30 * 60 * 1000;

export function speculativeCacheValue(
	metrics: SpeculativeCacheValueMetrics,
	now = Date.now(),
	halfLifeMs = CACHE_HIT_HALF_LIFE_MS,
): number {
	const savedMs = Math.max(
		0,
		finiteValue(metrics.executionMs) - finiteValue(metrics.validationMs) - finiteValue(metrics.projectionMs),
	);
	const referenceAt = metrics.hits > 0 ? (metrics.lastHitAt ?? metrics.createdAt) : metrics.createdAt;
	const ageMs = Math.max(0, finiteValue(now - referenceAt));
	const decay = halfLifeMs > 0 ? 2 ** (-ageMs / halfLifeMs) : 0;
	const reuseWeight = metrics.hits > 0 ? 1 + finiteValue(metrics.hits) * decay : 0.1 * decay;
	return (reuseWeight * savedMs) / (finiteValue(metrics.bytes) + 4096);
}

type CacheMetadata =
	| { readonly state: "probation"; readonly createdAt: number; readonly opportunities: number }
	| { readonly state: "protected" };

export interface ResultCacheLookup<Entry> extends ActionStoreLookup<Entry> {
	readonly state: ResultCacheEntryState;
}

export interface ResultCacheInsertResult<Entry> extends ResultCacheLookup<Entry> {
	readonly inserted: boolean;
}

export interface ResultCacheSnapshot {
	readonly probationEntries: number;
	readonly protectedEntries: number;
	readonly probationBytes: number;
	readonly protectedBytes: number;
}

/** Completed shareable results with speculative probation and actor-validated protection. */
export class ResultCache<Scope, Entry extends SizedActionStoreEntry> {
	private readonly index: ActionStore<Scope, Entry>;
	private readonly metadata = new Map<Scope, Map<Entry, CacheMetadata>>();
	private readonly score: (entry: Entry, now: number) => number;
	private readonly now: () => number;

	constructor(
		projectors: readonly ActionKeyProjector[] = [],
		score: (entry: Entry, now: number) => number = () => 0,
		now: () => number = Date.now,
	) {
		this.index = new ActionStore(projectors);
		this.score = score;
		this.now = now;
	}

	insert(scope: Scope, entry: Entry): Entry | undefined {
		const existing = this.index.insert(scope, entry);
		if (!existing) this.placeOnProbation(scope, entry);
		return existing;
	}

	insertOrGetCompatible(
		scope: Scope,
		entry: Entry,
		canReuseProjected: (existing: Entry, match: ProjectedActionKeyMatch) => boolean = () => false,
	): ResultCacheInsertResult<Entry> {
		const result = this.index.insertOrGetCompatible(scope, entry, canReuseProjected);
		if (result.inserted) this.placeOnProbation(scope, entry);
		return { ...result, state: this.stateOf(scope, result.entry) ?? "probation" };
	}

	lookup(scope: Scope, action: ActionKey): readonly ResultCacheLookup<Entry>[] {
		return this.index.lookup(scope, action).map((item) => ({
			entry: item.entry,
			match: item.match,
			state: this.stateOf(scope, item.entry) ?? "probation",
		}));
	}

	recordActorHit(scope: Scope, entry: Entry, limits?: ResultCacheLimits): readonly Entry[] {
		if (this.index.getExact(scope, entry.key) !== entry) return [];
		this.metadataFor(scope).set(entry, { state: "protected" });
		this.index.touch(scope, entry);
		return limits ? this.rebalanceProtected(scope, limits) : [];
	}

	advanceActorOpportunity(scope: Scope, policy: ResultCacheProbationPolicy): readonly Entry[] {
		const now = this.now();
		const maxAgeMs = expirationLimit(policy.maxAgeMs);
		const maxOpportunities = expirationLimit(policy.maxOpportunities);
		const expired: Entry[] = [];
		for (const entry of this.index.values(scope)) {
			const current = this.metadata.get(scope)?.get(entry);
			if (!current || current.state !== "probation") continue;
			if (now - current.createdAt >= maxAgeMs || current.opportunities >= maxOpportunities) {
				this.delete(scope, entry);
				expired.push(entry);
				continue;
			}
			this.metadataFor(scope).set(entry, { ...current, opportunities: current.opportunities + 1 });
		}
		return expired;
	}

	stateOf(scope: Scope, entry: Entry): ResultCacheEntryState | undefined {
		return this.index.getExact(scope, entry.key) === entry ? this.metadata.get(scope)?.get(entry)?.state : undefined;
	}

	delete(scope: Scope, entry: Entry): boolean {
		if (!this.index.delete(scope, entry)) return false;
		const metadata = this.metadata.get(scope);
		metadata?.delete(entry);
		if (metadata?.size === 0) this.metadata.delete(scope);
		return true;
	}

	values(scope: Scope): readonly Entry[] {
		return this.index.values(scope);
	}

	allValues(): readonly Entry[] {
		return this.index.allValues();
	}

	scopes(): readonly Scope[] {
		return this.index.scopes();
	}

	snapshot(scope: Scope): ResultCacheSnapshot {
		let probationEntries = 0;
		let protectedEntries = 0;
		let probationBytes = 0;
		let protectedBytes = 0;
		for (const entry of this.index.values(scope)) {
			const bytes = entryBytes(entry);
			if (this.stateOf(scope, entry) === "protected") {
				protectedEntries++;
				protectedBytes += bytes;
			} else {
				probationEntries++;
				probationBytes += bytes;
			}
		}
		return { probationEntries, protectedEntries, probationBytes, protectedBytes };
	}

	trim(scope: Scope, limits: ResultCacheLimits, canEvict: (entry: Entry) => boolean = () => true): Entry[] {
		const maxEntries = finiteLimit(limits.maxEntries);
		const maxBytes = finiteLimit(limits.maxBytes);
		let entries = this.index.values(scope);
		let bytes = entries.reduce((total, entry) => total + entryBytes(entry), 0);
		const evicted: Entry[] = [];
		while (entries.length > maxEntries || bytes > maxBytes) {
			const victim =
				this.lowestValue(
					entries.filter((entry) => this.stateOf(scope, entry) === "probation" && canEvict(entry)),
				) ??
				this.lowestValue(entries.filter((entry) => this.stateOf(scope, entry) === "protected" && canEvict(entry)));
			if (!victim) break;
			bytes -= entryBytes(victim);
			this.delete(scope, victim);
			evicted.push(victim);
			entries = this.index.values(scope);
		}
		return evicted;
	}

	private metadataFor(scope: Scope): Map<Entry, CacheMetadata> {
		const existing = this.metadata.get(scope);
		if (existing) return existing;
		const created = new Map<Entry, CacheMetadata>();
		this.metadata.set(scope, created);
		return created;
	}

	private placeOnProbation(scope: Scope, entry: Entry): void {
		this.metadataFor(scope).set(entry, { state: "probation", createdAt: this.now(), opportunities: 0 });
	}

	private rebalanceProtected(scope: Scope, limits: ResultCacheLimits): readonly Entry[] {
		const fraction = finiteFraction(limits.protectedFraction ?? 0.8);
		const entryCapacity = finiteLimit(limits.maxEntries);
		const byteCapacity = finiteLimit(limits.maxBytes);
		const protectedEntryLimit =
			entryCapacity === 0 || fraction === 0 ? 0 : Math.max(1, Math.floor(entryCapacity * fraction));
		const protectedByteLimit = Math.floor(byteCapacity * fraction);
		const demoted: Entry[] = [];
		const now = this.now();
		while (true) {
			const protectedEntries = this.index
				.values(scope)
				.filter((entry) => this.stateOf(scope, entry) === "protected");
			const protectedBytes = protectedEntries.reduce((total, entry) => total + entryBytes(entry), 0);
			if (protectedEntries.length <= protectedEntryLimit && protectedBytes <= protectedByteLimit) break;
			const victim = this.lowestValue(protectedEntries, now);
			if (!victim) break;
			this.metadataFor(scope).set(victim, { state: "probation", createdAt: now, opportunities: 0 });
			demoted.push(victim);
		}
		return demoted;
	}

	private lowestValue(entries: readonly Entry[], now = this.now()): Entry | undefined {
		return entries.reduce<Entry | undefined>(
			(lowest, entry) =>
				!lowest || finiteValue(this.score(entry, now)) < finiteValue(this.score(lowest, now)) ? entry : lowest,
			undefined,
		);
	}
}

function finiteLimit(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finiteFraction(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
}

function finiteValue(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function expirationLimit(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : Number.POSITIVE_INFINITY;
}

function entryBytes(entry: SizedActionStoreEntry): number {
	return Number.isFinite(entry.estimatedBytes) ? Math.max(0, entry.estimatedBytes) : 0;
}
