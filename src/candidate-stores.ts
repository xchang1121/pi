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

interface IndexedActionStoreLookup<Entry> extends ActionStoreLookup<Entry> {
	readonly recency: number;
}

interface IndexedScope<Entry> {
	readonly entries: Map<string, Entry>;
	readonly partitions: Map<string, Set<Entry>>;
}

/** Projection-aware identity index shared by the three candidate stores. */
class ActionIndex<Scope, Entry extends ActionStoreEntry> {
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

	lookup(scope: Scope, action: ActionKey): readonly IndexedActionStoreLookup<Entry>[] {
		const state = this.scopesByID.get(scope);
		return state ? this.lookupRecords(state, action) : [];
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

	clearScope(scope: Scope): Entry[] {
		const state = this.scopesByID.get(scope);
		if (!state) return [];
		this.scopesByID.delete(scope);
		return [...state.entries.values()];
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

/** In-flight single-flight owners. Entries leave this table before becoming reusable results or branches. */
export class JobTable<Scope, Job extends ActionStoreEntry> {
	private readonly index: ActionIndex<Scope, Job>;

	constructor(projectors: readonly ActionKeyProjector[] = []) {
		this.index = new ActionIndex(projectors);
	}

	insertOrGetCompatible(
		scope: Scope,
		job: Job,
		canReuseProjected?: (existing: Job, match: ProjectedActionKeyMatch) => boolean,
	): ActionStoreInsertResult<Job> {
		return this.index.insertOrGetCompatible(scope, job, canReuseProjected);
	}

	getExact(scope: Scope, action: ActionKey): Job | undefined {
		return this.index.getExact(scope, action);
	}

	lookup(scope: Scope, action: ActionKey): readonly ActionStoreLookup<Job>[] {
		return this.index.lookup(scope, action).map(({ entry, match }) => ({ entry, match }));
	}

	delete(scope: Scope, job: Job): boolean {
		return this.index.delete(scope, job);
	}

	values(scope: Scope): readonly Job[] {
		return this.index.values(scope);
	}

	allValues(): readonly Job[] {
		return this.index.allValues();
	}

	scopes(): readonly Scope[] {
		return this.index.scopes();
	}

	clearScope(scope: Scope): Job[] {
		return this.index.clearScope(scope);
	}
}

export type ResultCacheEntryState = "probation" | "protected";

export interface ResultCacheLimits {
	readonly maxEntries: number;
	readonly maxBytes: number;
	/** Maximum protected share; older protected entries are demoted before eviction pressure. */
	readonly protectedFraction?: number;
}

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
	private readonly index: ActionIndex<Scope, Entry>;
	private readonly tiers = new Map<Scope, Map<Entry, ResultCacheEntryState>>();

	constructor(projectors: readonly ActionKeyProjector[] = []) {
		this.index = new ActionIndex(projectors);
	}

	insert(scope: Scope, entry: Entry): Entry | undefined {
		const existing = this.index.insert(scope, entry);
		if (!existing) this.tiersFor(scope).set(entry, "probation");
		return existing;
	}

	insertOrGetCompatible(
		scope: Scope,
		entry: Entry,
		canReuseProjected: (existing: Entry, match: ProjectedActionKeyMatch) => boolean = () => false,
	): ResultCacheInsertResult<Entry> {
		const result = this.index.insertOrGetCompatible(scope, entry, canReuseProjected);
		const tiers = this.tiersFor(scope);
		if (result.inserted) tiers.set(entry, "probation");
		return { ...result, state: tiers.get(result.entry) ?? "probation" };
	}

	getExact(scope: Scope, action: ActionKey): Entry | undefined {
		return this.index.getExact(scope, action);
	}

	lookup(scope: Scope, action: ActionKey): readonly ResultCacheLookup<Entry>[] {
		const tiers = this.tiers.get(scope);
		return this.index.lookup(scope, action).map((item) => ({
			entry: item.entry,
			match: item.match,
			state: tiers?.get(item.entry) ?? "probation",
		}));
	}

	matching(scope: Scope, action: ActionKey): readonly Entry[] {
		return this.lookup(scope, action).map((item) => item.entry);
	}

	recordActorHit(scope: Scope, entry: Entry, limits?: ResultCacheLimits): readonly Entry[] {
		if (this.index.getExact(scope, entry.key) !== entry) return [];
		this.tiersFor(scope).set(entry, "protected");
		this.index.touch(scope, entry);
		return limits ? this.rebalanceProtected(scope, limits) : [];
	}

	stateOf(scope: Scope, entry: Entry): ResultCacheEntryState | undefined {
		return this.index.getExact(scope, entry.key) === entry ? this.tiers.get(scope)?.get(entry) : undefined;
	}

	delete(scope: Scope, entry: Entry): boolean {
		if (!this.index.delete(scope, entry)) return false;
		const tiers = this.tiers.get(scope);
		tiers?.delete(entry);
		if (tiers?.size === 0) this.tiers.delete(scope);
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
			if (this.tiers.get(scope)?.get(entry) === "protected") {
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
				entries.find((entry) => this.stateOf(scope, entry) === "probation" && canEvict(entry)) ??
				entries.find((entry) => this.stateOf(scope, entry) === "protected" && canEvict(entry));
			if (!victim) break;
			bytes -= entryBytes(victim);
			this.delete(scope, victim);
			evicted.push(victim);
			entries = this.index.values(scope);
		}
		return evicted;
	}

	clearScope(scope: Scope): Entry[] {
		const entries = this.index.clearScope(scope);
		this.tiers.delete(scope);
		return entries;
	}

	private tiersFor(scope: Scope): Map<Entry, ResultCacheEntryState> {
		const existing = this.tiers.get(scope);
		if (existing) return existing;
		const created = new Map<Entry, ResultCacheEntryState>();
		this.tiers.set(scope, created);
		return created;
	}

	private rebalanceProtected(scope: Scope, limits: ResultCacheLimits): readonly Entry[] {
		const fraction = finiteFraction(limits.protectedFraction ?? 0.8);
		const entryCapacity = finiteLimit(limits.maxEntries);
		const byteCapacity = finiteLimit(limits.maxBytes);
		const protectedEntryLimit =
			entryCapacity === 0 || fraction === 0 ? 0 : Math.max(1, Math.floor(entryCapacity * fraction));
		const protectedByteLimit = Math.floor(byteCapacity * fraction);
		const demoted: Entry[] = [];
		while (true) {
			const protectedEntries = this.index
				.values(scope)
				.filter((entry) => this.stateOf(scope, entry) === "protected");
			const protectedBytes = protectedEntries.reduce((total, entry) => total + entryBytes(entry), 0);
			if (protectedEntries.length <= protectedEntryLimit && protectedBytes <= protectedByteLimit) break;
			const victim = protectedEntries[0];
			if (!victim) break;
			this.tiersFor(scope).set(victim, "probation");
			demoted.push(victim);
		}
		return demoted;
	}
}

export interface BranchStoreLimits {
	readonly maxEntries: number;
	readonly maxBytes: number;
}

export interface BranchStoreSnapshot {
	readonly entries: number;
	readonly bytes: number;
}

/** Completed exclusive sandbox branches. Claims and adoption remain owned by CandidateAggregate. */
export class BranchStore<Scope, Branch extends SizedActionStoreEntry> {
	private readonly index: ActionIndex<Scope, Branch>;

	constructor(projectors: readonly ActionKeyProjector[] = []) {
		this.index = new ActionIndex(projectors);
	}

	insert(scope: Scope, branch: Branch): Branch | undefined {
		return this.index.insert(scope, branch);
	}

	getExact(scope: Scope, action: ActionKey): Branch | undefined {
		return this.index.getExact(scope, action);
	}

	lookup(scope: Scope, action: ActionKey): readonly ActionStoreLookup<Branch>[] {
		return this.index.lookup(scope, action).map(({ entry, match }) => ({ entry, match }));
	}

	delete(scope: Scope, branch: Branch): boolean {
		return this.index.delete(scope, branch);
	}

	values(scope: Scope): readonly Branch[] {
		return this.index.values(scope);
	}

	allValues(): readonly Branch[] {
		return this.index.allValues();
	}

	scopes(): readonly Scope[] {
		return this.index.scopes();
	}

	snapshot(scope: Scope): BranchStoreSnapshot {
		const branches = this.index.values(scope);
		return {
			entries: branches.length,
			bytes: branches.reduce((total, branch) => total + entryBytes(branch), 0),
		};
	}

	trim(scope: Scope, limits: BranchStoreLimits, canEvict: (branch: Branch) => boolean = () => true): Branch[] {
		const maxEntries = finiteLimit(limits.maxEntries);
		const maxBytes = finiteLimit(limits.maxBytes);
		let branches = this.index.values(scope);
		let bytes = branches.reduce((total, branch) => total + entryBytes(branch), 0);
		const evicted: Branch[] = [];
		while (branches.length > maxEntries || bytes > maxBytes) {
			const victim = branches.find(canEvict);
			if (!victim) break;
			bytes -= entryBytes(victim);
			this.index.delete(scope, victim);
			evicted.push(victim);
			branches = this.index.values(scope);
		}
		return evicted;
	}

	clearScope(scope: Scope): Branch[] {
		return this.index.clearScope(scope);
	}
}

function finiteLimit(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finiteFraction(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
}

function entryBytes(entry: SizedActionStoreEntry): number {
	return Number.isFinite(entry.estimatedBytes) ? Math.max(0, entry.estimatedBytes) : 0;
}
