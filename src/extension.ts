import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionUIContext,
	getAgentDir,
	getShellConfig,
	type ModelRegistry,
	type ReadToolInput,
	type SourceInfo,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { IDEMPOTENT_ACTION_TOOLS, KEYABLE_TOOLS, SANDBOX_ACTION_TOOLS } from "./action-semantics.ts";
import { createSpeculativeActionHost } from "./agent-integration.ts";
import { clampCandidateLimit, clampDrafterDepth, DEFAULTS } from "./common.ts";
import { createContainerSandboxProcessBackend, DEFAULT_CONTAINER_SANDBOX_IMAGE } from "./container-sandbox.ts";
import { createNativeSandboxProcessBackend } from "./native-sandbox.ts";
import { createOciSetupService, type OciSetupService } from "./oci-setup.ts";
import { PATTERN_AWARE_DEFAULTS, type PatternAwareSettings, patternAwareSettings } from "./pattern-aware.ts";
import { PI_READ_RANGE_PROJECTION_RULE, withPiReadCoverage } from "./pi-read-projection.ts";
import type { SpeculativeActionEvent } from "./runtime.ts";
import {
	type SpeculativeActionPackageSettings,
	SpeculativeActionSettingsStore,
	type SpeculativeSettingsScope,
} from "./settings-store.ts";
import type { ToolInvocation, ToolSettlement } from "./tool-settlement.ts";
import { emptySpeculativeTraceSummary, reduceSpeculativeTrace, type SpeculativeTraceSummary } from "./trace-summary.ts";
import {
	createSandboxBackendRouter,
	createWorkspaceSandbox,
	type SandboxBackendRouter,
	type SandboxBackendRouterStatus,
	type SandboxProcessBackendStatus,
	type SpeculativeAgentSandbox,
} from "./workspace-sandbox.ts";

const STATUS_KEY = "speculative-action";
const SETUP_STATUS_KEY = "speculative-action-setup";
const CLOSE = "Close";
const BACK = "Back";
const USE_ACTIVE_MODEL = "Use active model";
const CUSTOM_MODEL = "Custom model...";
const RECENT_EVENT_LIMIT = 50;

type BaseToolDefinition =
	| ReturnType<typeof createReadToolDefinition>
	| ReturnType<typeof createBashToolDefinition>
	| ReturnType<typeof createEditToolDefinition>
	| ReturnType<typeof createWriteToolDefinition>
	| ReturnType<typeof createGrepToolDefinition>
	| ReturnType<typeof createFindToolDefinition>;

export interface EffectiveSpeculativeActionSettings {
	readonly enabled: boolean;
	readonly drafterEnabled: boolean;
	readonly drafterMaxDepth: number;
	readonly draftModel?: string;
	readonly candidateLimit: number;
	readonly maxConcurrentActions: number;
	readonly resourceCacheMaxEntries: number;
	readonly resourceCacheMaxBytes: number;
	readonly predictionTimeoutMs: number;
	readonly isolation: {
		readonly backend: "auto" | "container" | "native";
		readonly runtime: "auto" | "docker" | "podman";
		readonly image: string;
		readonly guestShell?: string;
	};
	readonly patternAware: PatternAwareSettings;
	readonly tools: {
		readonly resourceCached: readonly string[];
		readonly sandbox: readonly string[];
	};
}

export type SpeculativeActionMetrics = SpeculativeTraceSummary;

export type SpeculativeSandboxHealth = SandboxBackendRouterStatus;

export interface SpeculativeSettingsStore {
	readonly scope: SpeculativeSettingsScope;
	readonly load: () => Promise<void>;
	readonly effective: () => SpeculativeActionPackageSettings | undefined;
	readonly overlay: () => Readonly<Record<string, unknown>> | undefined;
	readonly setEffective: (settings: SpeculativeActionPackageSettings) => void;
	readonly clear: () => void;
	readonly setScope: (scope: SpeculativeSettingsScope) => void;
	readonly flush: () => Promise<void>;
}

interface SpeculativeActionController {
	readonly settings: () => EffectiveSpeculativeActionSettings;
	readonly sessionIsolation: () => EffectiveSpeculativeActionSettings["isolation"];
	readonly settingsScope: () => SpeculativeSettingsScope;
	readonly setSettingsScope: (scope: SpeculativeSettingsScope) => void;
	readonly health: () => SpeculativeSandboxHealth | undefined;
	readonly metrics: () => SpeculativeActionMetrics;
	readonly registeredTools: () => ReadonlySet<string>;
	readonly toolConflicts: () => ReadonlyMap<string, string>;
	readonly recentEvents: () => readonly string[];
	readonly setSettings: (settings: SpeculativeActionPackageSettings | undefined) => void;
	readonly attachUI: (ui: ExtensionUIContext) => void;
	readonly detachUI: () => void;
	readonly refreshHealth: (refresh?: boolean) => Promise<SpeculativeSandboxHealth>;
	readonly startTurn: (messages: AgentMessage[], context: ExtensionContext) => Promise<void>;
	readonly finishTurn: (terminal?: boolean) => Promise<void>;
	readonly execute: (
		tool: string,
		callID: string,
		input: unknown,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		context: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly statusText: () => string;
	readonly dispose: () => Promise<void>;
}

export interface SpeculativeActionExtensionDependencies {
	readonly createBackendRouter?: (settings: EffectiveSpeculativeActionSettings) => SandboxBackendRouter;
	readonly createSandbox?: () => SpeculativeAgentSandbox;
	readonly createHost?: typeof createSpeculativeActionHost;
	readonly createSettingsStore?: (cwd: string) => SpeculativeSettingsStore;
	readonly ociSetup?: OciSetupService;
}

export function normalizeSpeculativeActionSettings(
	input: SpeculativeActionPackageSettings | undefined,
): EffectiveSpeculativeActionSettings {
	return {
		enabled: typeof input?.enabled === "boolean" ? input.enabled : DEFAULTS.enabled,
		drafterEnabled: typeof input?.drafterEnabled === "boolean" ? input.drafterEnabled : DEFAULTS.drafterEnabled,
		drafterMaxDepth: clampDrafterDepth(input?.drafterMaxDepth),
		...(typeof input?.draftModel === "string" && input.draftModel.trim()
			? { draftModel: input.draftModel.trim() }
			: {}),
		candidateLimit: clampCandidateLimit(input?.candidateLimit ?? DEFAULTS.candidateLimit),
		maxConcurrentActions: clampCandidateLimit(input?.maxConcurrentActions ?? DEFAULTS.maxConcurrentActions),
		resourceCacheMaxEntries: positiveInteger(input?.resourceCacheMaxEntries, DEFAULTS.resourceCacheMaxEntries),
		resourceCacheMaxBytes: positiveInteger(input?.resourceCacheMaxBytes, DEFAULTS.resourceCacheMaxBytes),
		predictionTimeoutMs: positiveInteger(input?.predictionTimeoutMs, DEFAULTS.predictionTimeoutMs),
		isolation: normalizeIsolation(input?.isolation),
		patternAware: patternAwareSettings(input?.patternAware ?? PATTERN_AWARE_DEFAULTS),
		tools: {
			resourceCached: supportedTools(
				input?.tools?.resourceCached,
				DEFAULTS.tools.resourceCached,
				IDEMPOTENT_ACTION_TOOLS,
			),
			sandbox: supportedTools(input?.tools?.sandbox, DEFAULTS.tools.sandbox, SANDBOX_ACTION_TOOLS),
		},
	};
}

export function formatSpeculativeActionStatus(input: {
	readonly settings: EffectiveSpeculativeActionSettings;
	readonly metrics: SpeculativeActionMetrics;
	readonly health?: SpeculativeSandboxHealth;
}): string {
	const { settings, metrics, health } = input;
	const hitRate = Math.round(metrics.hitRate * 100);
	const activeSandbox = health ? statusSummary(health.active) : "not checked";
	const cache = metrics.cache;
	return [
		`Enabled: ${settings.enabled ? "On" : "Off"}`,
		`Drafter: ${settings.drafterEnabled ? "On" : "Off"}`,
		`Draft model: ${settings.draftModel ?? "active model"}`,
		`Drafter requests: ${settings.candidateLimit}`,
		`Concurrent actions: ${settings.maxConcurrentActions}`,
		`Resource cache: ${settings.resourceCacheMaxEntries}`,
		`Resource cache memory: ${formatBytes(settings.resourceCacheMaxBytes)}`,
		`Prediction timeout: ${formatDuration(settings.predictionTimeoutMs)}`,
		`PatternAware: ${settings.patternAware.enabled ? "On" : "Off"}; multi-step: ${settings.patternAware.multiStepEnabled ? "On" : "Off"} (beam ${settings.patternAware.beamWidth}, depth ${settings.patternAware.maxPredictionDepth}, support ${settings.patternAware.minOccurrences}, binding≥${settings.patternAware.minBindingReplayProbability}, gap ${settings.patternAware.maxFutureGap}, coverage ${formatPercent(settings.patternAware.futureGapCoverage)}, half-life ${settings.patternAware.decayHalfLifeEvents})`,
		`Resource-cached tools: ${toolsSummary(settings.tools.resourceCached)}`,
		`Sandbox-staged tools: ${toolsSummary(settings.tools.sandbox)}`,
		`Configured isolation: ${settings.isolation.backend}; runtime: ${settings.isolation.runtime}; image: ${settings.isolation.image}; shell: ${settings.isolation.guestShell ?? "image default"}`,
		`Session isolation: ${health?.configured ?? "not started"}; active: ${activeSandbox}`,
		`OCI worker: ${health ? statusSummary(health.candidates.container) : "not checked"}`,
		`Native sandbox: ${health ? statusSummary(health.candidates.native) : "not checked"}`,
		`Actor actions: ${metrics.speculativeHits}/${metrics.actorActions} speculative hits (${hitRate}%); fallbacks: ${metrics.actorFallbacks}`,
		`Predictions: ${metrics.predictionsMatched}/${metrics.predictionsObserved} matched (${formatPercent(metrics.predictionPrecision)}); ${metrics.predictionsAdopted}/${metrics.predictionsMatched} adopted (${formatPercent(metrics.adoptionYield)}); unobserved: ${metrics.predictionsSettled - metrics.predictionsObserved}`,
		`Prediction rejections after match: ${countSummary(metrics.predictionRejectedAfterMatch)}`,
		`Actor candidate rejections: ${countSummary(metrics.actorCandidateRejections)}`,
		`Candidates: ${metrics.candidateStarted} started; ${metrics.candidateSucceeded} succeeded; ${metrics.candidateFailed} failed; ${metrics.candidateCancelled} cancelled`,
		`Task timing: ${formatDuration(metrics.endToEndMs)} actual; ${formatDuration(metrics.serializedMs)} serialized; ${formatDuration(metrics.hiddenLatencyMs)} hidden; ${formatDuration(metrics.nonToolMs)} non-tool; ${formatDuration(metrics.toolExecutionMs)} tools`,
		`Execution ahead: ${formatDuration(metrics.executionAheadMs)}; hit latency: ${formatDuration(metrics.hitLatencyMs)}; attempt lead: ${formatDuration(metrics.attemptLeadMs)}; Actor execution: ${formatDuration(metrics.actorExecutionMs)}`,
		`Draft tokens: ${metrics.totalDraftTokens}`,
		`Results: ${cache.resultEntries}/${cache.cacheCapacity}, ${formatBytes(cache.resultBytes)}/${formatBytes(cache.cacheByteCapacity ?? 0)}; cold: ${cache.cacheCold}; hot: ${cache.cacheHot}; jobs: ${cache.inFlightJobs}; branches: ${cache.branchEntries} (${formatBytes(cache.branchBytes)})`,
		...(health?.active.path ? [`Sandbox path: ${health.active.path}`] : []),
	].join("\n");
}

export function createSpeculativeActionExtension(
	dependencies: SpeculativeActionExtensionDependencies = {},
): ExtensionFactory {
	return (pi) => {
		let controller: SpeculativeActionController | undefined;
		const wrapperSources = new Map<string, string>();
		const ociSetup = dependencies.ociSetup ?? createOciSetupService();

		pi.on("session_start", async (_event, ctx) => {
			await controller?.dispose();
			controller = await installController(ctx, pi, dependencies, wrapperSources);
			controller.attachUI(ctx.ui);
			if (ctx.mode === "tui" && controller?.settings().enabled) {
				void controller.refreshHealth().catch(() => undefined);
			}
		});
		pi.on("context", async (event, ctx) => {
			await controller?.startTurn(event.messages, ctx);
		});
		pi.on("turn_end", async () => {
			await controller?.finishTurn(false);
		});
		pi.on("agent_end", async () => {
			await controller?.finishTurn(true);
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			const current = controller;
			controller = undefined;
			current?.detachUI();
			await current?.dispose().catch(() => undefined);
		});

		const command = {
			description: "Configure speculative action pre-execution",
			handler: (args: string, ctx: ExtensionCommandContext) => runCommand(args, ctx, controller, ociSetup),
		};
		pi.registerCommand("speculative-action", command);
	};
}

const speculativeActionExtension = createSpeculativeActionExtension();
export default speculativeActionExtension;

async function installController(
	context: ExtensionContext,
	pi: ExtensionAPI,
	dependencies: SpeculativeActionExtensionDependencies,
	wrapperSources: Map<string, string>,
): Promise<SpeculativeActionController> {
	let currentMetrics = emptyMetrics();
	let health: SpeculativeSandboxHealth | undefined;
	let ui: ExtensionUIContext | undefined;
	let latestContext = context;
	let currentTurnID: string | undefined;
	let lastTurnID: string | undefined;
	let turnSequence = 0;
	let turnTools: readonly AgentTool[] = [];
	const recentEvents: string[] = [];
	const settingsStore =
		dependencies.createSettingsStore?.(context.cwd) ?? new SpeculativeActionSettingsStore(context.cwd);
	await settingsStore.load();
	let currentSettings = normalizeSpeculativeActionSettings(settingsStore.effective());
	const settings = () => currentSettings;
	const sessionSettings = currentSettings;
	const backendRouter =
		dependencies.createBackendRouter?.(sessionSettings) ?? createConfiguredBackendRouter(sessionSettings);
	const sandbox =
		dependencies.createSandbox?.() ??
		createWorkspaceSandbox({
			processBackend: backendRouter,
		});
	const piToolSettings = await loadPiToolSettings(context.cwd);
	const availableTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const toolConflicts = new Map<string, string>();
	// Pi exposes metadata, but not another extension's execute function. Only stock tools and our own
	// wrappers can be intercepted without silently substituting different tool semantics.
	const baseDefinitions = new Map(
		[...createBaseToolDefinitions(context.cwd, piToolSettings)].filter(([name]) => {
			const available = availableTools.get(name);
			if (!available) return false;
			const source = toolSourceFingerprint(available.sourceInfo);
			if (available.sourceInfo.source === "builtin" || wrapperSources.get(name) === source) return true;
			toolConflicts.set(name, `${available.sourceInfo.source}: ${available.sourceInfo.path}`);
			return false;
		}),
	);
	const agentTools = new Map(
		[...baseDefinitions].map(([name, definition]) => [name, toAgentTool(definition, () => latestContext)]),
	);
	function renderFooter(): void {
		if (!ui) return;
		const effective = settings();
		if (!effective.enabled) {
			ui.setStatus(STATUS_KEY, "spec: off");
			return;
		}
		const conflictText =
			toolConflicts.size > 0 ? ` · ${toolConflicts.size} tool conflict${toolConflicts.size === 1 ? "" : "s"}` : "";
		const healthText = health
			? health.active.state === "ready"
				? backendDisplayName(health.active)
				: "bash sandbox unavailable"
			: "unchecked";
		ui.setStatus(
			STATUS_KEY,
			`spec: on · ${healthText}${conflictText} · ${currentMetrics.speculativeHits}/${currentMetrics.actorActions} hits · ${formatDuration(currentMetrics.hiddenLatencyMs)} hidden (${formatDuration(currentMetrics.endToEndMs)}/${formatDuration(currentMetrics.serializedMs)}) · ${currentMetrics.cache.resultEntries}/${currentMetrics.cache.cacheCapacity} results (${formatBytes(currentMetrics.cache.resultBytes)}) · ${currentMetrics.cache.inFlightJobs} jobs · ${currentMetrics.cache.branchEntries} branches`,
		);
	}
	const host = (dependencies.createHost ?? createSpeculativeActionHost)(context.sessionManager.getSessionId(), {
		cwd: context.cwd,
		getSettings: settings,
		complete: (model, llmContext, options) => latestContext.modelRegistry.complete(model, llmContext, options),
		draftModel: (actorModel) =>
			resolveSpeculativeDraftModel(settings().draftModel, actorModel, latestContext.modelRegistry),
		getDraftOptions: async ({ draftModel, actorOptions, signal }) =>
			resolveDraftOptions({
				draftModel,
				actorOptions,
				signal,
				modelRegistry: latestContext.modelRegistry,
			}),
		preflight: ({ toolName }) =>
			latestContext.isProjectTrusted() && baseDefinitions.has(toolName) && pi.getActiveTools().includes(toolName),
		resolveInvocation: (tool, input) => resolveToolInvocation(tool, input, latestContext, piToolSettings),
		projectionRules: [PI_READ_RANGE_PROJECTION_RULE],
		sandbox,
		patternStateDirectory: getAgentDir(),
		onEvent: (event) => {
			currentMetrics = reduceSpeculativeTrace(currentMetrics, event);
			recentEvents.push(formatSpeculativeActionEvent(event));
			if (recentEvents.length > RECENT_EVENT_LIMIT) recentEvents.splice(0, recentEvents.length - RECENT_EVENT_LIMIT);
			renderFooter();
		},
	});

	const controller: SpeculativeActionController = {
		settings,
		sessionIsolation: () => sessionSettings.isolation,
		settingsScope: () => settingsStore.scope,
		setSettingsScope: (scope) => settingsStore.setScope(scope),
		health: () => health,
		metrics: () => currentMetrics,
		registeredTools: () => new Set(baseDefinitions.keys()),
		toolConflicts: () => new Map(toolConflicts),
		recentEvents: () => [...recentEvents],
		setSettings: (value) => {
			if (value) settingsStore.setEffective(value);
			else settingsStore.clear();
			currentSettings = normalizeSpeculativeActionSettings(settingsStore.effective());
			void recoverSpeculation(() => host.runtime.settingsChanged(currentSettings));
			renderFooter();
		},
		attachUI: (nextUI) => {
			ui = nextUI;
			renderFooter();
		},
		detachUI: () => {
			ui?.setStatus(STATUS_KEY, undefined);
			ui = undefined;
		},
		refreshHealth: async (refresh = false) => {
			health = await backendRouter.inspect({ refresh });
			renderFooter();
			return health;
		},
		startTurn: async (messages, nextContext) => {
			latestContext = nextContext;
			const model = nextContext.model;
			if (!model) return;
			try {
				if (currentTurnID) await host.finishTurn(currentTurnID);
				currentTurnID = `turn_${++turnSequence}`;
				turnTools = pi
					.getActiveTools()
					.map((name) => agentTools.get(name))
					.filter((tool): tool is AgentTool => tool !== undefined);
				await host.startTurn(
					{
						turnID: currentTurnID,
						actorModel: model,
						context: {
							systemPrompt: nextContext.getSystemPrompt(),
							messages: convertToLlm(messages),
							tools: [...turnTools],
						},
						actorOptions: nextContext.signal ? { signal: nextContext.signal } : undefined,
						tools: turnTools,
					},
					nextContext.signal,
				);
			} catch {
				// Speculation is optional; the actor request remains authoritative.
			}
		},
		finishTurn: async (terminal = false) => {
			const turnID = currentTurnID ?? (terminal ? lastTurnID : undefined);
			if (!turnID) return;
			if (currentTurnID) {
				currentTurnID = undefined;
				lastTurnID = turnID;
			}
			await recoverSpeculation(() => host.finishTurn(turnID, terminal));
			if (terminal) lastTurnID = undefined;
		},
		execute: async (tool, callID, input, signal, onUpdate, nextContext) => {
			latestContext = nextContext;
			const definition = baseDefinitions.get(tool);
			if (!definition) throw new Error(`Speculative wrapper has no base tool ${tool}`);
			const turnID = currentTurnID;
			if (turnID) {
				const cached = await recoverSpeculation(() =>
					host.consume({ turnID, id: callID, tool, args: input, tools: turnTools }, signal),
				);
				if (cached) return cached.result;
			}
			const startedAt = performance.now();
			try {
				const result = decorateToolResult(
					tool,
					input,
					await definition.execute(callID, input as never, signal, onUpdate as never, nextContext),
				);
				if (turnID) {
					await recoverSpeculation(() =>
						host.actual({
							turnID,
							id: callID,
							tool,
							args: input,
							tools: turnTools,
							durationMs: performance.now() - startedAt,
							output: { result, isError: false },
						}),
					);
				}
				return result;
			} catch (error) {
				if (turnID) {
					await recoverSpeculation(() =>
						host.actual({
							turnID,
							id: callID,
							tool,
							args: input,
							tools: turnTools,
							durationMs: performance.now() - startedAt,
							output: errorToolSettlement(error),
						}),
					);
				}
				throw error;
			}
		},
		statusText: () =>
			`${formatSpeculativeActionStatus({ settings: settings(), metrics: currentMetrics, health })}\nCustom tool conflicts: ${toolConflictSummary(toolConflicts)}`,
		dispose: async () => {
			ui?.setStatus(STATUS_KEY, undefined);
			ui = undefined;
			await settingsStore.flush();
			await host.dispose();
		},
	};
	for (const definition of baseDefinitions.values())
		pi.registerTool(speculativeToolDefinition(definition, controller));
	const registeredTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	for (const name of baseDefinitions.keys()) {
		const registered = registeredTools.get(name);
		if (registered) wrapperSources.set(name, toolSourceFingerprint(registered.sourceInfo));
	}
	return controller;
}

async function recoverSpeculation<T>(operation: () => Promise<T>): Promise<T | undefined> {
	try {
		return await operation();
	} catch {
		return undefined;
	}
}

function createConfiguredBackendRouter(settings: EffectiveSpeculativeActionSettings): SandboxBackendRouter {
	const container = createContainerSandboxProcessBackend({
		runtime: settings.isolation.runtime,
		image: settings.isolation.image,
		maxWorkers: settings.maxConcurrentActions,
		...(settings.isolation.guestShell ? { guestShell: settings.isolation.guestShell } : {}),
	});
	const native = createNativeSandboxProcessBackend();
	return createSandboxBackendRouter(settings.isolation.backend, [
		{ id: "container", backend: container },
		{ id: "native", backend: native },
	]);
}

interface PiToolSettings {
	readonly shellPath?: string;
	readonly shellCommandPrefix?: string;
	readonly autoResizeImages: boolean;
}

function createBaseToolDefinitions(cwd: string, settings: PiToolSettings): Map<string, BaseToolDefinition> {
	return new Map<string, BaseToolDefinition>([
		["read", createReadToolDefinition(cwd, { autoResizeImages: settings.autoResizeImages })],
		[
			"bash",
			createBashToolDefinition(cwd, {
				...(settings.shellPath ? { shellPath: settings.shellPath } : {}),
				...(settings.shellCommandPrefix ? { commandPrefix: settings.shellCommandPrefix } : {}),
			}),
		],
		["edit", createEditToolDefinition(cwd)],
		["write", createWriteToolDefinition(cwd)],
		["grep", createGrepToolDefinition(cwd)],
		["find", createFindToolDefinition(cwd)],
	]);
}

function speculativeToolDefinition(base: BaseToolDefinition, controller: SpeculativeActionController): ToolDefinition {
	return {
		name: base.name,
		label: base.label,
		description: base.description,
		parameters: base.parameters,
		...(base.promptSnippet ? { promptSnippet: base.promptSnippet } : {}),
		...(base.promptGuidelines ? { promptGuidelines: base.promptGuidelines } : {}),
		...(base.prepareArguments ? { prepareArguments: base.prepareArguments } : {}),
		...(base.constrainedSampling ? { constrainedSampling: base.constrainedSampling } : {}),
		...(base.executionMode ? { executionMode: base.executionMode } : {}),
		...(base.renderShell ? { renderShell: base.renderShell } : {}),
		...(base.renderCall ? { renderCall: base.renderCall as ToolDefinition["renderCall"] } : {}),
		...(base.renderResult ? { renderResult: base.renderResult as ToolDefinition["renderResult"] } : {}),
		async execute(callID, input, signal, onUpdate, context) {
			return controller.execute(base.name, callID, input, signal, onUpdate, context);
		},
	};
}

function toolSourceFingerprint(source: SourceInfo): string {
	return [source.path, source.source, source.scope, source.origin, source.baseDir ?? ""].join("\0");
}

function toolConflictSummary(conflicts: ReadonlyMap<string, string>): string {
	if (conflicts.size === 0) return "none";
	return [...conflicts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([tool, source]) => `${tool} (${source}); excluded from speculation`)
		.join(", ");
}

function toAgentTool(base: BaseToolDefinition, context: () => ExtensionContext): AgentTool {
	return {
		name: base.name,
		label: base.label,
		description: base.description,
		parameters: base.parameters,
		...(base.prepareArguments ? { prepareArguments: base.prepareArguments } : {}),
		...(base.executionMode ? { executionMode: base.executionMode } : {}),
		execute: async (callID, input, signal, onUpdate) =>
			decorateToolResult(
				base.name,
				input,
				await base.execute(callID, input as never, signal, onUpdate as never, context()),
			),
	};
}

function decorateToolResult(tool: string, input: unknown, result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	if (tool !== "read" || !isReadToolInput(input)) return result;
	return withPiReadCoverage(input, result as Parameters<typeof withPiReadCoverage>[1]);
}

function isReadToolInput(value: unknown): value is ReadToolInput {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as { path?: unknown }).path === "string"
	);
}

function errorToolSettlement(error: unknown): ToolSettlement {
	const message = error instanceof Error ? error.message : String(error);
	return {
		result: { content: [{ type: "text", text: message }], details: {} },
		isError: true,
	};
}

function resolveToolInvocation(
	tool: string,
	input: unknown,
	context: ExtensionContext,
	settings: PiToolSettings,
): ToolInvocation | undefined {
	if (tool !== "bash" || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.command !== "string") return undefined;
	const command = settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${record.command}` : record.command;
	const shell = getShellConfig(settings.shellPath);
	const environment = piShellEnvironment(context);
	return {
		executor: "pi.bash.local.v2",
		process: {
			command,
			cwd: context.cwd,
			environment,
			shell: shell.shell,
			shellArgs: [...shell.args],
			commandTransport: shell.commandTransport ?? "argv",
			...(typeof record.timeout === "number" ? { timeout: record.timeout } : {}),
		},
	};
}

function piShellEnvironment(context: ExtensionContext): Readonly<Record<string, string>> {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const binDirectory = path.join(getAgentDir(), "bin");
	const currentPath = environment[pathKey] ?? "";
	if (!currentPath.split(path.delimiter).includes(binDirectory)) {
		environment[pathKey] = [binDirectory, currentPath].filter(Boolean).join(path.delimiter);
	}
	delete environment.PI_SESSION_ID;
	delete environment.PI_SESSION_FILE;
	delete environment.PI_PROVIDER;
	delete environment.PI_MODEL;
	delete environment.PI_REASONING_LEVEL;
	environment.PI_SESSION_ID = context.sessionManager.getSessionId();
	const sessionFile = context.sessionManager.getSessionFile();
	if (sessionFile) environment.PI_SESSION_FILE = sessionFile;
	if (context.model) {
		environment.PI_PROVIDER = context.model.provider;
		environment.PI_MODEL = context.model.id;
	}
	if (context.thinkingLevel) environment.PI_REASONING_LEVEL = context.thinkingLevel;
	return Object.fromEntries(
		Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

async function loadPiToolSettings(cwd: string): Promise<PiToolSettings> {
	const [global, project] = await Promise.all([
		readJsonRecord(path.join(getAgentDir(), "settings.json")),
		readJsonRecord(path.join(cwd, ".pi", "settings.json")),
	]);
	const shellPath = stringSetting(project.shellPath) ?? stringSetting(global.shellPath);
	const shellCommandPrefix = stringSetting(project.shellCommandPrefix) ?? stringSetting(global.shellCommandPrefix);
	const projectImages = recordSetting(project.images);
	const globalImages = recordSetting(global.images);
	const autoResize = projectImages.autoResize ?? globalImages.autoResize;
	return {
		...(shellPath ? { shellPath: expandHome(shellPath) } : {}),
		...(shellCommandPrefix ? { shellCommandPrefix } : {}),
		autoResizeImages: typeof autoResize === "boolean" ? autoResize : true,
	};
}

async function readJsonRecord(file: string): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		return recordSetting(value);
	} catch {
		return {};
	}
}

function recordSetting(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringSetting(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandHome(value: string): string {
	if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) return value;
	const home = process.env.USERPROFILE ?? process.env.HOME;
	return home ? path.join(home, value.slice(2)) : value;
}

function backendDisplayName(status: SandboxProcessBackendStatus): string {
	if (status.backend === "container") return "OCI worker";
	if (status.backend === "native") {
		if (process.platform === "win32") return "Windows AppContainer";
		if (process.platform === "darwin") return "macOS native sandbox";
		return "Linux native sandbox";
	}
	return status.backend;
}

function statusSummary(status: SandboxProcessBackendStatus): string {
	return status.state === "ready"
		? `${backendDisplayName(status)} ready (${status.source})`
		: `unavailable (${status.source}): ${status.detail}`;
}

async function runCommand(
	args: string,
	ctx: ExtensionCommandContext,
	controller: SpeculativeActionController | undefined,
	ociSetup: OciSetupService,
): Promise<void> {
	if (!controller) {
		ctx.ui.notify("Speculative action runtime is unavailable.", "error");
		return;
	}
	const command = args.trim().toLowerCase();
	if (command === "on" || command === "off") {
		controller.setSettings({ ...controller.settings(), enabled: command === "on" });
		const health = command === "on" ? await prepareSandboxOnEnable(ctx, controller, ociSetup) : undefined;
		ctx.ui.notify(
			command === "on" && health?.active.state !== "ready"
				? `Speculative action enabled; Bash speculation is unavailable: ${health?.active.detail ?? "process sandbox not ready"}`
				: `Speculative action ${command === "on" ? "enabled" : "disabled"}.`,
			command === "on" && health?.active.state !== "ready" ? "warning" : "info",
		);
		return;
	}
	if (command === "reset") {
		controller.setSettings(undefined);
		ctx.ui.notify("Active speculative action settings reset.", "info");
		return;
	}
	if (command === "events") {
		showRecentEvents(ctx, controller);
		return;
	}
	if (command === "status" || command === "refresh" || (command === "" && ctx.mode !== "tui")) {
		await controller.refreshHealth(command === "refresh");
		ctx.ui.notify(controller.statusText(), controller.settings().enabled ? "info" : "warning");
		return;
	}
	if (command) {
		ctx.ui.notify("Usage: /speculative-action [on|off|status|events|refresh|reset]", "warning");
		return;
	}
	await openSettings(ctx, controller, ociSetup);
}

async function prepareSandboxOnEnable(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	ociSetup: OciSetupService,
	forceOciSetup = false,
): Promise<SpeculativeSandboxHealth> {
	let health = await controller.refreshHealth(true);
	const isolation = controller.sessionIsolation();
	if ((!forceOciSetup && health.active.state === "ready") || ctx.mode !== "tui") return health;
	if (!forceOciSetup && health.configured === "native") {
		ctx.ui.notify(`Native sandbox is unavailable: ${health.candidates.native.detail}`, "warning");
		return health;
	}
	const options = await ociSetup.discover(isolation.runtime);
	if (options.length === 0) {
		ctx.ui.notify(
			"No supported automatic OCI installer was found. Install Docker or Podman manually, then refresh.",
			"warning",
		);
		return health;
	}
	const labels = new Map(options.map((option) => [`${option.label} — ${option.detail}`, option]));
	const choice = await ctx.ui.select("Sandbox dependency setup", [...labels.keys(), "Skip for now"]);
	const selected = choice ? labels.get(choice) : undefined;
	if (!selected) return health;
	const confirmed = await ctx.ui.confirm(
		selected.label,
		`Pi will use the operating system package manager to prepare ${selected.runtime}, then build the bundled worker image. Administrator approval and network downloads may be required. Continue?`,
	);
	if (!confirmed) return health;
	try {
		await ociSetup.setup({
			runtime: selected.runtime,
			image: isolation.image,
			onProgress: (message) => ctx.ui.setStatus(SETUP_STATUS_KEY, `sandbox setup: ${message}`),
		});
		health = await controller.refreshHealth(true);
		ctx.ui.notify(
			health.candidates.container.state === "ready"
				? `OCI worker is ready. Active backend: ${backendDisplayName(health.active)}.`
				: `OCI setup completed, but the worker is not ready: ${health.candidates.container.detail}`,
			health.candidates.container.state === "ready" ? "info" : "warning",
		);
	} catch (error) {
		ctx.ui.notify(`Sandbox setup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		ctx.ui.setStatus(SETUP_STATUS_KEY, undefined);
	}
	return health;
}

async function openSettings(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	ociSetup: OciSetupService,
): Promise<void> {
	let applied = cloneSettings(controller.settings());
	let draft = cloneSettings(applied);
	const editor: SpeculativeActionController = {
		...controller,
		settings: () => draft,
		setSettings: (value) => {
			draft = cloneSettings(normalizeSpeculativeActionSettings(value));
		},
	};
	const reload = () => {
		applied = cloneSettings(controller.settings());
		draft = cloneSettings(applied);
	};
	while (true) {
		const dirty = !sameSettings(draft, applied);
		const choice = await ctx.ui.select("Speculative action", [
			`Enabled: ${applied.enabled ? "On" : "Off"}`,
			`Configuration scope: ${controller.settingsScope()}`,
			`Prediction sources › ${sourceSummary(draft)}`,
			`Scheduling & cache › ${draft.candidateLimit} draft requests, ${draft.maxConcurrentActions} concurrent, ${draft.resourceCacheMaxEntries} entries`,
			`Tools & sandbox › ${enabledToolCount(draft)} tools, ${activeBackendSummary(controller.health())}`,
			`Apply changes${dirty ? " (pending)" : ""}`,
			...(dirty ? ["Discard changes"] : []),
			"Status",
			"Recent events",
			"Restore defaults",
			CLOSE,
		]);
		if (!choice || choice === CLOSE) {
			if (
				!dirty ||
				(await ctx.ui.confirm("Discard changes?", "Close without applying the pending speculative-action changes?"))
			)
				return;
			continue;
		}
		if (choice.startsWith("Enabled:")) {
			const enabled = !applied.enabled;
			controller.setSettings({ ...applied, enabled });
			applied = cloneSettings(controller.settings());
			draft = { ...draft, enabled };
			if (enabled) {
				const health = await prepareSandboxOnEnable(ctx, controller, ociSetup);
				if (health.active.state !== "ready")
					ctx.ui.notify(
						`Bash speculation unavailable; other configured tools remain active: ${health.active.detail}`,
						"warning",
					);
			}
			continue;
		}
		if (choice.startsWith("Configuration scope:")) {
			const selected = await ctx.ui.select("Configuration scope", ["global", "project", BACK]);
			if (selected === "global" || selected === "project") controller.setSettingsScope(selected);
			continue;
		}
		if (choice.startsWith("Prediction sources")) {
			await openPredictionSources(ctx, editor);
			continue;
		}
		if (choice.startsWith("Scheduling & cache")) {
			await openSchedulingAndCache(ctx, editor);
			continue;
		}
		if (choice.startsWith("Tools & sandbox")) {
			await openToolsAndSandbox(ctx, editor, controller, ociSetup);
			continue;
		}
		if (choice.startsWith("Apply changes")) {
			if (!dirty) {
				ctx.ui.notify("No pending speculative-action changes.", "info");
				continue;
			}
			const isolationChanged = JSON.stringify(draft.isolation) !== JSON.stringify(applied.isolation);
			controller.setSettings(draft);
			reload();
			ctx.ui.notify(
				isolationChanged
					? "Speculative-action settings applied. Isolation backend changes take effect in the next Pi session."
					: "Speculative-action settings applied.",
				"info",
			);
			continue;
		}
		if (choice === "Discard changes") {
			draft = cloneSettings(applied);
			continue;
		}
		if (choice === "Status") {
			await controller.refreshHealth();
			ctx.ui.notify(controller.statusText(), "info");
			continue;
		}
		if (choice === "Recent events") {
			showRecentEvents(ctx, controller);
			continue;
		}
		if (choice === "Restore defaults") {
			if (
				!(await ctx.ui.confirm(
					"Restore defaults?",
					"Restore tunable settings while preserving enabled prediction sources?",
				))
			)
				continue;
			const defaults = normalizeSpeculativeActionSettings(undefined);
			controller.setSettings({
				...defaults,
				enabled: applied.enabled,
				drafterEnabled: applied.drafterEnabled,
				patternAware: { ...defaults.patternAware, enabled: applied.patternAware.enabled },
			});
			reload();
			ctx.ui.notify("Speculative-action defaults restored.", "info");
		}
	}
}

async function openPredictionSources(ctx: ExtensionContext, controller: SpeculativeActionController): Promise<void> {
	while (true) {
		const settings = controller.settings();
		const choice = await ctx.ui.select("Prediction sources", [
			`Drafter › ${settings.drafterEnabled ? "On" : "Off"}, ${settings.draftModel ?? activeModelReference(ctx)}`,
			`PatternAware › ${settings.patternAware.enabled ? "On" : "Off"}, ${settings.patternAware.multiStepEnabled ? "multi-step" : "single-step"}`,
			BACK,
		]);
		if (!choice || choice === BACK) return;
		if (choice.startsWith("Drafter")) await openDrafterSettings(ctx, controller);
		if (choice.startsWith("PatternAware")) await openPatternAwareSettings(ctx, controller);
	}
}

async function openDrafterSettings(ctx: ExtensionContext, controller: SpeculativeActionController): Promise<void> {
	while (true) {
		const settings = controller.settings();
		const choice = await ctx.ui.select("Drafter", [
			`Enabled: ${settings.drafterEnabled ? "On" : "Off"}`,
			`Model › ${settings.draftModel ?? activeModelReference(ctx)}`,
			`Rollout depth: ${settings.drafterMaxDepth}`,
			`Prediction timeout: ${formatDuration(settings.predictionTimeoutMs)}`,
			BACK,
		]);
		if (!choice || choice === BACK) return;
		if (choice.startsWith("Enabled:"))
			controller.setSettings({ ...settings, drafterEnabled: !settings.drafterEnabled });
		if (choice.startsWith("Model")) await editDraftModel(ctx, controller, settings);
		if (choice.startsWith("Rollout depth:")) {
			await editDrafterDepth(ctx, controller, settings);
		}
		if (choice.startsWith("Prediction timeout:")) {
			await editPositiveInteger(ctx, controller, settings, "predictionTimeoutMs", "Prediction timeout (ms)");
		}
	}
}

async function openPatternAwareSettings(ctx: ExtensionContext, controller: SpeculativeActionController): Promise<void> {
	while (true) {
		const settings = controller.settings();
		const choice = await ctx.ui.select("PatternAware", [
			`Enabled: ${settings.patternAware.enabled ? "On" : "Off"}`,
			`Learning › context ${settings.patternAware.maxContextLength}, support ${settings.patternAware.minOccurrences}`,
			`Multi-step prediction › ${settings.patternAware.multiStepEnabled ? "On" : "Off"}, beam ${settings.patternAware.beamWidth}, depth ${settings.patternAware.maxPredictionDepth}`,
			BACK,
		]);
		if (!choice || choice === BACK) return;
		if (choice.startsWith("Enabled:")) {
			controller.setSettings({
				...settings,
				patternAware: { ...settings.patternAware, enabled: !settings.patternAware.enabled },
			});
		}
		if (choice.startsWith("Learning")) await openPatternLearning(ctx, controller);
		if (choice.startsWith("Multi-step prediction")) await openPatternMultiStep(ctx, controller);
	}
}

async function openPatternLearning(ctx: ExtensionContext, controller: SpeculativeActionController): Promise<void> {
	while (true) {
		const settings = controller.settings();
		const pattern = settings.patternAware;
		const choice = await ctx.ui.select("PatternAware learning", [
			`Context events: ${pattern.maxContextLength}`,
			`Future gap: ${pattern.maxFutureGap}`,
			`Future gap coverage: ${formatPercent(pattern.futureGapCoverage)}`,
			`Decay half-life: ${pattern.decayHalfLifeEvents} events`,
			`Minimum occurrences: ${pattern.minOccurrences}`,
			`Pattern capacity: ${pattern.maxPatterns}`,
			BACK,
		]);
		if (!choice || choice === BACK) return;
		if (choice.startsWith("Context events:")) {
			await editPatternInteger(ctx, controller, settings, "maxContextLength", "Pattern context events", false);
		}
		if (choice.startsWith("Future gap:")) {
			await editPatternInteger(ctx, controller, settings, "maxFutureGap", "Pattern future gap", true);
		}
		if (choice.startsWith("Future gap coverage:")) await editFutureGapCoverage(ctx, controller, settings);
		if (choice.startsWith("Decay half-life:")) await editPatternHalfLife(ctx, controller, settings);
		if (choice.startsWith("Minimum occurrences:")) {
			await editPatternInteger(ctx, controller, settings, "minOccurrences", "Minimum occurrences", false);
		}
		if (choice.startsWith("Pattern capacity:")) {
			await editPatternInteger(ctx, controller, settings, "maxPatterns", "Pattern capacity", false);
		}
	}
}

async function openPatternMultiStep(ctx: ExtensionContext, controller: SpeculativeActionController): Promise<void> {
	while (true) {
		const settings = controller.settings();
		const pattern = settings.patternAware;
		const choice = await ctx.ui.select("PatternAware multi-step", [
			`Enabled: ${pattern.multiStepEnabled ? "On" : "Off"}`,
			`Beam width: ${pattern.beamWidth}`,
			`Prediction depth: ${pattern.maxPredictionDepth}`,
			`Minimum binding replay: ${formatPercent(pattern.minBindingReplayProbability)}`,
			BACK,
		]);
		if (!choice || choice === BACK) return;
		if (choice.startsWith("Enabled:")) {
			controller.setSettings({
				...settings,
				patternAware: { ...pattern, multiStepEnabled: !pattern.multiStepEnabled },
			});
		}
		if (choice.startsWith("Beam width:")) {
			await editPatternInteger(ctx, controller, settings, "beamWidth", "Pattern beam width", false);
		}
		if (choice.startsWith("Prediction depth:")) {
			await editPatternInteger(ctx, controller, settings, "maxPredictionDepth", "Pattern prediction depth", false);
		}
		if (choice.startsWith("Minimum binding replay:")) {
			await editPatternProbability(
				ctx,
				controller,
				settings,
				"minBindingReplayProbability",
				"Minimum binding replay probability",
			);
		}
	}
}

async function openSchedulingAndCache(ctx: ExtensionContext, controller: SpeculativeActionController): Promise<void> {
	while (true) {
		const settings = controller.settings();
		const choice = await ctx.ui.select("Scheduling & cache", [
			`Drafter requests: ${settings.candidateLimit}`,
			`Concurrent actions: ${settings.maxConcurrentActions}`,
			`Resource cache entries: ${settings.resourceCacheMaxEntries}`,
			`Resource cache memory: ${formatBytes(settings.resourceCacheMaxBytes)}`,
			BACK,
		]);
		if (!choice || choice === BACK) return;
		if (choice.startsWith("Drafter requests:")) {
			await editPositiveInteger(ctx, controller, settings, "candidateLimit", "Drafter requests per turn (1-8)");
		}
		if (choice.startsWith("Concurrent actions:")) {
			await editPositiveInteger(ctx, controller, settings, "maxConcurrentActions", "Concurrent actions (1-8)");
		}
		if (choice.startsWith("Resource cache entries:")) {
			await editPositiveInteger(ctx, controller, settings, "resourceCacheMaxEntries", "Resource cache entries");
		}
		if (choice.startsWith("Resource cache memory:")) await editCacheBytes(ctx, controller, settings);
	}
}

async function openToolsAndSandbox(
	ctx: ExtensionContext,
	editor: SpeculativeActionController,
	controller: SpeculativeActionController,
	ociSetup: OciSetupService,
): Promise<void> {
	while (true) {
		const settings = editor.settings();
		const choice = await ctx.ui.select("Tools & sandbox", [
			`Tool policy › ${enabledToolCount(settings)} enabled`,
			`Isolation › ${settings.isolation.backend}, ${settings.isolation.runtime}`,
			`Active backend: ${activeBackendSummary(controller.health())}`,
			`OCI worker: ${componentHealthSummary(controller.health()?.candidates.container)}`,
			`Native sandbox: ${componentHealthSummary(controller.health()?.candidates.native)}`,
			"Install or repair OCI dependencies",
			"Isolation guarantees",
			BACK,
		]);
		if (!choice || choice === BACK) return;
		if (choice.startsWith("Tool policy"))
			await editToolPolicy(ctx, editor, controller.registeredTools(), controller.toolConflicts());
		if (choice.startsWith("Isolation ›")) await openIsolationSettings(ctx, editor);
		if (
			choice.startsWith("Active backend:") ||
			choice.startsWith("OCI worker:") ||
			choice.startsWith("Native sandbox:")
		) {
			const health = await controller.refreshHealth(true);
			ctx.ui.notify(
				[
					`Configured: ${health.configured}`,
					`Active: ${statusSummary(health.active)}`,
					`OCI worker: ${statusSummary(health.candidates.container)}`,
					`Native sandbox: ${statusSummary(health.candidates.native)}`,
				].join("\n"),
				health.active.state === "ready" ? "info" : "warning",
			);
		}
		if (choice === "Install or repair OCI dependencies") {
			if (JSON.stringify(settings.isolation) !== JSON.stringify(controller.settings().isolation)) {
				ctx.ui.notify("Apply the pending isolation settings before preparing their dependencies.", "warning");
				continue;
			}
			const before = controller.health()?.candidates.container;
			const health = await prepareSandboxOnEnable(ctx, controller, ociSetup, true);
			if (health.candidates.container.state === "ready" && before?.state === "ready")
				ctx.ui.notify(`OCI worker ready: ${health.candidates.container.detail}`, "info");
		}
		if (choice === "Isolation guarantees") {
			ctx.ui.notify(
				"Speculative file edits run in private Git worktrees. Bash additionally runs in the selected process boundary: an OCI worker, or the native OS sandbox. Git for Windows requires OCI because MSYS cannot initialize in AppContainer. Only conflict-checked file changes are committed; failed candidates are discarded and the actor executes normally.",
				"info",
			);
		}
	}
}

async function openIsolationSettings(ctx: ExtensionContext, controller: SpeculativeActionController): Promise<void> {
	while (true) {
		const settings = controller.settings();
		const choice = await ctx.ui.select("Isolation", [
			`Backend: ${settings.isolation.backend}`,
			`OCI runtime: ${settings.isolation.runtime}`,
			`Worker image: ${settings.isolation.image}`,
			`Worker shell: ${settings.isolation.guestShell ?? "image default"}`,
			BACK,
		]);
		if (!choice || choice === BACK) return;
		if (choice.startsWith("Backend:")) {
			await editIsolationChoice(ctx, controller, settings, "backend", ["auto", "container", "native"]);
		}
		if (choice.startsWith("OCI runtime:")) {
			await editIsolationChoice(ctx, controller, settings, "runtime", ["auto", "docker", "podman"]);
		}
		if (choice.startsWith("Worker image:")) {
			await editIsolationText(ctx, controller, settings, "image", "OCI worker image", false);
		}
		if (choice.startsWith("Worker shell:")) {
			await editIsolationText(ctx, controller, settings, "guestShell", "Worker shell (blank = image default)", true);
		}
	}
}

async function editToolPolicy(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	registered: ReadonlySet<string>,
	conflicts: ReadonlyMap<string, string>,
): Promise<void> {
	while (true) {
		const settings = controller.settings();
		const tools = [
			...new Set([...KEYABLE_TOOLS, ...settings.tools.resourceCached, ...settings.tools.sandbox, ...registered]),
		].sort((left, right) => toolCategory(left) - toolCategory(right) || left.localeCompare(right));
		const labels = new Map<string, string>();
		for (const tool of tools) {
			const group = toolGroup(tool);
			const selected = group ? settings.tools[group].includes(tool) : false;
			const availability = conflicts.has(tool) ? " · custom override" : registered.has(tool) ? "" : " · unavailable";
			labels.set(
				`${selected ? "[x]" : "[ ]"} ${tool} · ${group === "resourceCached" ? "cached" : group === "sandbox" ? "sandbox" : "unsupported"}${availability}`,
				tool,
			);
		}
		const choice = await ctx.ui.select("Tool policy", [...labels.keys(), BACK]);
		if (!choice || choice === BACK) return;
		const tool = labels.get(choice);
		if (!tool) continue;
		const group = toolGroup(tool);
		if (!group) {
			ctx.ui.notify(`${tool} has no speculative action semantics.`, "warning");
			continue;
		}
		const selected = settings.tools[group].includes(tool);
		if (!selected && !registered.has(tool)) {
			const conflict = conflicts.get(tool);
			ctx.ui.notify(
				conflict
					? `${tool} is provided by ${conflict}. Custom tool overrides remain authoritative and are excluded from speculation.`
					: `${tool} is not registered in the current Pi session.`,
				"warning",
			);
			continue;
		}
		const next = selected ? settings.tools[group].filter((item) => item !== tool) : [...settings.tools[group], tool];
		controller.setSettings({ ...settings, tools: { ...settings.tools, [group]: next } });
	}
}

async function editIsolationChoice(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
	field: "backend" | "runtime",
	values: readonly string[],
): Promise<void> {
	const choice = await ctx.ui.select(field === "backend" ? "Isolation backend" : "Worker runtime", [...values, BACK]);
	if (!choice || choice === BACK || !values.includes(choice)) return;
	const isolation =
		field === "backend"
			? { ...settings.isolation, backend: choice as EffectiveSpeculativeActionSettings["isolation"]["backend"] }
			: { ...settings.isolation, runtime: choice as EffectiveSpeculativeActionSettings["isolation"]["runtime"] };
	controller.setSettings({ ...settings, isolation });
}

async function editIsolationText(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
	field: "image" | "guestShell",
	title: string,
	allowEmpty: boolean,
): Promise<void> {
	const value = await ctx.ui.input(title, settings.isolation[field] ?? "");
	if (value === undefined) return;
	const normalized = value.trim();
	if (!normalized && !allowEmpty) {
		ctx.ui.notify(`${title} must not be empty.`, "warning");
		return;
	}
	let isolation: EffectiveSpeculativeActionSettings["isolation"];
	if (field === "image") {
		isolation = { ...settings.isolation, image: normalized };
	} else {
		const { guestShell: _previous, ...base } = settings.isolation;
		isolation = normalized ? { ...base, guestShell: normalized } : base;
	}
	controller.setSettings({ ...settings, isolation });
}

async function editPositiveInteger(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
	field: "candidateLimit" | "maxConcurrentActions" | "resourceCacheMaxEntries" | "predictionTimeoutMs",
	title: string,
): Promise<void> {
	const value = await ctx.ui.input(title, String(settings[field]));
	if (value === undefined) return;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) {
		ctx.ui.notify(`${title} must be a positive integer.`, "warning");
		return;
	}
	controller.setSettings({
		...settings,
		[field]: field === "candidateLimit" || field === "maxConcurrentActions" ? clampCandidateLimit(parsed) : parsed,
	});
}

async function editDrafterDepth(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
): Promise<void> {
	const title = "Drafter rollout depth (0-4)";
	const value = await ctx.ui.input(title, String(settings.drafterMaxDepth));
	if (value === undefined) return;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
		ctx.ui.notify(`${title} must be an integer from 0 through 4.`, "warning");
		return;
	}
	controller.setSettings({ ...settings, drafterMaxDepth: parsed });
}

async function editDraftModel(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
): Promise<void> {
	const models = ctx.modelRegistry
		.getAvailable()
		.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
		.sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
	const providers = new Map<string, typeof models>();
	for (const model of models) providers.set(model.provider, [...(providers.get(model.provider) ?? []), model]);
	const providerLabels = new Map(
		[...providers].map(([provider, providerModels]) => [`${provider} (${providerModels.length} models) ›`, provider]),
	);
	const active = `${USE_ACTIVE_MODEL} (${activeModelReference(ctx)})`;
	const choice = await ctx.ui.select("Drafter model", [active, ...providerLabels.keys(), CUSTOM_MODEL, BACK]);
	if (!choice || choice === BACK) return;
	const { draftModel: _previousDraftModel, ...baseSettings } = settings;
	if (choice === active) {
		controller.setSettings(baseSettings);
		return;
	}
	if (choice === CUSTOM_MODEL) {
		const value = await ctx.ui.input("Custom drafter model", "provider/model");
		if (value === undefined) return;
		const draftModel = value.trim();
		controller.setSettings({ ...baseSettings, ...(draftModel ? { draftModel } : {}) });
		return;
	}
	const provider = providerLabels.get(choice);
	if (!provider) return;
	const labels = new Map(
		(providers.get(provider) ?? []).map((model) => {
			const reference = `${model.provider}/${model.id}`;
			return [
				`${settings.draftModel === reference ? "[x] " : ""}${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`,
				reference,
			];
		}),
	);
	const selected = await ctx.ui.select(`${provider} models`, [...labels.keys(), BACK]);
	if (!selected || selected === BACK) return;
	const draftModel = labels.get(selected);
	if (draftModel) controller.setSettings({ ...baseSettings, draftModel });
}

async function editCacheBytes(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
): Promise<void> {
	const value = await ctx.ui.input(
		"Resource cache memory (MiB)",
		String(Math.max(1, Math.round(settings.resourceCacheMaxBytes / (1024 * 1024)))),
	);
	if (value === undefined) return;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) {
		ctx.ui.notify("Resource cache memory must be a positive integer in MiB.", "warning");
		return;
	}
	controller.setSettings({ ...settings, resourceCacheMaxBytes: parsed * 1024 * 1024 });
}

async function editFutureGapCoverage(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
): Promise<void> {
	const value = await ctx.ui.input("Future gap coverage (0-1)", String(settings.patternAware.futureGapCoverage));
	if (value === undefined) return;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		ctx.ui.notify("Future gap coverage must be between 0 and 1.", "warning");
		return;
	}
	controller.setSettings({
		...settings,
		patternAware: { ...settings.patternAware, futureGapCoverage: parsed },
	});
}

async function editPatternHalfLife(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
): Promise<void> {
	const value = await ctx.ui.input("Pattern half-life (events)", String(settings.patternAware.decayHalfLifeEvents));
	if (value === undefined) return;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) {
		ctx.ui.notify("Pattern half-life must be a positive integer.", "warning");
		return;
	}
	controller.setSettings({
		...settings,
		patternAware: { ...settings.patternAware, decayHalfLifeEvents: parsed },
	});
}

async function editPatternInteger(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
	field: "maxContextLength" | "beamWidth" | "maxPredictionDepth" | "maxFutureGap" | "minOccurrences" | "maxPatterns",
	title: string,
	allowZero: boolean,
): Promise<void> {
	const value = await ctx.ui.input(title, String(settings.patternAware[field]));
	if (value === undefined) return;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
		ctx.ui.notify(`${title} must be ${allowZero ? "a non-negative" : "a positive"} integer.`, "warning");
		return;
	}
	controller.setSettings({
		...settings,
		patternAware: { ...settings.patternAware, [field]: parsed },
	});
}

async function editPatternProbability(
	ctx: ExtensionContext,
	controller: SpeculativeActionController,
	settings: EffectiveSpeculativeActionSettings,
	field: "minBindingReplayProbability",
	title: string,
): Promise<void> {
	const value = await ctx.ui.input(`${title} (0-1)`, String(settings.patternAware[field]));
	if (value === undefined) return;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		ctx.ui.notify(`${title} must be between 0 and 1.`, "warning");
		return;
	}
	controller.setSettings({
		...settings,
		patternAware: { ...settings.patternAware, [field]: parsed },
	});
}

function showRecentEvents(ctx: ExtensionContext, controller: SpeculativeActionController): void {
	const events = controller.recentEvents();
	ctx.ui.notify(events.length > 0 ? events.join("\n") : "No speculative action events recorded yet.", "info");
}

export function formatSpeculativeActionEvent(event: SpeculativeActionEvent<string>): string {
	const parts = [`[${event.type}]`];
	switch (event.type) {
		case "task":
			parts.push(
				`${formatDuration(event.timing.endToEndMs)} actual`,
				`${formatDuration(event.timing.serializedMs)} serialized`,
				`${formatDuration(event.timing.hiddenLatencyMs)} hidden`,
			);
			break;
		case "source_request":
			parts.push(
				event.request.request.source,
				event.request.settlement.status,
				formatDuration(event.request.durationMs),
			);
			break;
		case "prediction": {
			const settlement = event.settlement;
			parts.push(settlement.prediction.source, settlement.prediction.actionID);
			if (settlement.observation === "unobserved") parts.push(`unobserved ${causeSummary(settlement.cause)}`);
			else if (!settlement.match.matched) parts.push("not matched");
			else if (settlement.match.adoption.status === "adopted") parts.push("matched and adopted");
			else parts.push(`matched, rejected ${causeSummary(settlement.match.adoption.cause)}`);
			break;
		}
		case "candidate":
			parts.push(event.candidate.tool, event.candidate.source, event.state.status);
			if (event.state.status === "running") {
				parts.push(`predicted ${compactEventText(event.candidate.predictedAction)}`);
			} else if (event.state.status === "succeeded") {
				parts.push(formatDuration(event.state.executionMs));
			} else {
				parts.push(causeSummary(event.state.cause), formatDuration(event.state.executionMs));
			}
			break;
		case "actor_action": {
			const sources = [...new Set(event.settlement.matchedPredictions.map((prediction) => prediction.source))];
			parts.push(
				event.settlement.tool,
				sources.join("+") || (event.settlement.provider.kind === "speculative" ? "cache" : "no prediction"),
			);
			if (event.settlement.provider.kind === "speculative") {
				parts.push(
					`${formatDuration(event.settlement.provider.timing.executionAheadMs)} ahead`,
					`${formatDuration(event.settlement.provider.timing.hitLatencyMs)} hit latency`,
					`${formatDuration(event.settlement.provider.timing.attemptLeadMs)} attempt lead`,
				);
			} else {
				parts.push(`${formatDuration(event.settlement.provider.durationMs)} Actor execution`);
			}
			parts.push(compactEventText(event.actualAction));
			break;
		}
	}
	return parts.join(" · ");
}

function causeSummary(value: { readonly stage: string; readonly code: string; readonly detail?: string }): string {
	return `${value.stage}:${value.code}${value.detail ? ` (${compactEventText(value.detail)})` : ""}`;
}

function compactEventText(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

export function resolveSpeculativeDraftModel(
	reference: string | undefined,
	actorModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Model<Api> {
	if (!reference) return actorModel;
	const model = findExactModelReferenceMatch(reference, modelRegistry.getAll());
	return model && modelRegistry.hasConfiguredAuth(model) ? model : actorModel;
}

function findExactModelReferenceMatch(reference: string, models: readonly Model<Api>[]): Model<Api> | undefined {
	const normalized = reference.trim().toLowerCase();
	if (!normalized) return undefined;
	const canonical = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === normalized);
	if (canonical.length === 1) return canonical[0];
	if (canonical.length > 1 || normalized.includes("/")) return undefined;
	const byID = models.filter((model) => model.id.toLowerCase() === normalized);
	return byID.length === 1 ? byID[0] : undefined;
}

async function resolveDraftOptions(input: {
	readonly draftModel: Model<Api>;
	readonly actorOptions: SimpleStreamOptions | undefined;
	readonly signal: AbortSignal;
	readonly modelRegistry: ModelRegistry;
}): Promise<SimpleStreamOptions> {
	const base: SimpleStreamOptions = {
		...input.actorOptions,
		signal: input.signal,
	};
	const auth = await input.modelRegistry.getApiKeyAndHeaders(input.draftModel);
	if (!auth.ok) throw new Error(auth.error);
	return { ...base, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}

function emptyMetrics(): SpeculativeActionMetrics {
	return emptySpeculativeTraceSummary({
		cacheCapacity: DEFAULTS.resourceCacheMaxEntries,
		cacheByteCapacity: DEFAULTS.resourceCacheMaxBytes,
		cacheCold: 0,
		cacheHot: 0,
		inFlightJobs: 0,
		resultEntries: 0,
		resultBytes: 0,
		branchEntries: 0,
		branchBytes: 0,
		exclusiveCandidates: 0,
		sharedCandidates: 0,
		cacheTools: [],
		cacheExecutions: [],
	});
}

function supportedTools(value: unknown, fallback: readonly string[], allowed: readonly string[]): readonly string[] {
	if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) return fallback;
	const supported = new Set(allowed);
	return [...new Set(value.filter((item) => supported.has(item)))];
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeIsolation(
	input: SpeculativeActionPackageSettings["isolation"],
): EffectiveSpeculativeActionSettings["isolation"] {
	const guestShell = nonEmpty(input?.guestShell);
	return {
		backend: input?.backend === "container" || input?.backend === "native" ? input.backend : "auto",
		runtime: input?.runtime === "docker" || input?.runtime === "podman" ? input.runtime : "auto",
		image: nonEmpty(input?.image) ?? DEFAULT_CONTAINER_SANDBOX_IMAGE,
		...(guestShell ? { guestShell } : {}),
	};
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cloneSettings(settings: EffectiveSpeculativeActionSettings): EffectiveSpeculativeActionSettings {
	return {
		...settings,
		isolation: { ...settings.isolation },
		patternAware: { ...settings.patternAware },
		tools: { resourceCached: [...settings.tools.resourceCached], sandbox: [...settings.tools.sandbox] },
	};
}

function sameSettings(left: EffectiveSpeculativeActionSettings, right: EffectiveSpeculativeActionSettings): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sourceSummary(settings: EffectiveSpeculativeActionSettings): string {
	if (!settings.enabled) return "Inactive";
	const sources = [
		settings.drafterEnabled ? "Drafter" : undefined,
		settings.patternAware.enabled ? "PatternAware" : undefined,
	]
		.filter((source): source is string => source !== undefined)
		.join(" + ");
	return sources || "No source enabled";
}

function activeModelReference(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "active model";
}

function enabledToolCount(settings: EffectiveSpeculativeActionSettings): number {
	return new Set([...settings.tools.resourceCached, ...settings.tools.sandbox]).size;
}

function activeBackendSummary(health: SpeculativeSandboxHealth | undefined): string {
	if (!health) return "not checked";
	return health.active.state === "ready" ? `${backendDisplayName(health.active)} ready` : "unavailable";
}

function componentHealthSummary(status: SandboxProcessBackendStatus | undefined): string {
	if (!status) return "not checked";
	return status.state === "ready" ? "ready" : "unavailable";
}

function toolGroup(tool: string): "resourceCached" | "sandbox" | undefined {
	if ((IDEMPOTENT_ACTION_TOOLS as readonly string[]).includes(tool)) return "resourceCached";
	if ((SANDBOX_ACTION_TOOLS as readonly string[]).includes(tool)) return "sandbox";
	return undefined;
}

function toolCategory(tool: string): number {
	const group = toolGroup(tool);
	return group === "resourceCached" ? 0 : group === "sandbox" ? 1 : 2;
}

function toolsSummary(tools: readonly string[]): string {
	return tools.length > 0 ? tools.join(" ") : "none";
}

function countSummary(counts: Readonly<Record<string, number>>): string {
	const entries = Object.entries(counts).sort(([leftKey, left], [rightKey, right]) =>
		right === left ? leftKey.localeCompare(rightKey) : right - left,
	);
	return entries.length > 0 ? entries.map(([key, count]) => `${key}=${count}`).join(", ") : "none";
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MiB`;
}

function formatPercent(value: number): string {
	return `${Math.round(value * 100)}%`;
}
