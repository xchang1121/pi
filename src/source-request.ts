import type {
	ResolutionCause,
	SettledSourceRequest,
	SourceRequestIdentity,
	SourceRequestSettlement,
} from "./settlement.ts";
import { cause } from "./settlement.ts";

export interface SourceRequestResult<Value> extends SettledSourceRequest {
	readonly value?: Value;
}

/** Turn-scoped authority token. Expiration prevents late producer results from entering admission. */
export class SourceGeneration {
	readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private expiredCause?: ResolutionCause;
	private detachParent?: () => void;

	constructor(parent?: AbortSignal) {
		this.signal = this.controller.signal;
		if (!parent) return;
		const abort = () => this.expire(cause("control", "turn_aborted"));
		if (parent.aborted) abort();
		else {
			parent.addEventListener("abort", abort, { once: true });
			this.detachParent = () => parent.removeEventListener("abort", abort);
		}
	}

	get active(): boolean {
		return !this.expiredCause;
	}

	get expiration(): ResolutionCause | undefined {
		return this.expiredCause;
	}

	expire(expiration: ResolutionCause): boolean {
		if (this.expiredCause) return false;
		this.expiredCause = Object.freeze({ ...expiration });
		this.detachParent?.();
		this.detachParent = undefined;
		this.controller.abort(this.expiredCause);
		return true;
	}
}

/** Producer-only timing and cancellation; downstream admission is deliberately outside this function. */
export async function runSourceRequest<Value>(input: {
	readonly request: SourceRequestIdentity;
	readonly generation: SourceGeneration;
	readonly timeoutMs?: number;
	readonly produce: (signal: AbortSignal) => Value | Promise<Value>;
	readonly count: (value: Value) => number;
}): Promise<SourceRequestResult<Value>> {
	const startedAt = performance.now();
	if (!input.generation.active) {
		return result(input.request, startedAt, {
			status: "aborted",
			cause: asSourceCause(input.generation.expiration, "generation_expired"),
		});
	}

	const controller = new AbortController();
	const abortFromGeneration = () => controller.abort(input.generation.expiration);
	input.generation.signal.addEventListener("abort", abortFromGeneration, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let cancelFromGeneration: (() => void) | undefined;
	const producer = Promise.resolve()
		.then(() => input.produce(controller.signal))
		.then(
			(value) => ({ kind: "produced" as const, value }),
			(error) => ({ kind: "error" as const, error }),
		);
	const cancellation = new Promise<
		{ readonly kind: "timeout" } | { readonly kind: "aborted"; readonly expiration?: ResolutionCause }
	>((resolve) => {
		const duration = finiteTimeout(input.timeoutMs);
		if (duration !== undefined) {
			timeout = setTimeout(() => {
				controller.abort(cause("source", "timeout"));
				resolve({ kind: "timeout" });
			}, duration);
		}
		cancelFromGeneration = () => resolve({ kind: "aborted", expiration: input.generation.expiration });
		input.generation.signal.addEventListener("abort", cancelFromGeneration, { once: true });
	});

	try {
		const outcome = await Promise.race([producer, cancellation]);
		if (outcome.kind === "timeout") {
			return result(input.request, startedAt, {
				status: "timeout",
				cause: sourceCause("timeout"),
			});
		}
		if (outcome.kind === "aborted" || !input.generation.active) {
			return result(input.request, startedAt, {
				status: "aborted",
				cause: asSourceCause(
					outcome.kind === "aborted" ? outcome.expiration : input.generation.expiration,
					"generation_expired",
				),
			});
		}
		if (outcome.kind === "error") {
			return result(input.request, startedAt, {
				status: "error",
				cause: sourceCause("producer_error", errorDetail(outcome.error)),
			});
		}
		const proposalCount = finiteCount(input.count(outcome.value));
		return {
			...result(
				input.request,
				startedAt,
				proposalCount > 0 ? { status: "produced", proposalCount } : { status: "empty" },
			),
			value: outcome.value,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
		input.generation.signal.removeEventListener("abort", abortFromGeneration);
		if (cancelFromGeneration) input.generation.signal.removeEventListener("abort", cancelFromGeneration);
	}
}

function result(
	request: SourceRequestIdentity,
	startedAt: number,
	settlement: SourceRequestSettlement,
): SettledSourceRequest {
	return Object.freeze({
		request: Object.freeze({ ...request }),
		startedAt,
		durationMs: Math.max(0, performance.now() - startedAt),
		settlement: Object.freeze(settlement),
	});
}

function asSourceCause(
	value: ResolutionCause | undefined,
	fallback: string,
): ResolutionCause & { readonly stage: "source" } {
	return sourceCause(value?.code ?? fallback, value?.detail);
}

function sourceCause(code: string, detail?: string): ResolutionCause & { readonly stage: "source" } {
	return cause("source", code, detail);
}

function finiteTimeout(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
