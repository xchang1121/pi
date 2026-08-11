import type { ActionKey, ActionKeyMatch, ActionKeyProjector } from "./common.ts";
import { actionKeyMatch, actionKeyProjectionPartitions } from "./common.ts";

export interface ToolCacheEntry {
	readonly key: ActionKey;
	readonly estimatedBytes: number;
}

export type ToolCacheEntryState = "probation" | "protected";

export interface ToolCacheLimits {
	readonly maxEntries: number;
	readonly maxBytes: number;
	/** Maximum protected share; older protected entries are demoted before eviction pressure. */
	readonly protectedFraction?: number;
}

export interface ToolCacheLookup<Entry> {
	readonly entry: Entry;
	readonly match: ActionKeyMatch;
	readonly state: ToolCacheEntryState;
}

export interface ToolCacheSnapshot {
	readonly probationEntries: number;
	readonly protectedEntries: number;
	readonly probationBytes: number;
	readonly protectedBytes: number;
}

interface CachedToolEntry<Entry> {
	readonly entry: Entry;
	state: ToolCacheEntryState;
}

interface ScopedToolCache<Entry> {
	readonly entries: Map<string, CachedToolEntry<Entry>>;
	readonly partitions: Map<string, Set<CachedToolEntry<Entry>>>;
}

interface RankedToolCacheEntry<Entry> extends ToolCacheLookup<Entry> {
	readonly recency: number;
}

/** Per-scope, projection-indexed cache with speculative probation and actor-validated protection. */
export class ToolCache<Scope, Entry extends ToolCacheEntry> {
	private readonly sessions = new Map<Scope, ScopedToolCache<Entry>>();
	private readonly projectors: readonly ActionKeyProjector[];

	constructor(projectors: readonly ActionKeyProjector[] = []) {
		this.projectors = [...projectors];
	}

	/** Insert a speculative entry into probation, returning an existing exact single-flight job on conflict. */
	insert(scope: Scope, entry: Entry): Entry | undefined {
		const state = this.ensureScope(scope);
		const existing = state.entries.get(entry.key.key);
		if (existing) return existing.entry;
		const record: CachedToolEntry<Entry> = { entry, state: "probation" };
		state.entries.set(entry.key.key, record);
		this.addToPartitions(state, record);
		return undefined;
	}

	getExact(scope: Scope, action: ActionKey): Entry | undefined {
		return this.sessions.get(scope)?.entries.get(action.key)?.entry;
	}

	/** Return compatible jobs from tightest to broadest without changing authoritative recency. */
	lookup(scope: Scope, action: ActionKey): readonly ToolCacheLookup<Entry>[] {
		const state = this.sessions.get(scope);
		if (!state) return [];
		const candidates = new Set<CachedToolEntry<Entry>>();
		const exact = state.entries.get(action.key);
		if (exact) candidates.add(exact);
		for (const key of actionKeyProjectionPartitions(action, this.projectors)) {
			for (const record of state.partitions.get(key) ?? []) candidates.add(record);
		}
		const recency = new Map<CachedToolEntry<Entry>, number>();
		let index = 0;
		for (const record of state.entries.values()) recency.set(record, index++);
		const ranked: RankedToolCacheEntry<Entry>[] = [];
		for (const record of candidates) {
			const match = actionKeyMatch(record.entry.key, action, this.projectors);
			if (!match) continue;
			ranked.push({
				entry: record.entry,
				match,
				state: record.state,
				recency: recency.get(record) ?? 0,
			});
		}
		ranked.sort((left, right) => left.match.distance - right.match.distance || right.recency - left.recency);
		return ranked.map(({ entry, match, state: entryState }) => ({ entry, match, state: entryState }));
	}

	matching(scope: Scope, action: ActionKey): readonly Entry[] {
		return this.lookup(scope, action).map((item) => item.entry);
	}

	/** Promote only after a real actor consumes the entry; speculative reuse must not call this method. */
	recordActorHit(scope: Scope, entry: Entry, limits?: ToolCacheLimits): readonly Entry[] {
		const state = this.sessions.get(scope);
		const record = state?.entries.get(entry.key.key);
		if (!state || !record || record.entry !== entry) return [];
		record.state = "protected";
		state.entries.delete(entry.key.key);
		state.entries.set(entry.key.key, record);
		return limits ? this.rebalanceProtected(state, limits) : [];
	}

	stateOf(scope: Scope, entry: Entry): ToolCacheEntryState | undefined {
		const record = this.sessions.get(scope)?.entries.get(entry.key.key);
		return record?.entry === entry ? record.state : undefined;
	}

	delete(scope: Scope, entry: Entry): boolean {
		const state = this.sessions.get(scope);
		const record = state?.entries.get(entry.key.key);
		if (!state || !record || record.entry !== entry) return false;
		state.entries.delete(entry.key.key);
		this.removeFromPartitions(state, record);
		if (state.entries.size === 0) this.sessions.delete(scope);
		return true;
	}

	values(scope: Scope): readonly Entry[] {
		return [...(this.sessions.get(scope)?.entries.values() ?? [])].map((record) => record.entry);
	}

	allValues(): readonly Entry[] {
		return [...this.sessions.values()].flatMap((state) => [...state.entries.values()].map((record) => record.entry));
	}

	scopes(): readonly Scope[] {
		return [...this.sessions.keys()];
	}

	snapshot(scope: Scope): ToolCacheSnapshot {
		const records = [...(this.sessions.get(scope)?.entries.values() ?? [])];
		let probationEntries = 0;
		let protectedEntries = 0;
		let probationBytes = 0;
		let protectedBytes = 0;
		for (const record of records) {
			const bytes = entryBytes(record.entry);
			if (record.state === "protected") {
				protectedEntries++;
				protectedBytes += bytes;
			} else {
				probationEntries++;
				probationBytes += bytes;
			}
		}
		return { probationEntries, protectedEntries, probationBytes, protectedBytes };
	}

	/** Evict actor-unvalidated probation before protected entries, preserving order within each tier. */
	trim(scope: Scope, limits: ToolCacheLimits, canEvict: (entry: Entry) => boolean = () => true): Entry[] {
		const state = this.sessions.get(scope);
		if (!state) return [];
		const maxEntries = finiteLimit(limits.maxEntries);
		const maxBytes = finiteLimit(limits.maxBytes);
		let bytes = [...state.entries.values()].reduce((total, record) => total + entryBytes(record.entry), 0);
		const evicted: Entry[] = [];
		while (state.entries.size > maxEntries || bytes > maxBytes) {
			const records = [...state.entries.values()];
			const victim =
				records.find((record) => record.state === "probation" && canEvict(record.entry)) ??
				records.find((record) => record.state === "protected" && canEvict(record.entry));
			if (!victim) break;
			bytes -= entryBytes(victim.entry);
			this.delete(scope, victim.entry);
			evicted.push(victim.entry);
		}
		return evicted;
	}

	clearScope(scope: Scope): Entry[] {
		const state = this.sessions.get(scope);
		if (!state) return [];
		this.sessions.delete(scope);
		return [...state.entries.values()].map((record) => record.entry);
	}

	private ensureScope(scope: Scope): ScopedToolCache<Entry> {
		const existing = this.sessions.get(scope);
		if (existing) return existing;
		const created: ScopedToolCache<Entry> = { entries: new Map(), partitions: new Map() };
		this.sessions.set(scope, created);
		return created;
	}

	private rebalanceProtected(state: ScopedToolCache<Entry>, limits: ToolCacheLimits): readonly Entry[] {
		const fraction = finiteFraction(limits.protectedFraction ?? 0.8);
		const entryCapacity = finiteLimit(limits.maxEntries);
		const byteCapacity = finiteLimit(limits.maxBytes);
		const protectedEntryLimit =
			entryCapacity === 0 || fraction === 0 ? 0 : Math.max(1, Math.floor(entryCapacity * fraction));
		const protectedByteLimit = Math.floor(byteCapacity * fraction);
		const demoted: Entry[] = [];
		while (true) {
			const protectedRecords = [...state.entries.values()].filter((record) => record.state === "protected");
			const protectedBytes = protectedRecords.reduce((total, record) => total + entryBytes(record.entry), 0);
			if (protectedRecords.length <= protectedEntryLimit && protectedBytes <= protectedByteLimit) break;
			const victim = protectedRecords[0];
			if (!victim) break;
			victim.state = "probation";
			demoted.push(victim.entry);
		}
		return demoted;
	}

	private addToPartitions(state: ScopedToolCache<Entry>, record: CachedToolEntry<Entry>): void {
		for (const key of actionKeyProjectionPartitions(record.entry.key, this.projectors)) {
			const partition = state.partitions.get(key) ?? new Set<CachedToolEntry<Entry>>();
			partition.add(record);
			state.partitions.set(key, partition);
		}
	}

	private removeFromPartitions(state: ScopedToolCache<Entry>, record: CachedToolEntry<Entry>): void {
		for (const key of actionKeyProjectionPartitions(record.entry.key, this.projectors)) {
			const partition = state.partitions.get(key);
			if (!partition) continue;
			partition.delete(record);
			if (partition.size === 0) state.partitions.delete(key);
		}
	}
}

function finiteLimit(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finiteFraction(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
}

function entryBytes(entry: ToolCacheEntry): number {
	return Number.isFinite(entry.estimatedBytes) ? Math.max(0, entry.estimatedBytes) : 0;
}
