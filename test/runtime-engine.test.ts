import { describe, expect, it, vi } from "vitest";
import { READ_RANGE_ACTION_KEY_PROJECTOR } from "../src/action-key-projection.ts";
import { buildPiActionKey } from "../src/action-semantics.ts";
import type { SpeculativeActionEvent, SpeculativeActionSettings, SpeculativePlanSource } from "../src/runtime.ts";
import { makeStructuralSpeculativeActionRuntime } from "../src/runtime-engine.ts";
import { cause, type PredictionSettlement, type ResourceValidation, zeroValidationMetrics } from "../src/settlement.ts";

interface Start {
	readonly sessionID: string;
	readonly turnID: string;
}

interface Call extends Start {
	readonly id: string;
	readonly tool: string;
	readonly input: Record<string, unknown>;
	readonly terminal?: boolean;
}

const settings: SpeculativeActionSettings = {
	enabled: true,
	resourceCacheMaxEntries: 32,
	resourceCacheMaxBytes: 1024 * 1024,
	predictionTimeoutMs: 100,
	maxConcurrentActions: 8,
	tools: { resourceCached: ["read"], sandbox: ["bash"] },
};

type Source = SpeculativePlanSource<string, string, Start, Call, { readonly cwd: string }>;

function plan(source: string, proposalID: string, input: Record<string, unknown>) {
	return {
		id: proposalID,
		source,
		revision: 0,
		actions: [{ id: "next", type: "tool_call" as const, tool: "read", input, feedback: proposalID }],
	};
}

function harness(input: {
	readonly source: Source;
	readonly settings?: () => SpeculativeActionSettings;
	readonly execute?: (
		tool: string,
		input: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	) => unknown | Promise<unknown>;
	readonly expired?: () => boolean | Promise<boolean>;
	readonly capture?: () => unknown | Promise<unknown>;
	readonly validate?: (version: unknown) => ResourceValidation;
	readonly projection?: boolean;
	readonly onEvent?: (event: SpeculativeActionEvent<string>) => void | Promise<void>;
	readonly actionKey?: (tool: string, args: unknown) => ReturnType<typeof buildPiActionKey>;
}) {
	const events: SpeculativeActionEvent<string>[] = [];
	let executions = 0;
	const runtime = makeStructuralSpeculativeActionRuntime<string, string, Start, Call, Call, { readonly cwd: string }>({
		sources: [input.source],
		settings: input.settings ?? (() => settings),
		definitions: () => [{ name: "read" }, { name: "bash" }],
		stateData: () => ({ cwd: "/workspace" }),
		actionKey: input.actionKey ?? ((tool, args) => buildPiActionKey(tool, args, "/workspace")),
		actual: (call) => ({ id: call.id, tool: call.tool, input: call.input }),
		preflightCandidate: () => ({ ok: true }),
		executeCandidate: async ({ tool, concrete, signal }) => {
			executions++;
			return ((await input.execute?.(tool, concrete, signal)) as string) ?? "speculative";
		},
		captureResourceVersion: input.capture ?? (() => ({ version: 1 })),
		validateResourceVersion: async ({ candidate }) =>
			input.validate
				? input.validate(candidate.resourceVersion)
				: (await input.expired?.())
					? {
							status: "stale",
							cause: cause("freshness", "resource_changed"),
							metrics: zeroValidationMetrics(),
						}
					: { status: "valid", metrics: zeroValidationMetrics() },
		projectionRules: input.projection
			? [
					{
						...READ_RANGE_ACTION_KEY_PROJECTOR,
						captureCoverage: () => ({ complete: true }),
						projectOutput: () => undefined,
					},
				]
			: [],
		onEvent: async (event) => {
			events.push(event);
			await input.onEvent?.(event);
		},
	});
	return { runtime, events, executions: () => executions };
}

function call(turnID: string, input: Record<string, unknown> = { path: "README.md" }): Call {
	return { sessionID: "session", turnID, id: `call:${turnID}`, tool: "read", input };
}

describe("structural speculative runtime", () => {
	it("executes preparation work without issuing or settling an Actor prediction", async () => {
		const issued = vi.fn();
		const settled = vi.fn();
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => ({
				id: "preparation",
				source: "source",
				revision: 0,
				actions: [
					{
						id: "warm",
						type: "preparation_hint",
						tool: "read",
						input: { path: "README.md" },
						feedback: "warm",
					},
				],
			}),
			onIssued: issued,
			onSettled: settled,
		};
		const fixture = harness({ source });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "prepare" });
		await waitFor(() => fixture.events.some((event) => event.type === "source_request"));
		await fixture.runtime.finishTurn({ ...call("prepare"), terminal: true });

		expect(issued).not.toHaveBeenCalled();
		expect(settled).not.toHaveBeenCalled();
		expect(fixture.events.filter((event) => event.type === "prediction")).toEqual([]);
	});

	it("settles matched and adopted as orthogonal facts exactly once", async () => {
		const settlements: PredictionSettlement[] = [];
		const actionKey = vi.fn((tool: string, args: unknown) => buildPiActionKey(tool, args, "/workspace"));
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "stale", { path: "README.md" }),
			onSettled: ({ settlement }) => {
				settlements.push(settlement);
			},
		};
		const fixture = harness({ source, expired: () => true, actionKey });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);

		expect(await fixture.runtime.consume(call("turn"))).toBeUndefined();
		await fixture.runtime.actual({ ...call("turn"), durationMs: 4, output: "actor" });
		await fixture.runtime.finishTurn({ ...call("turn"), terminal: true });

		expect(settlements).toHaveLength(1);
		expect(settlements[0]).toMatchObject({
			observation: "observed",
			match: {
				matched: true,
				adoption: { status: "rejected", cause: { stage: "freshness" } },
			},
		});
		const predictionEvents = fixture.events.filter((event) => event.type === "prediction");
		expect(predictionEvents).toHaveLength(1);
		expect(predictionEvents[0]!.type === "prediction" && predictionEvents[0]!.settlement).toBe(settlements[0]);
		expect(
			fixture.events
				.filter((event) => event.type === "candidate")
				.map((event) => (event.type === "candidate" ? event.state.status : undefined)),
		).toEqual(["running", "succeeded"]);
		expect(fixture.events.filter((event) => event.type === "source_request")).toHaveLength(1);
		expect(fixture.events.find((event) => event.type === "actor_action")).toMatchObject({
			settlement: {
				provider: { kind: "actor", durationMs: 4 },
				rejections: [{ cause: { stage: "freshness" } }],
			},
		});
		// The candidate and Actor intent are keyed once each. Fallback completion reuses
		// the ActorAction-owned identity instead of observing a later environment.
		expect(actionKey).toHaveBeenCalledTimes(2);
	});

	it("waits for an in-flight candidate to capture its resource baseline before validation", async () => {
		let releaseCapture!: () => void;
		const captured = new Promise<{ version: number }>((resolve) => {
			releaseCapture = () => resolve({ version: 1 });
		});
		const validate = vi.fn((version: unknown) =>
			version
				? { status: "valid" as const, metrics: zeroValidationMetrics() }
				: {
						status: "indeterminate" as const,
						cause: cause("freshness", "resource_version_missing"),
						metrics: zeroValidationMetrics(),
					},
		);
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "in-flight", { path: "README.md" }),
		};
		const fixture = harness({ source, capture: () => captured, validate });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);

		const consumed = fixture.runtime.consume(call("turn"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(validate).not.toHaveBeenCalled();
		releaseCapture();
		await expect(consumed).resolves.toBe("speculative");
		expect(validate).toHaveBeenCalledOnce();
		expect(validate).toHaveBeenCalledWith({ version: 1 });
		await fixture.runtime.finishTurn({ ...call("turn"), terminal: true });
	});

	it("keeps slow observers off the hit path and freezes event attribution before cleanup", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "slow-observer", { path: "README.md" }),
		};
		const fixture = harness({ source, onEvent: () => blocked });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);

		const result = await Promise.race([
			fixture.runtime.consume(call("turn")),
			new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
		]);
		expect(result).toBe("speculative");
		const disabled = fixture.runtime.settingsChanged({ ...settings, enabled: false });
		release();
		await disabled;
		expect(fixture.events.find((event) => event.type === "actor_action")).toMatchObject({
			settlement: { matchedPredictions: [{ source: "source" }] },
		});
	});

	it("preserves a claimed match when disable races in-flight validation", async () => {
		let validationEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			validationEntered = resolve;
		});
		let releaseValidation!: () => void;
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve;
		});
		const settlements: PredictionSettlement[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "disable-race", { path: "README.md" }),
			onSettled: ({ settlement }) => {
				settlements.push(settlement);
			},
		};
		const fixture = harness({
			source,
			expired: async () => {
				validationEntered();
				await validationGate;
				return false;
			},
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);
		const consumed = fixture.runtime.consume(call("turn"));
		await entered;

		const disabling = fixture.runtime.settingsChanged({ ...settings, enabled: false });
		releaseValidation();
		expect(await consumed).toBeUndefined();
		await disabling;
		await waitFor(() => settlements.length === 1);

		expect(settlements[0]).toMatchObject({
			observation: "observed",
			match: {
				matched: true,
				adoption: { status: "rejected", cause: { stage: "control", code: "disabled" } },
			},
		});
	});

	it("runs eight independent producers concurrently and deduplicates only by K(a)", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = 0;
		const settlements: PredictionSettlement[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			proposalCount: () => 8,
			propose: async ({ proposalIndex }) => {
				entered++;
				await gate;
				return plan("source", `proposal:${proposalIndex}`, { path: "README.md" });
			},
			onSettled: ({ settlement }) => {
				settlements.push(settlement);
			},
		};
		const fixture = harness({ source });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => entered === 8);
		release();
		await waitFor(() => fixture.runtime.inspect().pendingPredictions === 0);
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);

		expect(await fixture.runtime.consume(call("turn"))).toBe("speculative");
		await fixture.runtime.finishTurn({ ...call("turn"), terminal: true });
		expect(fixture.executions()).toBe(1);
		expect(settlements).toHaveLength(8);
		expect(new Set(settlements.map((item) => item.observation === "observed" && item.actorAction.id))).toEqual(
			new Set(["call:turn"]),
		);
	});

	it("counts one shared execution once when it serves multiple Actor actions", async () => {
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "shared-timing", { path: "README.md" }),
		};
		const fixture = harness({
			source,
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return "shared";
			},
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);

		expect(await fixture.runtime.consume(call("turn"))).toBe("shared");
		expect(await fixture.runtime.consume({ ...call("turn"), id: "call:repeat" })).toBe("shared");
		await fixture.runtime.finishTurn({ ...call("turn"), terminal: true });

		const actorEvents = fixture.events.filter((event) => event.type === "actor_action");
		expect(actorEvents).toHaveLength(2);
		const candidateIDs = actorEvents.flatMap((event) =>
			event.settlement.provider.kind === "speculative" ? [event.settlement.provider.candidateID] : [],
		);
		expect(candidateIDs).toHaveLength(2);
		expect(new Set(candidateIDs).size).toBe(1);
		expect(fixture.events.find((event) => event.type === "task")).toMatchObject({
			timing: { authoritativeToolCount: 1 },
		});
	});

	it("cancels next-action source requests when the Actor intent arrives", async () => {
		let entered = 0;
		const source: Source = {
			id: "source",
			enabled: () => true,
			requestLifetime: "actor_action",
			proposalCount: () => 8,
			propose: ({ proposalIndex, signal }) => {
				entered++;
				if (proposalIndex === 0) return plan("source", "empty", { path: "other.ts" });
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		};
		const fixture = harness({ source });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => entered === 8 && fixture.runtime.inspect().sharedCandidates === 1);

		expect(await fixture.runtime.consume(call("turn"))).toBeUndefined();
		await waitFor(() => fixture.runtime.inspect().pendingPredictions === 0);
		await waitFor(() => fixture.events.filter((event) => event.type === "source_request").length === 8);
		expect(
			fixture.events.filter(
				(event) => event.type === "source_request" && event.request.settlement.status === "aborted",
			),
		).toHaveLength(7);
	});

	it("queues unique candidates at capacity and starts each without admission loss", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const executed: string[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => ({
				id: "queue",
				source: "source",
				revision: 0,
				actions: [
					{ id: "first", type: "tool_call", tool: "read", input: { path: "first.ts" } },
					{ id: "second", type: "tool_call", tool: "read", input: { path: "second.ts" } },
				],
			}),
		};
		const fixture = harness({
			source,
			settings: () => ({ ...settings, maxConcurrentActions: 1 }),
			execute: async (_tool, input) => {
				const path = String(input.path);
				executed.push(path);
				if (path === "first.ts") await firstGate;
				return path;
			},
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 2 && executed.length === 1);
		expect(executed).toEqual(["first.ts"]);

		releaseFirst();
		await waitFor(() => executed.length === 2);
		expect(executed).toEqual(["first.ts", "second.ts"]);
		expect(
			fixture.events.filter((event) => event.type === "candidate" && event.state.status === "cancelled"),
		).toEqual([]);
	});

	it("promotes an Actor-matched queued candidate and preempts unrelated work", async () => {
		const executed: string[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => ({
				id: "promotion",
				source: "source",
				revision: 0,
				actions: [
					{ id: "busy", type: "tool_call", tool: "read", input: { path: "busy.ts" } },
					{
						id: "target",
						type: "tool_call",
						tool: "read",
						input: { path: "target.ts" },
						resourceDemand: 2,
					},
				],
			}),
		};
		const fixture = harness({
			source,
			settings: () => ({ ...settings, maxConcurrentActions: 1 }),
			execute: async (_tool, input, signal) => {
				const path = String(input.path);
				executed.push(path);
				if (path !== "busy.ts") return "target";
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 2 && executed.length === 1);

		expect(await fixture.runtime.consume(call("turn", { path: "target.ts" }))).toBe("target");
		expect(executed).toEqual(["busy.ts", "target.ts"]);
		expect(
			fixture.events.find(
				(event) =>
					event.type === "candidate" &&
					event.state.status === "cancelled" &&
					event.state.cause.code === "preempted_by_actor",
			),
		).toBeDefined();
	});

	it("cannot commit a speculative world when output projection fails", async () => {
		const commit = vi.fn(async () => "committed");
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "projection", { path: "README.md", offset: 1, limit: 100 }),
		};
		const fixture = harness({
			source,
			projection: true,
			execute: () => ({
				output: "wide",
				backend: "test",
				resources: [],
				capturedBytes: 0,
				executionMetrics: {},
				compatibility: { status: "compatible", backend: "test", executionFingerprint: "" },
				state: "sealed",
				commit,
			}),
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);

		expect(await fixture.runtime.consume(call("turn", { path: "README.md", offset: 10, limit: 10 }))).toBeUndefined();
		expect(commit).not.toHaveBeenCalled();
	});

	it("settles a K(a) match as incompatible without committing backend effects", async () => {
		const commit = vi.fn(async () => "committed");
		const settlements: PredictionSettlement[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "incompatible", { path: "README.md" }),
			onSettled: ({ settlement }) => {
				settlements.push(settlement);
			},
		};
		const fixture = harness({
			source,
			execute: () => ({
				output: "sealed",
				backend: "test",
				resources: [],
				capturedBytes: 0,
				executionMetrics: {},
				compatibility: { status: "indeterminate", backend: "test", code: "attestation_missing" },
				state: "sealed",
				commit,
			}),
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);

		expect(await fixture.runtime.consume(call("turn"))).toBeUndefined();
		await fixture.runtime.actual({ ...call("turn"), durationMs: 1, output: "actor" });
		await fixture.runtime.finishTurn({ ...call("turn"), terminal: true });
		expect(commit).not.toHaveBeenCalled();
		expect(settlements).toEqual([
			expect.objectContaining({
				match: expect.objectContaining({
					matched: true,
					adoption: expect.objectContaining({
						status: "rejected",
						cause: expect.objectContaining({ stage: "compatibility", code: "backend_indeterminate" }),
					}),
					relation: expect.any(Object),
				}),
			}),
		]);
	});

	it("drops a producer result that arrives after its timeout", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const source: Source = {
			id: "source",
			enabled: () => true,
			timeoutMs: () => 1,
			propose: async () => {
				await gate;
				return plan("source", "late", { path: "README.md" });
			},
		};
		const fixture = harness({ source });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn" });
		await waitFor(() => fixture.runtime.inspect().pendingPredictions === 0);
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fixture.runtime.inspect().sharedCandidates).toBe(0);
		expect(fixture.executions()).toBe(0);
	});

	it("keeps one turn on its settings snapshot while master disable remains immediate", async () => {
		let configured = settings;
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "epoch", { path: "README.md" }),
		};
		const fixture = harness({ source, settings: () => configured });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => fixture.runtime.inspect().sharedCandidates === 1);

		configured = { ...settings, tools: { ...settings.tools, resourceCached: [] } };
		await fixture.runtime.settingsChanged(configured);
		expect(await fixture.runtime.consume(call("turn-1"))).toBe("speculative");
		await fixture.runtime.finishTurn({ ...call("turn-1"), terminal: false });

		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		expect(await fixture.runtime.consume(call("turn-2"))).toBeUndefined();

		configured = { ...settings, enabled: false };
		await fixture.runtime.settingsChanged(configured);
		expect(fixture.runtime.inspect()).toMatchObject({ activeTurns: 0, pendingPredictions: 0 });
	});

	it("keeps a future prediction dormant until the preceding Actor step", async () => {
		let executions = 0;
		const settlements: PredictionSettlement[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: ({ startInput }) =>
				startInput.turnID === "turn-1"
					? {
							...plan("source", "future", { path: "future.ts" }),
							actions: [
								{
									id: "next",
									type: "tool_call",
									tool: "read",
									input: { path: "future.ts" },
									horizon: 1,
									expectedDurationMs: 10,
								},
							],
						}
					: plan("source", `empty:${startInput.turnID}`, {}),
			onSettled: ({ settlement }) => {
				settlements.push(settlement);
			},
		};
		const fixture = harness({
			source,
			execute: () => {
				executions++;
				return "future";
			},
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => fixture.runtime.inspect().pendingPredictions === 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(executions).toBe(0);

		const unrelated: Call = {
			sessionID: "session",
			turnID: "turn-1",
			id: "unrelated",
			tool: "find",
			input: { pattern: "*" },
		};
		expect(await fixture.runtime.consume(unrelated)).toBeUndefined();
		await fixture.runtime.actual({ ...unrelated, durationMs: 1, output: "files" });
		await waitFor(() => executions === 1);
		await fixture.runtime.finishTurn({ ...call("turn-1"), terminal: false });
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		expect(
			await fixture.runtime.consume({
				sessionID: "session",
				turnID: "turn-2",
				id: "future-call",
				tool: "read",
				input: { path: "future.ts" },
			}),
		).toBe("future");
		await fixture.runtime.finishTurn({ ...call("turn-2"), terminal: true });
		expect(settlements).toContainEqual(
			expect.objectContaining({
				match: {
					matched: true,
					adoption: { status: "adopted", candidateID: expect.any(String) },
					relation: expect.any(Object),
				},
			}),
		);
	});

	it("recalculates a distant prediction deadline across Actor turns", async () => {
		let executions = 0;
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: ({ startInput }) =>
				startInput.turnID === "turn-2"
					? {
							...plan("source", "distant", { path: "future.ts" }),
							actions: [
								{
									id: "next",
									type: "tool_call",
									tool: "read",
									input: { path: "future.ts" },
									horizon: 2,
									expectedDurationMs: 10,
								},
							],
						}
					: { id: "empty", source: "source", revision: 0, actions: [] },
		};
		const fixture = harness({
			source,
			execute: () => {
				executions++;
				return "future";
			},
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn-1" });
		await waitFor(() => fixture.runtime.inspect().pendingPredictions === 0);
		const first: Call = {
			sessionID: "session",
			turnID: "turn-1",
			id: "first",
			tool: "find",
			input: { pattern: "*" },
		};
		expect(await fixture.runtime.consume(first)).toBeUndefined();
		await fixture.runtime.actual({ ...first, durationMs: 1, output: "files" });
		await fixture.runtime.finishTurn({ ...first, terminal: false });
		await new Promise((resolve) => setTimeout(resolve, 120));

		await fixture.runtime.startTurn({ sessionID: "session", turnID: "turn-2" });
		await waitFor(() => fixture.runtime.inspect().pendingPredictions === 0);
		const second = { ...first, turnID: "turn-2", id: "second" };
		expect(await fixture.runtime.consume(second)).toBeUndefined();
		await fixture.runtime.actual({ ...second, durationMs: 1, output: "files" });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(executions).toBe(0);

		await waitFor(() => executions === 1);
		await fixture.runtime.finishTurn({ ...call("turn-2"), terminal: true });
	});

	it("serializes one exclusive result across parallel Actor calls", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const settlements: PredictionSettlement[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => ({
				id: "bash",
				source: "source",
				revision: 0,
				actions: [{ id: "next", type: "tool_call", tool: "bash", input: { command: "build" } }],
			}),
			onSettled: ({ settlement }) => {
				settlements.push(settlement);
			},
		};
		const fixture = harness({
			source,
			execute: async () => {
				await gate;
				return world("built");
			},
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "parallel" });
		await waitFor(() => fixture.runtime.inspect().exclusiveCandidates === 1);
		const firstCall: Call = {
			sessionID: "session",
			turnID: "parallel",
			id: "first",
			tool: "bash",
			input: { command: "build" },
		};
		const secondCall = { ...firstCall, id: "second" };
		const first = fixture.runtime.consume(firstCall);
		await Promise.resolve();
		expect(await fixture.runtime.consume(secondCall)).toBeUndefined();
		await fixture.runtime.actual({ ...secondCall, durationMs: 2, output: "actor-second" });
		release();
		expect(await first).toBe("built");
		await fixture.runtime.finishTurn({ ...firstCall, terminal: true });
		expect(settlements).toHaveLength(1);
		expect(settlements[0]).toMatchObject({
			actorAction: { id: "first" },
			match: { matched: true, adoption: { status: "adopted" } },
		});
	});

	it("revises a speculative continuation after confirmation before launching its child", async () => {
		const continuations: string[] = [];
		const executed: string[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => ({
				id: "chain",
				source: "source",
				revision: 0,
				actions: [
					{ id: "parent", type: "tool_call", tool: "read", input: { path: "parent.ts" }, feedback: "parent" },
				],
			}),
			continue: ({ candidate, proposalID, actionID, revision, trigger }) => {
				const path = String(candidate.input.path);
				continuations.push(`${path}:${trigger}:${candidate.empiricalProbability ?? "none"}`);
				if (path !== "parent.ts") return undefined;
				return {
					proposalID,
					source: "source",
					revision,
					upsert: [
						{
							id: "child",
							type: "tool_call",
							tool: "read",
							input: { path: "child.ts" },
							empiricalProbability: trigger === "actor_adopted" ? 0.9 : 0.2,
							feedback: trigger === "actor_adopted" ? "confirmed-child" : "speculative-child",
							dependsOn: [{ actionID, condition: "execution_succeeded" }],
						},
					],
				};
			},
		};
		const fixture = harness({
			source,
			execute: (_tool, input) => {
				executed.push(String(input.path));
				return `${String(input.path)}:output`;
			},
		});
		await fixture.runtime.startTurn({ sessionID: "session", turnID: "chain" });
		await waitFor(() => continuations.includes("parent.ts:execution_succeeded:none"));
		expect(executed).toEqual(["parent.ts"]);
		expect(await fixture.runtime.consume(call("chain", { path: "parent.ts" }))).toBe("parent.ts:output");
		await waitFor(() => executed.includes("child.ts"));
		expect(continuations).toContain("parent.ts:actor_adopted:none");
		expect(executed).toEqual(["parent.ts", "child.ts"]);
		expect(
			await fixture.runtime.consume({
				sessionID: "session",
				turnID: "chain",
				id: "child-call",
				tool: "read",
				input: { path: "child.ts" },
			}),
		).toBe("child.ts:output");
	});

	it("keeps a bounded continuation alive across turns without extending turn completion", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let continuationStarted = false;
		let proposals = 0;
		const executed: string[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			proposalCount: () => 1,
			propose: () => {
				proposals++;
				return plan("source", "cross-turn", { path: "parent.ts" });
			},
			continue: async ({ proposalID, actionID, revision, candidate, trigger }) => {
				if (String(candidate.input.path) !== "parent.ts" || trigger !== "execution_succeeded") return undefined;
				continuationStarted = true;
				await gate;
				return {
					proposalID,
					source: "source",
					revision,
					upsert: [
						{
							id: "child",
							type: "tool_call",
							tool: "read",
							input: { path: "child.ts" },
							dependsOn: [{ actionID, condition: "execution_succeeded" }],
						},
					],
				};
			},
		};
		const fixture = harness({
			source,
			execute: (_tool, input) => {
				executed.push(String(input.path));
				return `${String(input.path)}:output`;
			},
		});

		await fixture.runtime.startTurn({ sessionID: "session", turnID: "parent-turn" });
		await waitFor(() => continuationStarted);
		expect(await fixture.runtime.consume(call("parent-turn", { path: "parent.ts" }))).toBe("parent.ts:output");
		const finished = fixture.runtime.finishTurn({ ...call("parent-turn"), terminal: false });
		expect(
			await Promise.race([
				finished.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
			]),
		).toBe(true);
		expect(fixture.runtime.inspect()).toMatchObject({ activeTurns: 0, pendingPredictions: 1 });

		await fixture.runtime.startTurn({ sessionID: "session", turnID: "child-turn" });
		expect(proposals).toBe(1);
		release();
		await waitFor(() => executed.includes("child.ts"));
		expect(await fixture.runtime.consume(call("child-turn", { path: "child.ts" }))).toBe("child.ts:output");
		await fixture.runtime.finishTurn({ ...call("child-turn"), terminal: true });
	});

	it("cancels a conditional continuation and rejects its late child when the parent misses", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let continuationStarted = false;
		const executed: string[] = [];
		const source: Source = {
			id: "source",
			enabled: () => true,
			propose: () => plan("source", "conditional", { path: "parent.ts" }),
			continue: async ({ proposalID, actionID, revision, trigger }) => {
				if (trigger !== "execution_succeeded") return undefined;
				continuationStarted = true;
				await gate;
				return {
					proposalID,
					source: "source",
					revision,
					upsert: [
						{
							id: "late-child",
							type: "tool_call",
							tool: "read",
							input: { path: "late.ts" },
							dependsOn: [{ actionID, condition: "execution_succeeded" }],
						},
					],
				};
			},
		};
		const fixture = harness({
			source,
			execute: (_tool, input) => {
				executed.push(String(input.path));
				return "output";
			},
		});

		await fixture.runtime.startTurn({ sessionID: "session", turnID: "miss" });
		await waitFor(() => continuationStarted);
		expect(await fixture.runtime.consume(call("miss", { path: "other.ts" }))).toBeUndefined();
		await fixture.runtime.actual({ ...call("miss", { path: "other.ts" }), durationMs: 1, output: "actor" });
		await waitFor(() =>
			fixture.events.some(
				(event) =>
					event.type === "source_request" &&
					event.request.request.kind === "continuation" &&
					event.request.settlement.status === "aborted",
			),
		);
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(executed).toEqual(["parent.ts"]);
		expect(fixture.runtime.inspect().deferredPlanActions).toBe(0);
		await fixture.runtime.finishTurn({ ...call("miss"), terminal: true });
	});
});

function world(output: string) {
	let state = "sealed" as "sealed" | "committing" | "committed" | "failed";
	return {
		output,
		backend: "test",
		resources: [],
		capturedBytes: 0,
		executionMetrics: {},
		compatibility: { status: "compatible" as const, backend: "test", executionFingerprint: "" },
		get state() {
			return state;
		},
		commit: async () => {
			state = "committing";
			state = "committed";
			return output;
		},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("condition was not met");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}
