export type CandidateRunState<Output> =
	| { readonly status: "running" }
	| { readonly status: "ready"; readonly completedAt: number; readonly executionMs: number; readonly output: Output }
	| {
			readonly status: "closed";
			readonly reason: string;
			readonly completedAt?: number;
			readonly executionMs?: number;
	  };

export type CandidateReuseState =
	| { readonly kind: "shared" }
	| {
			readonly kind: "exclusive";
			readonly state: "available" | "claimed" | "adopted";
			readonly claimTurnID?: string;
	  };

export type CandidateCompletion<Output> =
	| { readonly ok: true; readonly output: Output }
	| { readonly ok: false; readonly error: unknown };

export interface CandidateLeaseState {
	state: "active" | "matched" | "hit" | "expired" | "invalidated";
}

/**
 * The sole mutable owner of one candidate's execution and reuse lifecycle.
 *
 * Cache, scheduler, and turn collections are indexes over this aggregate. They
 * must never independently manufacture a run/claim/completion transition.
 */
export class CandidateAggregate<Output, Lease extends CandidateLeaseState> {
	readonly controller: AbortController;
	readonly completion: Promise<CandidateCompletion<Output>>;
	private readonly resolveCompletion: (value: CandidateCompletion<Output>) => void;
	private completionSettled = false;
	private closedError: unknown;
	private runState: CandidateRunState<Output> = { status: "running" };
	private reuseState: CandidateReuseState;
	private readonly leaseStates: Lease[];

	constructor(reuse: "shared" | "exclusive", leases: readonly Lease[] = [], controller = new AbortController()) {
		this.controller = controller;
		this.reuseState = reuse === "shared" ? { kind: "shared" } : { kind: "exclusive", state: "available" };
		this.leaseStates = [...leases];
		let resolve!: (value: CandidateCompletion<Output>) => void;
		this.completion = new Promise<CandidateCompletion<Output>>((settle) => {
			resolve = settle;
		});
		this.resolveCompletion = resolve;
	}

	get run(): CandidateRunState<Output> {
		return this.runState;
	}

	get reuse(): CandidateReuseState {
		return this.reuseState;
	}

	get leases(): readonly Lease[] {
		return this.leaseStates;
	}

	addLease(lease: Lease): void {
		this.leaseStates.push(lease);
	}

	pruneLeases(keep: (lease: Lease) => boolean): void {
		const retained = this.leaseStates.filter(keep);
		this.leaseStates.splice(0, this.leaseStates.length, ...retained);
	}

	markReady(output: Output, completedAt: number, executionMs: number): boolean {
		if (this.runState.status !== "running") return false;
		this.runState = {
			status: "ready",
			completedAt: finiteNonNegative(completedAt),
			executionMs: finiteNonNegative(executionMs),
			output,
		};
		return true;
	}

	settleReady(): boolean {
		if (this.runState.status !== "ready" || this.completionSettled) return false;
		this.settle({ ok: true, output: this.runState.output });
		return true;
	}

	close(input: {
		readonly reason: string;
		readonly error?: unknown;
		readonly completedAt?: number;
		readonly executionMs?: number;
	}): boolean {
		if (this.runState.status === "closed") return false;
		const prior = this.runState;
		const completedAt = input.completedAt ?? (prior.status === "ready" ? prior.completedAt : undefined);
		const executionMs = input.executionMs ?? (prior.status === "ready" ? prior.executionMs : undefined);
		this.runState = {
			status: "closed",
			reason: input.reason,
			...(completedAt !== undefined ? { completedAt: finiteNonNegative(completedAt) } : {}),
			...(executionMs !== undefined ? { executionMs: finiteNonNegative(executionMs) } : {}),
		};
		this.closedError = input.error ?? new Error(input.reason);
		this.controller.abort();
		return true;
	}

	settleClosed(): boolean {
		if (this.runState.status !== "closed" || this.completionSettled) return false;
		this.settle({ ok: false, error: this.closedError ?? new Error(this.runState.reason) });
		return true;
	}

	claim(turnID: string): boolean {
		if (this.runState.status === "closed") return false;
		if (this.reuseState.kind === "shared") return true;
		if (this.reuseState.state !== "available") return false;
		this.reuseState = { kind: "exclusive", state: "claimed", claimTurnID: turnID };
		return true;
	}

	releaseClaim(turnID: string): boolean {
		if (
			this.reuseState.kind !== "exclusive" ||
			this.reuseState.state !== "claimed" ||
			this.reuseState.claimTurnID !== turnID
		) {
			return false;
		}
		this.reuseState = { kind: "exclusive", state: "available" };
		return true;
	}

	markAdopted(executionMs?: number): boolean {
		if (
			this.reuseState.kind !== "exclusive" ||
			this.reuseState.state !== "claimed" ||
			this.runState.status !== "ready" ||
			!this.completionSettled
		) {
			return false;
		}
		this.reuseState = { kind: "exclusive", state: "adopted" };
		return this.close({ reason: "adopted", ...(executionMs !== undefined ? { executionMs } : {}) });
	}

	private settle(value: CandidateCompletion<Output>): void {
		if (this.completionSettled) return;
		this.completionSettled = true;
		this.resolveCompletion(value);
	}
}

export interface CandidateCatalogRecord<SessionID, Owner> {
	readonly sessionID: SessionID;
	readonly owner: Owner;
	readonly turns: ReadonlySet<string>;
}

/** One ownership table with secondary session/turn indexes. */
export class CandidateCatalog<SessionID, Candidate extends object, Owner> {
	private readonly records = new Map<Candidate, { sessionID: SessionID; owner: Owner; turns: Set<string> }>();
	private readonly sessions = new Map<SessionID, Set<Candidate>>();
	private readonly turns = new Map<string, Set<Candidate>>();

	register(sessionID: SessionID, turn: string, candidate: Candidate, owner: Owner): void {
		if (this.records.has(candidate)) throw new Error("candidate is already registered");
		this.records.set(candidate, { sessionID, owner, turns: new Set([turn]) });
		addIndex(this.sessions, sessionID, candidate);
		addIndex(this.turns, turn, candidate);
	}

	attachTurn(candidate: Candidate, turn: string): boolean {
		const record = this.records.get(candidate);
		if (!record) return false;
		if (record.turns.has(turn)) return true;
		record.turns.add(turn);
		addIndex(this.turns, turn, candidate);
		return true;
	}

	detachTurn(candidate: Candidate, turn: string): boolean {
		const record = this.records.get(candidate);
		if (!record || !record.turns.delete(turn)) return false;
		removeIndex(this.turns, turn, candidate);
		return true;
	}

	detachAllFromTurn(turn: string): void {
		for (const candidate of this.turnValues(turn)) this.detachTurn(candidate, turn);
	}

	retire(candidate: Candidate): boolean {
		const record = this.records.get(candidate);
		if (!record) return false;
		this.records.delete(candidate);
		removeIndex(this.sessions, record.sessionID, candidate);
		for (const turn of record.turns) removeIndex(this.turns, turn, candidate);
		return true;
	}

	record(candidate: Candidate): CandidateCatalogRecord<SessionID, Owner> | undefined {
		const record = this.records.get(candidate);
		return record ? { sessionID: record.sessionID, owner: record.owner, turns: new Set(record.turns) } : undefined;
	}

	owner(candidate: Candidate): Owner | undefined {
		return this.records.get(candidate)?.owner;
	}

	sessionValues(sessionID: SessionID): readonly Candidate[] {
		return [...(this.sessions.get(sessionID) ?? [])];
	}

	turnValues(turn: string): readonly Candidate[] {
		return [...(this.turns.get(turn) ?? [])];
	}

	allValues(): readonly Candidate[] {
		return [...this.records.keys()];
	}
}

function addIndex<Key, Value>(index: Map<Key, Set<Value>>, key: Key, value: Value): void {
	const values = index.get(key) ?? new Set<Value>();
	values.add(value);
	index.set(key, values);
}

function removeIndex<Key, Value>(index: Map<Key, Set<Value>>, key: Key, value: Value): void {
	const values = index.get(key);
	if (!values) return;
	values.delete(value);
	if (values.size === 0) index.delete(key);
}

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}
