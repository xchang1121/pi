import type {
	Agent,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	SettleToolCallContext,
	SettleToolCallResult,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ActionKey } from "./common.ts";
import {
	buildDrafterToolCallPrompt,
	buildPiActionKey,
	clampMaxCandidates,
	DEFAULTS,
	usageTokenCount,
} from "./common.ts";
import { fingerprintActionResources } from "./resource-version.ts";
import type {
	CandidatePreflight,
	SpeculativeActionEvent,
	SpeculativeActionRuntime,
	SpeculativeActionSettings,
	SpeculativeCandidate,
	SpeculativeDraftCandidate,
} from "./runtime.ts";
import { makeSpeculativeActionRuntime } from "./runtime.ts";

export interface SpeculativeAgentSettingsInput {
	readonly enabled?: boolean;
	readonly maxCandidates?: number;
	readonly predictionTimeoutMs?: number;
	readonly tools?: {
		readonly liveReadonly?: readonly string[];
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

export interface SpeculativeAgentProjectionContext {
	readonly action: ActionKey;
	readonly candidate: SpeculativeCandidate;
	readonly output: SettleToolCallResult;
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
	/** Optional conservative projection for a containing read result. */
	readonly projectOutput?: (
		context: SpeculativeAgentProjectionContext,
	) => SettleToolCallResult | undefined | Promise<SettleToolCallResult | undefined>;
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
	readonly tool: string;
	readonly args: unknown;
}

interface AgentStateData {
	readonly tools: ReadonlyMap<string, AgentTool>;
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

/**
 * Install single-step speculative pre-execution on an Agent.
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
	const resolveSettings = async (): Promise<SpeculativeActionSettings> => {
		const settings = (await options.getSettings?.()) ?? {};
		return {
			enabled: settings.enabled ?? DEFAULTS.enabled,
			mode: "predict_action_single_step",
			maxCandidates: clampMaxCandidates(settings.maxCandidates ?? DEFAULTS.maxCandidates),
			predictionTimeoutMs: normalizeTimeout(settings.predictionTimeoutMs),
			tools: {
				liveReadonly: settings.tools?.liveReadonly ?? DEFAULTS.tools.liveReadonly,
				sandbox: settings.tools?.sandbox ?? DEFAULTS.tools.sandbox,
			},
		};
	};

	const projection = options.projectOutput
		? async (input: {
				action: ActionKey;
				candidate: SpeculativeCandidate;
				output: SettleToolCallResult;
			}): Promise<SettleToolCallResult | undefined> => options.projectOutput?.(input)
		: undefined;

	const runtime = makeSpeculativeActionRuntime<
		string,
		SettleToolCallResult,
		AgentStartInput,
		AgentConsumeInput,
		AgentConsumeInput,
		AgentStateData
	>({
		settings: resolveSettings,
		definitions: (input) =>
			input.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
		stateData: (input) => ({ tools: new Map(input.tools.map((tool) => [tool.name, tool])) }),
		predict: async (input, settings, definitions, _candidateNames, signal) => {
			const draftModel =
				typeof options.draftModel === "function"
					? await options.draftModel(input.actorModel)
					: (options.draftModel ?? input.actorModel);
			const draftOptions = options.getDraftOptions
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
						maxTokens: Math.max(128, settings.maxCandidates * 96),
						reasoning: undefined,
						sessionId: `${sessionID}:speculative`,
					};
			const stream = await baseStream(
				draftModel,
				{
					systemPrompt: [
						input.context.systemPrompt,
						buildDrafterToolCallPrompt(definitions, [], settings.maxCandidates),
					]
						.filter(Boolean)
						.join("\n\n"),
					messages: input.context.messages,
					tools: input.context.tools,
				},
				draftOptions,
			);
			for await (const _event of stream) {
				// Draining drives every StreamFn implementation to its terminal event.
			}
			const message = await stream.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? `Drafter stopped with ${message.stopReason}`);
			}
			return {
				candidates: message.content
					.filter((item): item is AgentToolCall => item.type === "toolCall")
					.map(
						(call): SpeculativeDraftCandidate => ({
							type: "tool_call",
							tool: call.name,
							input: call.arguments,
							diagnostic: JSON.stringify(
								{ toolCallID: call.id, tool: call.name, input: call.arguments },
								null,
								2,
							),
						}),
					),
				draftTokens: usageTokenCount(message.usage),
			};
		},
		actionKey: (toolName, input, context) => {
			if (context.type === "consume") return buildPiActionKey(toolName, input, options.cwd);
			const tool = context.data.tools.get(toolName);
			if (!tool) return undefined;
			const validated = validateCandidateArguments(tool, toolName, input, "spec_key");
			return validated === undefined ? undefined : buildPiActionKey(toolName, validated, options.cwd);
		},
		actual: (input) => ({ tool: input.tool, input: input.args }),
		preflightCandidate: async ({ data, tool: toolName, concrete, action, callID, signal }) => {
			const tool = data.tools.get(toolName);
			if (!tool || !options.preflight) return { ok: false, reason: "permission_or_policy" };
			const args = validateCandidateArguments(tool, toolName, concrete, callID);
			if (args === undefined) return { ok: false, reason: "invalid_tool_call_input" };
			const result = await options.preflight({ tool, toolName, args, action, signal });
			return typeof result === "boolean"
				? result
					? { ok: true }
					: { ok: false, reason: "permission_or_policy" }
				: result;
		},
		executeCandidate: async ({ data, tool: toolName, concrete, callID, signal }) => {
			const tool = data.tools.get(toolName);
			if (!tool) return errorSettlement(`Tool ${toolName} not found`);
			const args = validateCandidateArguments(tool, toolName, concrete, callID);
			if (args === undefined) return errorSettlement(`Invalid arguments for tool ${toolName}`);
			try {
				return { result: await tool.execute(callID, args as never, signal), isError: false };
			} catch (error) {
				return errorSettlement(error instanceof Error ? error.message : String(error));
			}
		},
		captureResourceVersion: ({ action }) => fingerprintActionResources(action, options.cwd),
		isResourceExpired: async ({ action, candidate }) => {
			if (typeof candidate.resourceVersion !== "string") return true;
			return candidate.resourceVersion !== (await fingerprintActionResources(action, options.cwd));
		},
		...(projection
			? {
					projectOutput: ({ action, candidate, output }) => projection({ action, candidate, output }),
				}
			: {}),
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
				tool: context.toolCall.name,
				args: context.args,
			},
			signal,
		);
	};

	agent.streamFunction = wrappedStream;
	agent.settleToolCall = installedSettlement;
	const unsubscribe = agent.subscribe(async (event) => {
		if ((event.type !== "turn_end" && event.type !== "agent_end") || !currentTurnID) return;
		const finishedTurnID = currentTurnID;
		currentTurnID = undefined;
		await runtime.finishTurn({ sessionID, turnID: finishedTurnID, tool: "", args: {} });
	});

	return {
		sessionID,
		runtime,
		uninstall: async () => {
			unsubscribe();
			if (agent.streamFunction === wrappedStream) agent.streamFunction = baseStream;
			if (agent.settleToolCall === installedSettlement) agent.settleToolCall = previousSettlement;
			await runtime.disposeSession(sessionID);
		},
	};
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

function normalizeTimeout(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: DEFAULTS.predictionTimeoutMs;
}
