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

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}
