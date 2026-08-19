import { createHash } from "node:crypto";
import type { AgentTool, AgentToolCall, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ActionProjectionRule } from "./action-key-projection.ts";
import { type ActionKey, type ActionSemanticsRegistry, PI_ACTION_SEMANTICS } from "./action-semantics.ts";
import { buildSingleToolCallPrompt, clampCandidateLimit, DEFAULTS, usageTokenCount } from "./common.ts";
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
	patternAwareAnalyzerKey,
	patternAwareRuntimeContext,
	patternAwareSettings,
	projectPatternAwareObservation,
} from "./pattern-aware.ts";
import type { PlanAction, PlanProposal } from "./plan-proposal.ts";
import {
	captureResourceVersion,
	type ResourceVersionValidation,
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
import { cause, type ResourceValidation } from "./settlement.ts";
import type { ToolInvocation, ToolSettlement } from "./tool-settlement.ts";
import type { SpeculativeAgentSandbox } from "./workspace-sandbox.ts";

export interface SpeculativeAgentSettingsInput {
	readonly enabled?: boolean;
	readonly drafterEnabled?: boolean;
	readonly candidateLimit?: number;
	readonly maxConcurrentActions?: number;
	readonly resourceCacheMaxEntries?: number;
	readonly resourceCacheMaxBytes?: number;
	readonly predictionTimeoutMs?: number;
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

export interface CreateSpeculativeActionHostOptions {
	/** Workspace root used for action canonicalization and resource validation. */
	readonly cwd: string;
	/** Runtime settings. The feature remains disabled when omitted. */
	readonly getSettings?: () => SpeculativeAgentSettingsInput | Promise<SpeculativeAgentSettingsInput>;
	/** Drafter model. Defaults to the actor model when omitted or unresolved. */
	readonly draftModel?:
		| Model<Api>
		| ((actorModel: Model<Api>) => Model<Api> | undefined | Promise<Model<Api> | undefined>);
	/** Resolve drafter request options, including credentials when using a different provider. */
	readonly getDraftOptions?: (context: DraftOptionsContext) => SimpleStreamOptions | Promise<SimpleStreamOptions>;
	/** Provider completion used by the drafter. */
	readonly complete: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
	/** Resolve the concrete executor identity used by both speculative and actor calls. */
	readonly resolveInvocation?: (
		tool: string,
		input: unknown,
	) => ToolInvocation | undefined | Promise<ToolInvocation | undefined>;
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
	readonly projectionRules?: readonly ActionProjectionRule<ToolSettlement>[];
	/** Required capability for every tool configured under tools.sandbox. */
	readonly sandbox?: SpeculativeAgentSandbox;
	/** Optional persistence root for workspace-hashed PatternAware state. */
	readonly patternStateDirectory?: string;
	/** Optional injected store, primarily for embedding and deterministic tests. */
	readonly patternStore?: PatternAwareStore | Promise<PatternAwareStore>;
	readonly onEvent?: (event: SpeculativeActionEvent<string>) => void | Promise<void>;
}

export interface SpeculativeActionHost {
	readonly sessionID: string;
	readonly runtime: SpeculativeActionRuntime<
		string,
		ToolSettlement,
		AgentStartInput,
		AgentConsumeInput,
		AgentConsumeInput
	>;
	readonly startTurn: (input: Omit<AgentStartInput, "sessionID">, signal?: AbortSignal) => Promise<void>;
	readonly consume: (
		input: Omit<AgentConsumeInput, "sessionID">,
		signal?: AbortSignal,
	) => Promise<ToolSettlement | undefined>;
	readonly actual: (
		input: Omit<AgentConsumeInput, "sessionID"> & { readonly durationMs: number; readonly output?: ToolSettlement },
	) => Promise<void>;
	readonly finishTurn: (turnID: string, terminal?: boolean) => Promise<void>;
	readonly dispose: () => Promise<void>;
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
	readonly tools: readonly AgentTool[];
	readonly terminal?: boolean;
}

interface AgentStateData {
	readonly tools: ReadonlyMap<string, AgentTool>;
	readonly schemaHashes: Readonly<Record<string, string>>;
}

export function patternPlanActionID(actionIdentity: string, parentActionID = "root"): string {
	return `pattern:${stableHash({ actionIdentity, parentActionID }).slice(0, 16)}`;
}

/**
 * Build source-neutral speculative plan execution for a host. The host owns lifecycle and tool interception.
 */
export function createSpeculativeActionHost(
	sessionID: string,
	options: CreateSpeculativeActionHostOptions,
): SpeculativeActionHost {
	const actionSemantics = options.actionSemantics ?? PI_ACTION_SEMANTICS;
	const projectionRules = (options.projectionRules ?? []).filter((rule) => actionSemantics.supportsProjector(rule.id));
	const executionWorldMode = (tool: string): ExecutionWorldMode | undefined => {
		const mode = actionSemantics.sandboxMode(tool);
		return mode === "file_mutation" || mode === "workspace_snapshot" ? mode : undefined;
	};
	const patternActionSemantics = {
		namespace: "pi-action-semantics-v1",
		actionKey: (tool: string, input: Readonly<Record<string, unknown>>, schemaHash?: string) =>
			actionSemantics.buildKey(tool, input, options.cwd, schemaHash),
		projectors: projectionRules,
	};
	let openedPatternStore: Promise<PatternAwareStoreLease> | undefined;
	let openedPatternStoreKey: string | undefined;
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
			sourceConfig: { patternAware: patternAwareSettings(settings.patternAware ?? PATTERN_AWARE_DEFAULTS) },
			tools: {
				resourceCached: normalizeStringArray(settings.tools?.resourceCached, DEFAULTS.tools.resourceCached),
				sandbox: normalizeStringArray(settings.tools?.sandbox, DEFAULTS.tools.sandbox),
			},
		};
	};
	const sourcePatternSettings = (settings: SpeculativeActionSettings): PatternAwareSettings =>
		patternAwareSettings(settings.sourceConfig?.patternAware);
	const resolvePatternStore = async (settings: SpeculativeActionSettings): Promise<PatternAwareStore> => {
		if (options.patternStore) {
			return options.patternStore;
		}
		const patternSettings = sourcePatternSettings(settings);
		const configurationKey = patternAwareAnalyzerKey(patternSettings);
		if (openedPatternStore && openedPatternStoreKey !== configurationKey) {
			const previous = await openedPatternStore;
			previous.store.finishSession(sessionID);
			await previous.release();
			openedPatternStore = undefined;
		}
		openedPatternStoreKey = configurationKey;
		openedPatternStore ??= acquirePatternAwareStore(
			options.cwd,
			patternSettings,
			options.patternStateDirectory,
			patternActionSemantics,
		);
		return (await openedPatternStore).store;
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
		ToolSettlement,
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
		timeoutMs: (settings) => settings.predictionTimeoutMs,
		proposalCount: (settings) => clampCandidateLimit(settings.candidateLimit ?? DEFAULTS.candidateLimit),
		propose: async ({ startInput: input, candidateNames, proposalIndex, signal }): Promise<PlanProposal> => {
			const proposalID = `drafter:${input.turnID}:${proposalIndex}`;
			const configuredDraftModel =
				typeof options.draftModel === "function" ? await options.draftModel(input.actorModel) : options.draftModel;
			const draftModel = configuredDraftModel ?? input.actorModel;
			const configuredDraftOptions = options.getDraftOptions
				? await options.getDraftOptions({
						actorModel: input.actorModel,
						draftModel,
						actorOptions: input.actorOptions,
						signal,
					})
				: input.actorOptions;
			const draftOptions: SimpleStreamOptions = {
				...configuredDraftOptions,
				signal,
				temperature: proposalIndex === 0 ? 0 : 0.7,
				maxTokens: 128,
				reasoning: undefined,
				deferred: false,
				sessionId: `${sessionID}:${input.turnID}:${proposalIndex}`,
			};
			const enabledTools = new Set(candidateNames);
			const message = await options.complete(
				draftModel,
				{
					systemPrompt: [input.context.systemPrompt, buildSingleToolCallPrompt()].filter(Boolean).join("\n\n"),
					messages: input.context.messages,
					tools: (input.context.tools ?? []).filter((tool) => enabledTools.has(tool.name)),
				},
				draftOptions,
			);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? `Drafter stopped with ${message.stopReason}`);
			}
			const call = message.content.find((item): item is AgentToolCall => item.type === "toolCall");
			return {
				id: proposalID,
				source: "drafter",
				revision: 0,
				actions: call
					? [
							{
								id: `${proposalIndex}:${call.id}`,
								type: "tool_call" as const,
								tool: call.name,
								input: call.arguments,
								diagnostic: JSON.stringify(
									{ toolCallID: call.id, tool: call.name, input: call.arguments },
									null,
									2,
								),
							},
						]
					: [],
				draftTokens: usageTokenCount(message.usage),
			};
		},
	};
	const patternSource: AgentPlanSource = {
		id: "pattern_aware",
		enabled: (settings) => sourcePatternSettings(settings).enabled,
		multiStepEnabled: (settings) => sourcePatternSettings(settings).multiStepEnabled,
		propose: async ({ startInput, settings, definitions }) => {
			const patternSettings = sourcePatternSettings(settings);
			if (!patternSettings.enabled) {
				return { id: `pattern:${startInput.turnID}`, source: "pattern_aware", revision: 0, actions: [] };
			}
			const store = await resolvePatternStore(settings);
			const proposalID = `pattern:${startInput.turnID}`;
			const candidates = store.predict(startInput.sessionID, definitionSchemaHashes(definitions), patternSettings);
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
			settings,
			candidate,
			proposalID,
			actionID,
			revision,
			feedback,
			output,
			trigger,
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
				trigger === "actor_confirmed",
				sourcePatternSettings(settings),
			);
			if (!next.length) return undefined;
			return {
				proposalID,
				source: "pattern_aware",
				revision,
				upsert: next.map((item) =>
					patternPlanAction(item, context.store, patternPlanActionID(item.actionIdentity, actionID), [
						{ actionID, condition: "execution_succeeded" },
					]),
				),
			};
		},
		observe: async ({ startInput, settings, consumeInput, action, tool, concrete, output, durationMs, order }) => {
			if (!sourcePatternSettings(settings).enabled) return undefined;
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
		onIssued: ({ feedback }) => {
			const context = asPatternPlanFeedback(feedback);
			for (const patternID of context?.patternIDs ?? []) context?.store.issued(patternID);
		},
		onSettled: ({ feedback, settlement }) => {
			const context = asPatternPlanFeedback(feedback);
			for (const patternID of context?.patternIDs ?? []) context?.store.settled(patternID, settlement);
		},
		flush: async () => {
			if (openedPatternStore) await (await openedPatternStore).store.flush();
			if (options.patternStore) await (await options.patternStore).flush();
		},
	};

	const runtime = makeSpeculativeActionRuntime<
		string,
		ToolSettlement,
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
				tool = context.consumeInput.tools.find((candidate) => candidate.name === toolName);
				validated = input;
			} else {
				tool = context.data.tools.get(toolName);
				if (!tool) return undefined;
				validated = validateCandidateArguments(tool, toolName, input, "spec_key");
				if (validated === undefined) return undefined;
			}
			if (!tool) return undefined;
			let invocation: ToolInvocation | undefined;
			let worldFingerprint: string | undefined;
			try {
				invocation = await options.resolveInvocation?.(toolName, validated);
				const mode = actionSemantics.sandboxMode(toolName);
				if (mode && mode !== "none" && options.sandbox?.fingerprint) {
					worldFingerprint = await options.sandbox.fingerprint(mode);
				}
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
				invocation || worldFingerprint
					? {
							fingerprint: stableHash({ invocation: invocation ?? null, world: worldFingerprint ?? null }),
							...(invocation ? { context: invocation } : {}),
						}
					: undefined,
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
			if (mode === "workspace_snapshot" && !asToolInvocation(action.executionContext)?.process) {
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
		executeCandidate: async ({ data, tool: toolName, concrete, action, callID, signal, parentWorld }) => {
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
					invocation: asToolInvocation(action.executionContext),
					callID,
					signal,
					...(parentWorld?.checkpoint ? { parentCheckpoint: parentWorld.checkpoint } : {}),
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
		validateResourceVersion: async ({ candidate }) =>
			toRuntimeResourceValidation(await validateResourceVersion(candidate.resourceVersion)),
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
			if (!sourcePatternSettings(settings).enabled) return;
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
			if (!sourcePatternSettings(settings).enabled) return;
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

	return {
		sessionID,
		runtime,
		startTurn: (input, signal) => runtime.startTurn({ ...input, sessionID }, signal),
		consume: (input, signal) => runtime.consume({ ...input, sessionID }, signal),
		actual: (input) => runtime.actual({ ...input, sessionID }),
		finishTurn: async (turnID, terminal = false) => {
			await runtime.finishTurn({ sessionID, turnID, tool: "", args: {}, tools: [], terminal });
			if (terminal) await finishPatternSession();
		},
		dispose: async () => {
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

function asToolInvocation(value: unknown): ToolInvocation | undefined {
	if (!value || typeof value !== "object" || typeof (value as { executor?: unknown }).executor !== "string") return;
	return value as ToolInvocation;
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

function errorSettlement(message: string): ToolSettlement {
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: message }],
		details: {},
	};
	return { result, isError: true };
}

function toRuntimeResourceValidation(validation: ResourceVersionValidation): ResourceValidation {
	const metrics = {
		durationMs: validation.durationMs,
		bytesRead: validation.bytesRead,
		filesRead: validation.filesRead,
		mode: validation.mode,
	};
	return validation.expired
		? {
				status: "stale",
				cause: cause("freshness", validation.reason ?? "resource_changed"),
				metrics,
			}
		: { status: "valid", metrics };
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
