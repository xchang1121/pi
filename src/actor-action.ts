import type { ActionKey, ActionKeyMatch } from "./action-semantics.ts";
import type {
	ActorActionIdentity,
	ActorActionSettlement,
	ActorHitTiming,
	CandidateRejection,
	PredictionIdentity,
	ResolutionCause,
} from "./settlement.ts";

export type ActorActionState =
	| { readonly status: "matching" }
	| { readonly status: "awaiting_fallback"; readonly matchedPredictions: readonly PredictionIdentity[] }
	| { readonly status: "settled"; readonly value: ActorActionSettlement };

/** Exactly-once owner spanning Actor interception and the optional fallback execution. */
export class ActorAction {
	readonly identity: ActorActionIdentity;
	readonly tool: string;
	readonly actionKey?: ActionKey;
	private readonly rejections: CandidateRejection[] = [];
	private stateValue: ActorActionState = Object.freeze({ status: "matching" });

	constructor(input: {
		readonly identity: ActorActionIdentity;
		readonly tool: string;
		readonly actionKey?: ActionKey;
	}) {
		this.identity = Object.freeze({ ...input.identity });
		this.tool = input.tool;
		this.actionKey = input.actionKey;
	}

	get state(): ActorActionState {
		return this.stateValue;
	}

	get settlement(): ActorActionSettlement | undefined {
		return this.stateValue.status === "settled" ? this.stateValue.value : undefined;
	}

	reject(candidateID: string, match: ActionKeyMatch, cause: ResolutionCause): boolean {
		if (
			this.stateValue.status !== "matching" ||
			this.rejections.some((rejection) => rejection.candidateID === candidateID)
		) {
			return false;
		}
		this.rejections.push(
			Object.freeze({
				candidateID,
				match: Object.freeze({ ...match }),
				cause: Object.freeze({ ...cause }),
			}),
		);
		return true;
	}

	adopt(
		candidateID: string,
		match: ActionKeyMatch,
		timing: ActorHitTiming,
		matchedPredictions: readonly PredictionIdentity[] = [],
	): ActorActionSettlement | undefined {
		if (
			this.stateValue.status !== "matching" ||
			this.rejections.some((rejection) => rejection.candidateID === candidateID)
		) {
			return undefined;
		}
		return this.finish({
			actorAction: this.identity,
			tool: this.tool,
			...(this.actionKey ? { actionKeyHash: this.actionKey.hash } : {}),
			matchedPredictions: freezePredictions(matchedPredictions),
			rejections: Object.freeze([...this.rejections]),
			provider: Object.freeze({
				kind: "speculative",
				candidateID,
				match: Object.freeze({ ...match }),
				timing: normalizeTiming(timing),
			}),
		});
	}

	deferToFallback(matchedPredictions: readonly PredictionIdentity[] = []): boolean {
		if (this.stateValue.status !== "matching") return false;
		this.stateValue = Object.freeze({
			status: "awaiting_fallback",
			matchedPredictions: freezePredictions(matchedPredictions),
		});
		return true;
	}

	settleActor(durationMs: number, isError: boolean): ActorActionSettlement | undefined {
		if (this.stateValue.status !== "awaiting_fallback") return undefined;
		return this.finish({
			actorAction: this.identity,
			tool: this.tool,
			...(this.actionKey ? { actionKeyHash: this.actionKey.hash } : {}),
			matchedPredictions: this.stateValue.matchedPredictions,
			rejections: Object.freeze([...this.rejections]),
			provider: Object.freeze({ kind: "actor", durationMs: finite(durationMs), isError }),
		});
	}

	private finish(value: ActorActionSettlement): ActorActionSettlement {
		const settlement = Object.freeze(value);
		this.stateValue = Object.freeze({ status: "settled", value: settlement });
		return settlement;
	}
}

function normalizeTiming(timing: ActorHitTiming): ActorHitTiming {
	return Object.freeze({
		executionAheadMs: finite(timing.executionAheadMs),
		attemptLeadMs: finite(timing.attemptLeadMs),
		hitLatencyMs: finite(timing.hitLatencyMs),
	});
}

function freezePredictions(predictions: readonly PredictionIdentity[]): readonly PredictionIdentity[] {
	const unique = new Map(predictions.map((prediction) => [prediction.id, Object.freeze({ ...prediction })]));
	return Object.freeze([...unique.values()]);
}

function finite(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}
