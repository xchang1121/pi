import { createHash } from "node:crypto";
import type {
	ActualToolCallContext,
	Agent,
	AgentTool,
	AgentToolCall,
	AgentToolInvocation,
	AgentToolResult,
	SettleToolCallContext,
	SettleToolCallResult,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ActionProjectionRule } from "./action-key-projection.ts";
import type { ActionKey, ActionSemanticsRegistry } from "./common.ts";
import {
	buildDrafterToolCallPrompt,
	clampCandidateLimit,
	DEFAULTS,
	PI_ACTION_SEMANTICS,
	usageTokenCount,
} from "./common.ts";
import type { ExecutionWorldMode } from "./execution-world.ts";
import {
	acquirePatternAwareStore,
	asPatternAwareRuntimeContext,
	PATTERN_AWARE_DEFAULTS,
	type PatternAwareCandidate,
	type PatternAwareEventInput,
	type PatternAwareRuntimeContext,
	type PatternAwareSettings,
	type PatternAwareStore,
	type PatternAwareStoreLease,
	patternAwareRuntimeContext,
	patternAwareSettings,
	projectPatternAwareObservation,
} from "./pattern-aware.ts";
import type { PlanAction, PlanProposal } from "./plan-proposal.ts";
import {
	captureResourceVersion,
	releaseResourceVersion,
	validateResourceVersion,
	watchResourceVersion,
} from "./resource-version.ts";
import type {
	CandidatePreflight,
	SpeculativeActionEvent,
	SpeculativeActionRuntime,
	SpeculativeActionSettings,
	SpeculativePlanSource,
} from "./runtime.ts";
import { candidateExecutionMs, candidateToolNames, makeSpeculativeActionRuntime } from "./runtime.ts";
import type { SpeculativeAgentSandbox } from "./workspace-sandbox.ts";

export interface SpeculativeAgentSettingsInput {
	readonly enabled?: boolean;
	readonly drafterEnabled?: boolean;
	readonly candidateLimit?: number;
	readonly maxConcurrentActions?: number;
	readonly resourceCacheMaxEntries?: number;
	readonly resourceCacheMaxBytes?: number;
	readonly predictionTimeoutMs?: number;
	readonly adaptiveDrafter?: boolean;
	readonly patternAware?: Partial<PatternAwareSettings>;
	readonly tools?: {
		readonly resourceCached?: readonly string[];
		readonly sandbox?: readonly string[];
	};
}

export interface SpeculativeAgentPreflightContext {
	readonly tool: AgentTool;
	readonly toolName: string;
	readonly args: unknown;
	readonly action: ActionKey;
	readonly signal: AbortSignal;
}

export interface DraftOptionsContext {
	readonly actorModel: Model<Api>;
	readonly draftModel: Model<Api>;
	readonly actorOptions: SimpleStreamOptions | undefined;
	readonly signal: AbortSignal;
}

export interface InstallSpeculativeActionOptions {
	/** Workspace root used for action canonicalization and resource validation. */
	readonly cwd: string;
	/** Runtime settings. The feature remains disabled when omitted. */
	readonly getSettings?: () => SpeculativeAgentSettingsInput | Promise<SpeculativeAgentSettingsInput>;
	/** Drafter model. Defaults to the actor model for the current provider turn. */
	readonly draftModel?: Model<Api> | ((actorModel: Model<Api>) => Model<Api> | Promise<Model<Api>>);
	/** Resolve drafter request options, including credentials when using a different provider. */
	readonly getDraftOptions?: (context: DraftOptionsContext) => SimpleStreamOptions | Promise<SimpleStreamOptions>;
	/**
	 * Non-interactive permission and policy check for speculative execution.
	 * Candidates are rejected when this callback is absent.
	 */
	readonly preflight?: (
		context: SpeculativeAgentPreflightContext,
	) => boolean | CandidatePreflight | Promise<boolean | CandidatePreflight>;
	/** Canonical K(a), reuse, projection, versioning, and sandbox policy for this host. */
	readonly actionSemantics?: ActionSemanticsRegistry;
	/** Lossless Π rules; each rule owns key relation, realized coverage, and output reconstruction. */
	readonly projectionRules?: readonly ActionProjectionRule<SettleToolCallResult>[];
	/** Required capability for every tool configured under tools.sandbox. */
	readonly sandbox?: SpeculativeAgentSandbox;
	/** Optional persistence root for workspace-hashed PatternAware state. */
	readonly patternStateDirectory?: string;
	/** Optional injected store, primarily for embedding and deterministic tests. */
	readonly patternStore?: PatternAwareStore | Promise<PatternAwareStore>;
	readonly onEvent?: (event: SpeculativeActionEvent<string>) => void | Promise<void>;
}

interface AgentStartInput {
	readonly sessionID: string;
	readonly turnID: string;
	readonly actorModel: Model<Api>;
	readonly context: Context;
	readonly actorOptions: SimpleStreamOptions | undefined;
	readonly tools: readonly AgentTool[];
}

interface AgentConsumeInput {
	readonly sessionID: string;
	readonly turnID: string;
	readonly id?: string;
	readonly tool: string;
	readonly args: unknown;
	readonly terminal?: boolean;
}

interface AgentStateData {
	readonly tools: ReadonlyMap<string, AgentTool>;
	readonly schemaHashes: Readonly<Record<string, string>>;
}

export interface InstalledSpeculativeAction {
	readonly sessionID: string;
	readonly runtime: SpeculativeActionRuntime<
		string,
		SettleToolCallResult,
		AgentStartInput,
		AgentConsumeInput,
		AgentConsumeInput
	>;
	readonly uninstall: () => Promise<void>;
}

export function patternPlanActionID(actionIdentity: string, parentActionID = "root"): string {
	return `pattern:${stableHash({ actionIdentity, parentActionID }).slice(0, 16)}`;
}

/**
 * Install source-neutral speculative plan execution on an Agent.
 *
 * The installer wraps the actor stream to start the drafter concurrently and composes with any
 * existing settlement hook. Call `uninstall()` before discarding the Agent.
 */
export function installSpeculativeAction(
	agent: Agent,
	options: InstallSpeculativeActionOptions,
): InstalledSpeculativeAction {
	const sessionID = agent.sessionId ?? `pi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	const baseStream = agent.streamFunction;
	const previousSettlement = agent.settleToolCall;
	const previousActual = agent.actualToolCall;
	const actionSemantics = options.actionSemantics ?? PI_ACTION_SEMANTICS;
	const projectionRules = (options.projectionRules ?? []).filter((rule) => actionSemantics.supportsProjector(rule.id));
	const executionWorldMode = (tool: string): ExecutionWorldMode | undefined => {
		const mode = actionSemantics.sandboxMode(tool);
		return mode === "file_mutation" || mode === "workspace_snapshot" ? mode : undefined;
	};
	const patternActionSemantics = {
		actionKey: (tool: string, input: Readonly<Record<string, unknown>>, schemaHash?: string) =>
			actionSemantics.buildKey(tool, input, options.cwd, schemaHash),
		projectors: projectionRules,
	};
	let openedPatternStore: Promise<PatternAwareStoreLease> | undefined;
	const authoritativeBatches = new Map<string, Map<number, PatternAwareEventInput>>();
	const authoritativeBatchKey = (batchSessionID: string, turnID: string) => JSON.stringify([batchSessionID, turnID]);
	const clearAuthoritativeSession = (batchSessionID: string) => {
		for (const [key, batch] of authoritativeBatches) {
			if (batch.values().next().value?.sessionID === batchSessionID) authoritativeBatches.delete(key);
		}
	};
	const resolveSettings = async (): Promise<SpeculativeActionSettings> => {
		const settings = (await options.getSettings?.()) ?? {};
		return {
			enabled: typeof settings.enabled === "boolean" ? settings.enabled : DEFAULTS.enabled,
			drafterEnabled:
				typeof settings.drafterEnabled === "boolean" ? settings.drafterEnabled : DEFAULTS.drafterEnabled,
			candidateLimit: clampCandidateLimit(settings.candidateLimit ?? DEFAULTS.candidateLimit),
			maxConcurrentActions: clampCandidateLimit(settings.maxConcurrentActions ?? DEFAULTS.maxConcurrentActions),
			resourceCacheMaxEntries: normalizePositiveInteger(
				settings.resourceCacheMaxEntries,
				DEFAULTS.resourceCacheMaxEntries,
			),
			resourceCacheMaxBytes: normalizePositiveInteger(
				settings.resourceCacheMaxBytes,
				DEFAULTS.resourceCacheMaxBytes,
			),
			predictionTimeoutMs: normalizeTimeout(settings.predictionTimeoutMs),
			adaptiveDrafter:
				typeof settings.adaptiveDrafter === "boolean" ? settings.adaptiveDrafter : DEFAULTS.adaptiveDrafter,
			patternAware: patternAwareSettings(settings.patternAware ?? PATTERN_AWARE_DEFAULTS),
			tools: {
				resourceCached: normalizeStringArray(settings.tools?.resourceCached, DEFAULTS.tools.resourceCached),
				sandbox: normalizeStringArray(settings.tools?.sandbox, DEFAULTS.tools.sandbox),
			},
		};
	};
	const resolvePatternStore = async (settings: SpeculativeActionSettings): Promise<PatternAwareStore> => {
		if (options.patternStore) {
			const store = await options.patternStore;
			store.configure(settings.patternAware ?? PATTERN_AWARE_DEFAULTS, patternActionSemantics);
			return store;
		}
		openedPatternStore ??= acquirePatternAwareStore(
			options.cwd,
			settings.patternAware ?? PATTERN_AWARE_DEFAULTS,
			options.patternStateDirectory,
			patternActionSemantics,
		);
		const store = (await openedPatternStore).store;
		store.configure(settings.patternAware ?? PATTERN_AWARE_DEFAULTS, patternActionSemantics);
		return store;
	};
	const finishPatternSession = async (): Promise<void> => {
		clearAuthoritativeSession(sessionID);
		const store = options.patternStore
			? await options.patternStore
			: openedPatternStore
				? (await openedPatternStore).store
				: undefined;
		if (!store) return;
		store.finishSession(sessionID);
		try {
			await store.flush();
		} catch {
			// Persistence failure must not change Agent lifecycle semantics.
		}
	};
	const prepareSandbox = async (tools: readonly string[], signal?: AbortSignal): Promise<void> => {
		const modes = [
			...new Set(
				tools.flatMap((tool) => {
					const mode = executionWorldMode(tool);
					return mode && options.sandbox?.supports(mode) ? [mode] : [];
				}),
			),
		];
		if (!modes.length) return;
		await options.sandbox?.prepare?.({
			cwd: options.cwd,
			modes,
			...(signal ? { signal } : {}),
		});
	};
	type AgentPlanSource = SpeculativePlanSource<
		string,
		SettleToolCallResult,
		AgentStartInput,
		AgentConsumeInput,
		AgentStateData
	>;
	type PatternPlanFeedback = PatternAwareRuntimeContext & { readonly patternIDs: ReadonlyArray<string> };
	const asPatternPlanFeedback = (value: unknown): PatternPlanFeedback | undefined => {
		const context = asPatternAwareRuntimeContext(value);
		const patternIDs = (value as { patternIDs?: unknown })?.patternIDs;
		if (!context || !Array.isArray(patternIDs) || !patternIDs.every((item) => typeof item === "string"))
			return undefined;
		return { ...context, patternIDs };
	};
	const patternPlanAction = (
		candidate: PatternAwareCandidate,
		store: PatternAwareStore,
		id: string,
		dependsOn?: PlanAction["dependsOn"],
	): PlanAction => ({
		id,
		type: candidate.type,
		tool: candidate.tool,
		input: candidate.input,
		missing: candidate.missing,
		diagnostic: candidate.diagnostic,
		horizon: candidate.horizon,
		empiricalProbability: candidate.empiricalProbability,
		conditionalProbability: candidate.conditionalProbability,
		expectedDurationMs: candidate.expectedDurationMs,
		expectedLatencyBenefitMs: candidate.expectedLatencyBenefitMs,
		depth: candidate.depth,
		...(dependsOn?.length ? { dependsOn } : {}),
		feedback: { ...patternAwareRuntimeContext(store, candidate), patternIDs: candidate.supportingPatternIDs },
	});
	const drafterSource: AgentPlanSource = {
		id: "drafter",
		enabled: (settings) => settings.drafterEnabled ?? DEFAULTS.drafterEnabled,
		adaptive: true,
		timeoutMs: (settings) => settings.predictionTimeoutMs,
		propose: async ({ startInput: input, settings, candidateNames, signal }): Promise<PlanProposal> => {
			const draftModel =
				typeof options.draftModel === "function"
					? await options.draftModel(input.actorModel)
					: (options.draftModel ?? input.actorModel);
			const configuredDraftOptions = options.getDraftOptions
				? await options.getDraftOptions({
						actorModel: input.actorModel,
						draftModel,
						actorOptions: input.actorOptions,
						signal,
					})
				: {
						...input.actorOptions,
						signal,
						temperature: 0,
						maxTokens: Math.max(128, (settings.candidateLimit ?? DEFAULTS.candidateLimit) * 96),
						reasoning: undefined,
						sessionId: `${sessionID}:speculative`,
					};
			const enabledTools = new Set(candidateNames);
			const stream = await baseStream(
				draftModel,
				{
					systemPrompt: [
						input.context.systemPrompt,
						buildDrafterToolCallPrompt(settings.candidateLimit ?? DEFAULTS.candidateLimit),
					]
						.filter(Boolean)
						.join("\n\n"),
					messages: input.context.messages,
					tools: (input.context.tools ?? []).filter((tool) => enabledTools.has(tool.name)),
				},
				{ ...configuredDraftOptions, signal },
			);
			for await (const _event of stream) {
				// Draining drives every StreamFn implementation to its terminal event.
			}
			const message = await stream.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? `Drafter stopped with ${message.stopReason}`);
			}
			return {
				id: `drafter:${input.turnID}`,
				source: "drafter",
				revision: 0,
				actions: message.content
					.filter((item): item is AgentToolCall => item.type === "toolCall")
					.map((call, index) => ({
						id: `${index}:${call.id}`,
						type: "tool_call" as const,
						tool: call.name,
						input: call.arguments,
						diagnostic: JSON.stringify({ toolCallID: call.id, tool: call.name, input: call.arguments }, null, 2),
					})),
				draftTokens: usageTokenCount(message.usage),
			};
		},
	};
	const patternSource: AgentPlanSource = {
		id: "pattern_aware",
		enabled: (settings) => settings.patternAware?.enabled ?? false,
		multiStepEnabled: (settings) => settings.patternAware?.multiStepEnabled ?? true,
		propose: async ({ startInput, settings, definitions }) => {
			if (!settings.patternAware?.enabled) {
				return { id: `pattern:${startInput.turnID}`, source: "pattern_aware", revision: 0, actions: [] };
			}
			const store = await resolvePatternStore(settings);
			const proposalID = `pattern:${startInput.turnID}`;
			const candidates = store.predict(startInput.sessionID, definitionSchemaHashes(definitions));
			return {
				id: proposalID,
				source: "pattern_aware",
				revision: 0,
				actions: candidates.map((candidate) =>
					patternPlanAction(candidate, store, patternPlanActionID(candidate.actionIdentity)),
				),
			};
		},
		continue: async ({
			startInput,
			data,
			candidate,
			proposalID,
			actionID,
			revision,
			feedback,
			output,
			parentConfirmed,
		}) => {
			const context = asPatternPlanFeedback(feedback);
			if (!context) return undefined;
			const observation = projectPatternAwareObservation(
				output.result,
				extractOutputPaths(candidate.key.tool, output.result),
				options.cwd,
			);
			const next = context.store.continue(
				context.continuation,
				{
					sessionID: startInput.sessionID,
					turnID: startInput.turnID,
					tool: candidate.key.tool,
					input: structuredClone(candidate.key.input) as Record<string, unknown>,
					outcome: output.isError ? "failure" : "success",
					...observation,
					durationMs: candidateExecutionMs(candidate),
					schemaHash: candidate.key.schemaHash,
					...(typeof candidate.key.input.operation === "string"
						? { operation: candidate.key.input.operation }
						: {}),
					learnTarget: false,
				},
				data.schemaHashes,
				parentConfirmed,
			);
			if (!next.length) return undefined;
			return {
				proposalID,
				source: "pattern_aware",
				revision,
				upsert: next.map((item) =>
					patternPlanAction(item, context.store, patternPlanActionID(item.actionIdentity, actionID), [
						{ actionID, condition: "succeeded" },
					]),
				),
			};
		},
		observe: async ({ startInput, settings, consumeInput, action, tool, concrete, output, durationMs, order }) => {
			if (!settings.patternAware?.enabled) return undefined;
			const definition = startInput.tools.find((item) => item.name === tool);
			const observation = projectPatternAwareObservation(
				output?.result,
				extractOutputPaths(tool, output?.result),
				options.cwd,
			);
			const key = authoritativeBatchKey(consumeInput.sessionID, consumeInput.turnID);
			const batch = authoritativeBatches.get(key) ?? new Map();
			batch.set(order, {
				sessionID: consumeInput.sessionID,
				turnID: consumeInput.turnID,
				tool,
				input: action ? (structuredClone(action.input) as Record<string, unknown>) : concrete,
				outcome: output?.isError ? "failure" : "success",
				...observation,
				durationMs,
				...(typeof concrete.operation === "string" ? { operation: concrete.operation } : {}),
				...(definition ? { schemaHash: stableHash(definition.parameters) } : {}),
				learnTarget: candidateToolNames(settings, actionSemantics).includes(tool),
			});
			authoritativeBatches.set(key, batch);
			return undefined;
		},
		onLaunched: ({ feedback }) => {
			const context = asPatternPlanFeedback(feedback);
			for (const patternID of context?.patternIDs ?? []) context?.store.launched(patternID);
		},
		onResolved: ({ feedback, outcome }) => {
			const context = asPatternPlanFeedback(feedback);
			for (const patternID of context?.patternIDs ?? []) context?.store.resolved(patternID, outcome);
		},
		flush: async () => {
			if (openedPatternStore) await (await openedPatternStore).store.flush();
			if (options.patternStore) await (await options.patternStore).flush();
		},
	};

	const runtime = makeSpeculativeActionRuntime<
		string,
		SettleToolCallResult,
		AgentStartInput,
		AgentConsumeInput,
		AgentConsumeInput,
		AgentStateData
	>({
		actionSemantics,
		sources: [patternSource, drafterSource],
		settings: resolveSettings,
		definitions: (input) =>
			input.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
		stateData: (input) => ({
			tools: new Map(input.tools.map((tool) => [tool.name, tool])),
			schemaHashes: definitionSchemaHashes(
				input.tools.map((tool) => ({ name: tool.name, inputSchema: tool.parameters })),
			),
		}),
		actionKey: async (toolName, input, context) => {
			let tool: AgentTool | undefined;
			let validated: unknown;
			if (context.type === "consume") {
				tool = agent.state.tools.find((candidate) => candidate.name === toolName);
				validated = input;
			} else {
				tool = context.data.tools.get(toolName);
				if (!tool) return undefined;
				validated = validateCandidateArguments(tool, toolName, input, "spec_key");
				if (validated === undefined) return undefined;
			}
			if (!tool) return undefined;
			let invocation: AgentToolInvocation | undefined;
			try {
				invocation = await tool.resolveInvocation?.(validated as never);
			} catch {
				return undefined;
			}
			const schemaHash =
				context.type === "consume" ? stableHash(tool.parameters ?? null) : context.data.schemaHashes[toolName];
			return actionSemantics.buildKey(
				toolName,
				validated,
				options.cwd,
				schemaHash,
				invocation ? { fingerprint: stableHash(invocation), context: invocation } : undefined,
			);
		},
		actual: (input) => ({ id: input.id, tool: input.tool, input: input.args }),
		preflightCandidate: async ({ data, tool: toolName, concrete, action, callID, signal }) => {
			const tool = data.tools.get(toolName);
			if (!tool || !options.preflight) return { ok: false, reason: "permission_or_policy" };
			const args = validateCandidateArguments(tool, toolName, concrete, callID);
			if (args === undefined) return { ok: false, reason: "invalid_tool_call_input" };
			const mode = executionWorldMode(toolName);
			if (action.execution === "sandbox" && (!mode || !options.sandbox?.supports(mode))) {
				return { ok: false, reason: "sandbox_unavailable" };
			}
			if (mode === "workspace_snapshot" && !asAgentToolInvocation(action.executionContext)?.process) {
				return { ok: false, reason: "execution_context_unavailable" };
			}
			const result = await options.preflight({ tool, toolName, args, action, signal });
			return typeof result === "boolean"
				? result
					? { ok: true }
					: { ok: false, reason: "permission_or_policy" }
				: result;
		},
		authorizeCandidate: async ({ stateData, tool: toolName, concrete, action, signal }) => {
			const tool = stateData.tools.get(toolName);
			if (!tool || !options.preflight) return { ok: false, reason: "permission_or_policy_changed" };
			const args = validateCandidateArguments(tool, toolName, concrete, "spec_authorize");
			if (args === undefined) return { ok: false, reason: "invalid_tool_call_input" };
			const result = await options.preflight({
				tool,
				toolName,
				args,
				action,
				signal: signal ?? new AbortController().signal,
			});
			if (typeof result === "boolean") {
				return result ? { ok: true } : { ok: false, reason: "permission_or_policy_changed" };
			}
			return result.ok ? result : { ...result, reason: "permission_or_policy_changed" };
		},
		executeCandidate: async ({ data, tool: toolName, concrete, action, callID, signal }) => {
			const tool = data.tools.get(toolName);
			if (!tool) return errorSettlement(`Tool ${toolName} not found`);
			const args = validateCandidateArguments(tool, toolName, concrete, callID);
			if (args === undefined) return errorSettlement(`Invalid arguments for tool ${toolName}`);
			if (action.execution === "sandbox") {
				const mode = executionWorldMode(toolName);
				if (!mode || !options.sandbox?.supports(mode)) throw new Error(`Sandbox unavailable for tool ${toolName}`);
				const branch = await options.sandbox.fork({
					mode,
					cwd: options.cwd,
					tool,
					toolName,
					args,
					action,
					invocation: asAgentToolInvocation(action.executionContext),
					callID,
					signal,
				});
				return branch;
			}
			try {
				return { result: await tool.execute(callID, args as never, signal), isError: false };
			} catch (error) {
				return errorSettlement(error instanceof Error ? error.message : String(error));
			}
		},
		rejectCandidateOutput: ({ output }) => (output.isError ? "tool_error_result" : undefined),
		captureResourceVersion: ({ action }) => captureResourceVersion(action, options.cwd, actionSemantics),
		releaseResourceVersion,
		isResourceExpired: ({ candidate }) => validateResourceVersion(candidate.resourceVersion),
		watchResourceVersion: ({ candidate, onInvalidated }) =>
			watchResourceVersion(candidate.resourceVersion, onInvalidated),
		projectionRules,
		prepareCandidate: async ({ candidate, signal }) => {
			if (candidate.execution !== "sandbox" && actionSemantics.execution(candidate.tool) !== "sandbox") return;
			const mode = executionWorldMode(candidate.tool);
			if (!mode || !options.sandbox?.supports(mode)) throw new Error(`Sandbox unavailable for ${candidate.tool}`);
			await prepareSandbox([candidate.tool], signal);
		},
		onTurnStarted: async ({ startInput, settings, signal }) => {
			authoritativeBatches.delete(authoritativeBatchKey(startInput.sessionID, startInput.turnID));
			void prepareSandbox(settings.tools.sandbox, signal).catch(() => {
				// Turn warm-up is best-effort; concrete candidate preparation retries it.
			});
			if (!settings.patternAware?.enabled) return;
			const store = await resolvePatternStore(settings);
			store.observeTurn({
				sessionID: startInput.sessionID,
				turnID: startInput.turnID,
				phase: "start",
				model: `${startInput.actorModel.provider}/${startInput.actorModel.id}`,
			});
		},
		onTurnFinished: async ({ startInput, settings, terminal, durationMs }) => {
			const key = authoritativeBatchKey(startInput.sessionID, startInput.turnID);
			const batch = authoritativeBatches.get(key);
			authoritativeBatches.delete(key);
			if (!settings.patternAware?.enabled) return;
			const store = await resolvePatternStore(settings);
			if (batch?.size) {
				store.observeBatch(
					[...batch.entries()].sort(([left], [right]) => left - right).map(([, event]) => event),
					definitionSchemaHashes(
						startInput.tools.map((tool) => ({ name: tool.name, inputSchema: tool.parameters })),
					),
				);
			}
			store.observeTurn({
				sessionID: startInput.sessionID,
				turnID: startInput.turnID,
				phase: "finish",
				terminal,
				durationMs,
			});
			if (terminal) store.finishSession(startInput.sessionID);
		},
		onEvent: options.onEvent,
	});

	let currentTurnID: string | undefined;
	let turnSequence = 0;
	const wrappedStream: StreamFn = async (model, context, actorOptions) => {
		const turnID = `turn_${++turnSequence}`;
		currentTurnID = turnID;
		try {
			await runtime.startTurn(
				{
					sessionID,
					turnID,
					actorModel: model,
					context,
					actorOptions,
					tools: agent.state.tools.slice(),
				},
				actorOptions?.signal,
			);
		} catch {
			// Speculation is optional; the actor request must remain available.
		}
		return baseStream(model, context, actorOptions);
	};

	const installedSettlement = async (
		context: SettleToolCallContext,
		signal?: AbortSignal,
	): Promise<SettleToolCallResult | undefined> => {
		const previous = await previousSettlement?.(context, signal);
		if (previous) return previous;
		if (!currentTurnID) return undefined;
		return runtime.consume(
			{
				sessionID,
				turnID: currentTurnID,
				id: context.toolCall.id,
				tool: context.toolCall.name,
				args: context.args,
			},
			signal,
		);
	};

	const installedActual = async (context: ActualToolCallContext, signal?: AbortSignal): Promise<void> => {
		try {
			await previousActual?.(context, signal);
		} catch {
			// Telemetry observers compose independently.
		}
		if (!currentTurnID) return;
		try {
			await runtime.actual({
				sessionID,
				turnID: currentTurnID,
				id: context.toolCall.id,
				tool: context.toolCall.name,
				args: context.args,
				durationMs: context.durationMs,
				output: { result: context.result, isError: context.isError },
			});
		} catch {
			// Speculative telemetry must never alter real tool execution.
		}
	};

	agent.streamFunction = wrappedStream;
	agent.settleToolCall = installedSettlement;
	agent.actualToolCall = installedActual;
	let lastTurnID: string | undefined;
	const unsubscribe = agent.subscribe(async (event) => {
		if (event.type === "turn_end" && currentTurnID) {
			const finishedTurnID = currentTurnID;
			currentTurnID = undefined;
			lastTurnID = finishedTurnID;
			await runtime.finishTurn({ sessionID, turnID: finishedTurnID, tool: "", args: {} });
			return;
		}
		if (event.type !== "agent_end") return;
		const terminalTurnID = currentTurnID ?? lastTurnID;
		currentTurnID = undefined;
		lastTurnID = undefined;
		if (terminalTurnID) {
			await runtime.finishTurn({
				sessionID,
				turnID: terminalTurnID,
				tool: "",
				args: {},
				terminal: true,
			});
		}
		await finishPatternSession();
	});

	return {
		sessionID,
		runtime,
		uninstall: async () => {
			unsubscribe();
			if (agent.streamFunction === wrappedStream) agent.streamFunction = baseStream;
			if (agent.settleToolCall === installedSettlement) agent.settleToolCall = previousSettlement;
			if (agent.actualToolCall === installedActual) agent.actualToolCall = previousActual;
			try {
				await runtime.releaseSession(sessionID);
				await finishPatternSession();
			} finally {
				try {
					if (openedPatternStore) {
						try {
							await (await openedPatternStore).release();
						} catch {
							// Persistence failure must not change Agent uninstall semantics.
						}
					}
				} finally {
					try {
						await options.sandbox?.dispose?.();
					} catch {
						// Sandbox resource cleanup must not change Agent uninstall semantics.
					}
				}
			}
		},
	};
}

function asAgentToolInvocation(value: unknown): AgentToolInvocation | undefined {
	if (!value || typeof value !== "object" || typeof (value as { executor?: unknown }).executor !== "string") return;
	return value as AgentToolInvocation;
}

function validateCandidateArguments(
	tool: AgentTool,
	toolName: string,
	input: unknown,
	callID: string,
): unknown | undefined {
	try {
		const prepared = tool.prepareArguments ? tool.prepareArguments(input) : input;
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: callID,
			name: toolName,
			arguments: prepared as Record<string, unknown>,
		};
		return validateToolArguments(tool, toolCall);
	} catch {
		return undefined;
	}
}

function errorSettlement(message: string): SettleToolCallResult {
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: message }],
		details: {},
	};
	return { result, isError: true };
}

function definitionSchemaHashes(
	definitions: readonly { readonly name: string; readonly inputSchema?: unknown }[],
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		definitions.map((definition) => [definition.name, stableHash(definition.inputSchema ?? null)]),
	);
}

function stableHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex")
		.slice(0, 32);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableValue(item)]),
	);
}

function extractOutputPaths(tool: string, result: AgentToolResult<unknown> | undefined): readonly string[] | undefined {
	if ((tool !== "find" && tool !== "grep") || !result) return undefined;
	const text = result.content
		.filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	const paths = text
		.split(/\r?\n/)
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("[") || /^No files found\b/.test(trimmed)) return undefined;
			if (tool === "find") return trimmed;
			return /^(.*?):\d+(?::\d+)?:/.exec(trimmed)?.[1];
		})
		.filter((item): item is string => typeof item === "string" && item.length > 0);
	return paths.length ? [...new Set(paths)] : undefined;
}

function normalizeTimeout(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: DEFAULTS.predictionTimeoutMs;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeStringArray(value: unknown, fallback: readonly string[]): readonly string[] {
	return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : fallback;
}
