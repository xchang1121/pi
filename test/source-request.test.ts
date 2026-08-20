import { describe, expect, it } from "vitest";
import { cause } from "../src/settlement.ts";
import { runSourceRequest, SourceGeneration } from "../src/source-request.ts";

const request = {
	source: "source",
	turnID: "turn",
	index: 0,
	kind: "proposal",
	targetDecisionSequence: 1,
} as const;

describe("source request ownership", () => {
	it("times only production and never admits a result returned after timeout", async () => {
		let release!: (value: string[]) => void;
		const producer = new Promise<string[]>((resolve) => {
			release = resolve;
		});
		const generation = new SourceGeneration();
		const pending = runSourceRequest({
			request,
			generation,
			timeoutMs: 1,
			produce: () => producer,
			count: (value) => value.length,
		});
		const settled = await pending;
		release(["late"]);

		expect(settled.settlement).toMatchObject({ status: "timeout", cause: { stage: "source", code: "timeout" } });
		expect(settled.value).toBeUndefined();
	});

	it("classifies generation expiration independently from producer errors", async () => {
		const generation = new SourceGeneration();
		generation.expire(cause("control", "turn_finished"));
		const settled = await runSourceRequest({
			request,
			generation,
			produce: () => {
				throw new Error("must not run");
			},
			count: () => 1,
		});
		expect(settled.settlement).toMatchObject({
			status: "aborted",
			cause: { stage: "source", code: "turn_finished" },
		});
	});

	it("preserves one health outcome for each independent request", async () => {
		const generation = new SourceGeneration();
		const outcomes = await Promise.all([
			runSourceRequest({ request, generation, produce: () => ["a"], count: (value) => value.length }),
			runSourceRequest({
				request: { ...request, index: 1 },
				generation,
				produce: () => [],
				count: (value: string[]) => value.length,
			}),
			runSourceRequest({
				request: { ...request, index: 2 },
				generation,
				produce: () => Promise.reject(new Error("broken")),
				count: () => 0,
			}),
		]);
		expect(outcomes.map((outcome) => outcome.settlement.status)).toEqual(["produced", "empty", "error"]);
	});

	it("settles a malformed produced value instead of rejecting its owner task", async () => {
		const settled = await runSourceRequest({
			request,
			generation: new SourceGeneration(),
			produce: () => ["value"],
			count: () => {
				throw new Error("malformed result");
			},
		});

		expect(settled.settlement).toMatchObject({
			status: "error",
			cause: { stage: "source", code: "result_error", detail: "Error: malformed result" },
		});
	});
});
