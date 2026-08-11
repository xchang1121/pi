import type { ActionKey, ActionKeyMatch, ActionKeyProjector } from "./common.ts";
import { actionKeyMatch, actionKeyProjectionPartitions } from "./common.ts";

export interface ToolCacheEntry {
	readonly key: ActionKey;
	readonly estimatedBytes: number;
}

export interface ToolCacheLimits {
	readonly maxEntries: number;
	readonly maxBytes: number;
}

interface ScopedToolCache<Entry> {
	readonly entries: Map<string, Entry>;
	readonly partitions: Map<string, Set<Entry>>;
}

interface RankedToolCacheEntry<Entry> {
	readonly entry: Entry;
	readonly match: ActionKeyMatch;
	readonly recency: number;
}

/** Per-scope LRU for running or completed tool jobs, indexed by exact and projectable action identity. */
export class ToolCache<Scope, Entry extends ToolCacheEntry> {
	private readonly sessions = new Map<Scope, ScopedToolCache<Entry>>();
	private readonly projectors: readonly ActionKeyProjector[];

	constructor(projectors: readonly ActionKeyProjector[] = []) {
		this.projectors = [...projectors];
	}

	/** Insert only when the exact action is absent, returning the existing single-flight job on conflict. */
	insert(scope: Scope, entry: Entry): Entry | undefined {
		const state = this.ensureScope(scope);
		const existing = state.entries.get(entry.key.key);
		if (existing) return existing;
		state.entries.set(entry.key.key, entry);
		this.addToPartitions(state, entry);
		return undefined;
	}

	getExact(scope: Scope, action: ActionKey): Entry | undefined {
		return this.sessions.get(scope)?.entries.get(action.key);
	}

	/** Return compatible jobs from tightest to broadest, breaking ties in favor of the newest access. */
	matching(scope: Scope, action: ActionKey): readonly Entry[] {
		const state = this.sessions.get(scope);
		if (!state) return [];
		const candidates = new Set<Entry>();
		const exact = state.entries.get(action.key);
		if (exact) candidates.add(exact);
		for (const key of actionKeyProjectionPartitions(action, this.projectors)) {
			for (const entry of state.partitions.get(key) ?? []) candidates.add(entry);
		}
		const ranked: RankedToolCacheEntry<Entry>[] = [];
		let recency = 0;
		for (const entry of candidates) {
			const match = actionKeyMatch(entry.key, action, this.projectors);
			if (match) ranked.push({ entry, match, recency });
			recency++;
		}
		ranked.sort((left, right) => left.match.distance - right.match.distance || right.recency - left.recency);
		return ranked.map((item) => item.entry);
	}

	touch(scope: Scope, entry: Entry): boolean {
		const state = this.sessions.get(scope);
		if (!state || state.entries.get(entry.key.key) !== entry) return false;
		state.entries.delete(entry.key.key);
		state.entries.set(entry.key.key, entry);
		for (const key of actionKeyProjectionPartitions(entry.key, this.projectors)) {
			const partition = state.partitions.get(key);
			if (partition) {
				partition.delete(entry);
				partition.add(entry);
			}
		}
		return true;
	}

	delete(scope: Scope, entry: Entry): boolean {
		const state = this.sessions.get(scope);
		if (!state || state.entries.get(entry.key.key) !== entry) return false;
		state.entries.delete(entry.key.key);
		this.removeFromPartitions(state, entry);
		if (state.entries.size === 0) this.sessions.delete(scope);
		return true;
	}

	values(scope: Scope): readonly Entry[] {
		return [...(this.sessions.get(scope)?.entries.values() ?? [])];
	}

	allValues(): readonly Entry[] {
		return [...this.sessions.values()].flatMap((state) => [...state.entries.values()]);
	}

	scopes(): readonly Scope[] {
		return [...this.sessions.keys()];
	}

	trim(scope: Scope, limits: ToolCacheLimits, canEvict: (entry: Entry) => boolean = () => true): Entry[] {
		const state = this.sessions.get(scope);
		if (!state) return [];
		const maxEntries = finiteLimit(limits.maxEntries);
		const maxBytes = finiteLimit(limits.maxBytes);
		let bytes = [...state.entries.values()].reduce((total, entry) => total + entryBytes(entry), 0);
		const evicted: Entry[] = [];
		while (state.entries.size > maxEntries || bytes > maxBytes) {
			const victim = [...state.entries.values()].find(canEvict);
			if (!victim) break;
			bytes -= entryBytes(victim);
			this.delete(scope, victim);
			evicted.push(victim);
		}
		return evicted;
	}

	clearScope(scope: Scope): Entry[] {
		const state = this.sessions.get(scope);
		if (!state) return [];
		this.sessions.delete(scope);
		return [...state.entries.values()];
	}

	private ensureScope(scope: Scope): ScopedToolCache<Entry> {
		const existing = this.sessions.get(scope);
		if (existing) return existing;
		const created: ScopedToolCache<Entry> = { entries: new Map(), partitions: new Map() };
		this.sessions.set(scope, created);
		return created;
	}

	private addToPartitions(state: ScopedToolCache<Entry>, entry: Entry): void {
		for (const key of actionKeyProjectionPartitions(entry.key, this.projectors)) {
			const partition = state.partitions.get(key) ?? new Set<Entry>();
			partition.add(entry);
			state.partitions.set(key, partition);
		}
	}

	private removeFromPartitions(state: ScopedToolCache<Entry>, entry: Entry): void {
		for (const key of actionKeyProjectionPartitions(entry.key, this.projectors)) {
			const partition = state.partitions.get(key);
			if (!partition) continue;
			partition.delete(entry);
			if (partition.size === 0) state.partitions.delete(key);
		}
	}
}

function finiteLimit(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function entryBytes(entry: ToolCacheEntry): number {
	return Number.isFinite(entry.estimatedBytes) ? Math.max(0, entry.estimatedBytes) : 0;
}
