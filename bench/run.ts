import { execFile } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, type Message, type Model } from "@earendil-works/pi-ai";
import { getModels, getProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { createSpeculativeActionHost, type SpeculativeAgentSettingsInput } from "../src/agent-integration.ts";
import { createContainerSandboxProcessBackend } from "../src/container-sandbox.ts";
import { createNativeSandboxProcessBackend } from "../src/native-sandbox.ts";
import { resolvePiToolInvocation } from "../src/pi-tool-invocation.ts";
import { PI_READ_RANGE_PROJECTION_RULE, withPiProjectionCoverage } from "../src/pi-read-projection.ts";
import type { SpeculativeActionEvent } from "../src/runtime.ts";
import type { ToolInvocation } from "../src/tool-settlement.ts";
import { summarizeSpeculativeTrace } from "../src/trace-summary.ts";
import {
	createSandboxBackendRouter,
	createWorkspaceSandbox,
	type SandboxProcessBackend,
} from "../src/workspace-sandbox.ts";

const DATASET_ROWS =
	"https://datasets-server.huggingface.co/rows?dataset=TokenRhythm%2FClaw-SWE-Bench&config=lite&split=test&offset=0&length=100";

const latencyProfiles = {
	native: { read: 0, grep: 0, find: 0, ls: 0, bash: 0, edit: 0, write: 0 },
	remote: { read: 120, grep: 180, find: 140, ls: 80, bash: 0, edit: 120, write: 120 },
	sandbox: { read: 250, grep: 350, find: 300, ls: 150, bash: 600, edit: 350, write: 350 },
	heavy: { read: 800, grep: 1_000, find: 900, ls: 500, bash: 1_500, edit: 1_000, write: 1_000 },
} as const;

type LatencyProfile = keyof typeof latencyProfiles;

interface DatasetRow {
	readonly instance_id: string;
	readonly repo: string;
	readonly base_commit: string;
	readonly patch: string;
	readonly test_patch: string;
	readonly problem_statement: string;
	readonly language: string;
	readonly source_dataset: string;
	readonly FAIL_TO_PASS: readonly string[];
	readonly PASS_TO_PASS: readonly string[];
}

interface PreparedTask {
	readonly row: DatasetRow;
	readonly runDirectory: string;
	readonly workspace: string;
}

interface ToolCounters {
	readonly executions: Record<string, number>;
	readonly serviceMs: Record<string, number>;
}

interface BenchmarkOptions {
	readonly instance: string;
	readonly label: string;
	readonly actor: Model<Api>;
	readonly drafter: Model<Api>;
	readonly candidateLimit: number;
	readonly drafterMaxDepth: number;
	readonly maxConcurrentActions: number;
	readonly maxTurns: number;
	readonly timeoutMs: number;
	readonly latency: LatencyProfile;
	readonly repoCache: string;
	readonly runRoot: string;
	readonly output?: string;
	readonly patternState?: string;
	readonly drafterEnabled: boolean;
	readonly patternAware: boolean;
	readonly prepareOnly: boolean;
}

interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
}

const { values } = parseArgs({
	options: {
		instance: { type: "string" },
		label: { type: "string", default: "baseline" },
		actor: { type: "string", default: "deepseek/deepseek-v4-pro" },
		drafter: { type: "string", default: "deepseek/deepseek-v4-flash" },
		"candidate-limit": { type: "string", default: "8" },
		"drafter-max-depth": { type: "string", default: "0" },
		"max-concurrent-actions": { type: "string", default: "8" },
		"max-turns": { type: "string", default: "64" },
		"timeout-ms": { type: "string", default: "900000" },
		latency: { type: "string", default: "remote" },
		"repo-cache": { type: "string" },
		"run-root": { type: "string" },
		output: { type: "string" },
		"pattern-state": { type: "string" },
		"drafter-disabled": { type: "boolean", default: false },
		"pattern-aware": { type: "boolean", default: false },
		"prepare-only": { type: "boolean", default: false },
	},
	strict: true,
});

const instance = required(values.instance, "--instance");
const latency = latencyProfile(values.latency);
const repoCache = path.resolve(values["repo-cache"] ?? path.join(os.tmpdir(), "pi-speculative-ablation-cache"));
const runRoot = path.resolve(values["run-root"] ?? path.join(os.tmpdir(), "pi-speculative-ablation-runs"));
const options: BenchmarkOptions = {
	instance,
	label: values.label ?? "baseline",
	actor: model(values.actor ?? "deepseek/deepseek-v4-pro"),
	drafter: model(values.drafter ?? "deepseek/deepseek-v4-flash"),
	candidateLimit: positiveInteger(values["candidate-limit"], "--candidate-limit"),
	drafterMaxDepth: nonNegativeInteger(values["drafter-max-depth"], "--drafter-max-depth", 4),
	maxConcurrentActions: positiveInteger(values["max-concurrent-actions"], "--max-concurrent-actions"),
	maxTurns: positiveInteger(values["max-turns"], "--max-turns"),
	timeoutMs: positiveInteger(values["timeout-ms"], "--timeout-ms"),
	latency,
	repoCache,
	runRoot,
	...(values.output ? { output: path.resolve(values.output) } : {}),
	...(values["pattern-state"] ? { patternState: path.resolve(values["pattern-state"]) } : {}),
	drafterEnabled: !(values["drafter-disabled"] ?? false),
	patternAware: values["pattern-aware"] ?? false,
	prepareOnly: values["prepare-only"] ?? false,
};

const prepared = await prepareTask(options);
if (options.prepareOnly) {
	process.stdout.write(
		`${JSON.stringify({ instance: prepared.row.instance_id, repo: prepared.row.repo, workspace: prepared.workspace }, null, 2)}\n`,
	);
} else {
	if (!process.env.DEEPSEEK_API_KEY && (options.actor.provider === "deepseek" || options.drafter.provider === "deepseek")) {
		throw new Error("DEEPSEEK_API_KEY is required for DeepSeek benchmark models");
	}
	const result = await runTask(prepared, options);
	const output = options.output ?? path.join(prepared.runDirectory, "result.json");
	await mkdir(path.dirname(output), { recursive: true });
	await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	process.stdout.write(`${JSON.stringify({ output, ...result.summary }, null, 2)}\n`);
}

async function prepareTask(input: BenchmarkOptions): Promise<PreparedTask> {
	const row = await datasetRow(input.instance);
	await Promise.all([mkdir(input.repoCache, { recursive: true }), mkdir(input.runRoot, { recursive: true })]);
	const cache = path.join(input.repoCache, `${safeName(row.repo)}.git`);
	if (!(await exists(cache))) {
		await command("git", ["init", "--bare", cache]);
		await command("git", ["-C", cache, "remote", "add", "origin", `https://github.com/${row.repo}.git`]);
		await command("git", ["-C", cache, "config", "core.longpaths", "true"]);
	}
	const benchmarkRef = `refs/bench/${safeName(row.instance_id)}`;
	await command("git", [
		"-C",
		cache,
		"fetch",
		"--force",
		"--depth=1",
		"origin",
		`+${row.base_commit}:${benchmarkRef}`,
	]);
	const runDirectory = await mkdtemp(path.join(input.runRoot, `${safeName(row.instance_id)}-`));
	const workspace = path.join(runDirectory, "workspace");
	await command("git", ["clone", "--no-checkout", cache, workspace]);
	await command("git", ["-C", workspace, "config", "core.longpaths", "true"]);
	await command("git", ["-C", workspace, "fetch", "--depth=1", "origin", benchmarkRef]);
	await command("git", ["-C", workspace, "checkout", "--detach", row.base_commit]);
	return { row, runDirectory, workspace };
}

async function runTask(task: PreparedTask, input: BenchmarkOptions) {
	const implementationCommit = (await command("git", ["rev-parse", "HEAD"], process.cwd())).stdout.trim();
	const events: SpeculativeActionEvent<string>[] = [];
	const counters: ToolCounters = { executions: {}, serviceMs: {} };
	const profile = latencyProfiles[input.latency];
	const shellEnvironment = benchmarkShellEnvironment();
	const tools = [
		createReadTool(task.workspace),
		createGrepTool(task.workspace),
		createFindTool(task.workspace),
		createLsTool(task.workspace),
		createBashTool(task.workspace, {
			exposeSessionEnvironment: false,
			spawnHook: (context) => ({ ...context, env: shellEnvironment }),
		}),
		createEditTool(task.workspace),
		createWriteTool(task.workspace),
	].map((tool) => instrumentTool(tool, profile[tool.name as keyof typeof profile] ?? 0, counters));
	const backendRouter = createSandboxBackendRouter("auto", [
		{
			id: "container",
			backend: createContainerSandboxProcessBackend({ maxWorkers: input.maxConcurrentActions }),
		},
		{ id: "native", backend: createNativeSandboxProcessBackend() },
	]);
	const sandbox = createWorkspaceSandbox({
		processBackend: instrumentProcessBackend(backendRouter, profile.bash, counters),
	});
	const sandboxHealth = await backendRouter.inspect();
	const resolveInvocation = (tool: string, args: unknown) =>
		resolvePiToolInvocation(tool, args, { cwd: task.workspace, environment: shellEnvironment });
	const bashIsolation = await inspectBashIsolation(
		backendRouter,
		resolveInvocation("bash", { command: "printf pi-speculative-benchmark" }),
	);
	let drafterCost = 0;
	let drafterTokens = 0;
	let drafterInputTokens = 0;
	let drafterOutputTokens = 0;
	let drafterCacheReadTokens = 0;
	let drafterCacheWriteTokens = 0;
	const settings: SpeculativeAgentSettingsInput = {
		enabled: true,
		drafterEnabled: input.drafterEnabled,
		drafterMaxDepth: input.drafterMaxDepth,
		candidateLimit: input.candidateLimit,
		maxConcurrentActions: input.maxConcurrentActions,
		predictionTimeoutMs: input.timeoutMs,
		patternAware: { enabled: input.patternAware },
		tools: { resourceCached: ["read", "grep", "find"], sandbox: ["bash", "edit", "write"] },
	};
	const sessionID = `${input.label}:${task.row.instance_id}:${Date.now()}`;
	const host = createSpeculativeActionHost(sessionID, {
		cwd: task.workspace,
		getSettings: () => settings,
		draftModel: input.drafter,
		getDraftOptions: ({ signal }) => ({ signal }),
		complete: async (draftModel, context, streamOptions) => {
			const message = await streamSimple(draftModel, context, streamOptions).result();
			drafterCost += message.usage.cost.total;
			drafterTokens += message.usage.totalTokens;
			drafterInputTokens += message.usage.input;
			drafterOutputTokens += message.usage.output;
			drafterCacheReadTokens += message.usage.cacheRead;
			drafterCacheWriteTokens += message.usage.cacheWrite;
			return message;
		},
		preflight: () => true,
		resolveInvocation,
		projectionRules: [PI_READ_RANGE_PROJECTION_RULE],
		sandbox,
		patternStateDirectory: input.patternState ?? path.join(task.runDirectory, "patterns"),
		...(input.patternState
			? { patternWorkspaceIdentity: path.join(input.repoCache, "pattern-workspaces", safeName(task.row.repo)) }
			: {}),
		onEvent: (event) => {
			events.push(event);
		},
	});
	let currentTurnID: string | undefined;
	let lastTurnID: string | undefined;
	let turnSequence = 0;
	const toolIntentMs: number[] = [];
	const actorTools = tools.map(
		(base): AgentTool => ({
			...base,
			execute: async (callID, args, signal, onUpdate) => {
				const turnID = currentTurnID;
				if (!turnID) throw new Error("Actor tool executed outside an active turn");
				const intentStartedAt = performance.now();
				const cached = await host.consume(
					{ turnID, id: callID, tool: base.name, args, tools },
					signal,
				);
				if (cached) {
					toolIntentMs.push(performance.now() - intentStartedAt);
					return cached.result;
				}
				const toolStartedAt = performance.now();
				try {
					const result = await base.execute(callID, args as never, signal, onUpdate as never);
					await host.actual({
						turnID,
						id: callID,
						tool: base.name,
						args,
						tools,
						durationMs: performance.now() - toolStartedAt,
						output: { result, isError: false },
					});
					toolIntentMs.push(performance.now() - intentStartedAt);
					return result;
				} catch (error) {
					await host.actual({
						turnID,
						id: callID,
						tool: base.name,
						args,
						tools,
						durationMs: performance.now() - toolStartedAt,
						output: {
							result: {
								content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
								details: {},
							},
							isError: true,
						},
					});
					throw error;
				}
			},
		}),
	);
	const agent = new Agent({
		streamFn: (actorModel, context, streamOptions) =>
			streamSimple(actorModel, context, {
				...streamOptions,
				temperature: 0,
				maxTokens: 8_192,
			}),
		sessionId: sessionID,
		shouldStopAfterTurn: () => turnSequence >= input.maxTurns,
		initialState: {
			model: input.actor,
			thinkingLevel: "high",
			systemPrompt:
				"You are a coding agent working directly in the current repository. Inspect the relevant implementation and tests, reproduce the reported issue when practical, implement the smallest complete fix, and run focused validation. Use tools instead of guessing. Do not merely describe a patch: edit the workspace.",
			tools: actorTools,
		},
	});
	agent.subscribe(async (event, signal) => {
		if (event.type === "turn_start") {
			currentTurnID = `turn-${++turnSequence}`;
			lastTurnID = currentTurnID;
			await host.startTurn(
				{
					turnID: currentTurnID,
					actorModel: input.actor,
					context: {
						systemPrompt: agent.state.systemPrompt,
						messages: standardMessages(agent.state.messages),
						tools,
					},
					actorOptions: { signal },
					tools,
				},
				signal,
			);
		}
		if (event.type === "turn_end" && currentTurnID) {
			const turnID = currentTurnID;
			currentTurnID = undefined;
			await host.finishTurn(turnID, false);
		}
		if (event.type === "agent_end" && lastTurnID) await host.finishTurn(lastTurnID, true);
	});

	const taskStartedAt = performance.now();
	let taskCompletedAt: number | undefined;
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		agent.abort();
	}, input.timeoutMs);
	try {
		await agent.prompt(
			`${task.row.problem_statement}\n\nWork in the checked-out repository and finish the implementation. Do not use network access to look up the answer.`,
		);
	} finally {
		taskCompletedAt = performance.now();
		clearTimeout(timeout);
		if (lastTurnID) await host.finishTurn(lastTurnID, true);
		await host.dispose();
	}
	const summary = summarizeSpeculativeTrace(events);
	const sourceRequestKinds = events.reduce<Record<string, number>>((counts, event) => {
		if (event.type === "source_request") {
			counts[event.request.request.kind] = (counts[event.request.request.kind] ?? 0) + 1;
		}
		return counts;
	}, {});
	const speculativeHitsByDepth = events.reduce<Record<string, number>>((counts, event) => {
		if (event.type === "actor_action" && event.settlement.provider.kind === "speculative") {
			const depth = String(event.candidate?.depth ?? 0);
			counts[depth] = (counts[depth] ?? 0) + 1;
		}
		return counts;
	}, {});
	const agentPromptMs = Math.max(0, (taskCompletedAt ?? performance.now()) - taskStartedAt);
	const actualEndToEndMs = Math.max(agentPromptMs, summary.endToEndMs);
	const hiddenLatencyMs = summary.hiddenLatencyMs;
	const serializedCounterfactualMs = actualEndToEndMs + hiddenLatencyMs;
	const nonToolMs = Math.max(0, serializedCounterfactualMs - summary.toolExecutionMs);
	const actorUsage = agent.state.messages
		.filter((message) => message.role === "assistant")
		.reduce(
			(current, message) => ({
				cost: current.cost + message.usage.cost.total,
				tokens: current.tokens + message.usage.totalTokens,
				inputTokens: current.inputTokens + message.usage.input,
				outputTokens: current.outputTokens + message.usage.output,
				cacheReadTokens: current.cacheReadTokens + message.usage.cacheRead,
				cacheWriteTokens: current.cacheWriteTokens + message.usage.cacheWrite,
			}),
			{ cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		);
	const changedFiles = lines((await command("git", ["-C", task.workspace, "diff", "--name-only"])).stdout);
	const goldFiles = patchFiles(task.row.patch);
	const testPatchFiles = patchFiles(task.row.test_patch);
	let patchClean = true;
	try {
		await command("git", ["-C", task.workspace, "diff", "--check"]);
	} catch {
		patchClean = false;
	}
	const coveredGoldFiles = goldFiles.filter((file) => changedFiles.includes(file));
	const turnLimitReached = turnSequence >= input.maxTurns;
	return {
		metadata: {
			label: input.label,
			implementationCommit,
			instance: task.row.instance_id,
			repo: task.row.repo,
			baseCommit: task.row.base_commit,
			language: task.row.language,
			sourceDataset: task.row.source_dataset,
			actor: `${input.actor.provider}/${input.actor.id}`,
			drafter: `${input.drafter.provider}/${input.drafter.id}`,
			candidateLimit: input.candidateLimit,
			drafterMaxDepth: input.drafterMaxDepth,
			drafterEnabled: input.drafterEnabled,
			maxConcurrentActions: input.maxConcurrentActions,
			maxTurns: input.maxTurns,
			timeoutMs: input.timeoutMs,
			latencyProfile: input.latency,
			latencyMs: profile,
			patternAware: input.patternAware,
			patternState: input.patternState ?? "isolated-per-run",
			sandbox: { health: sandboxHealth, bash: bashIsolation },
			workspace: task.workspace,
		},
		summary: {
			actualEndToEndMs,
			serializedCounterfactualMs,
			nonToolMs,
			authoritativeToolMs: summary.toolExecutionMs,
			hiddenLatencyMs,
			accelerationRatio: actualEndToEndMs > 0 ? serializedCounterfactualMs / actualEndToEndMs : 1,
			actorActions: summary.actorActions,
			speculativeHits: summary.speculativeHits,
			speculativeHitsByDepth,
			actorFallbacks: summary.actorFallbacks,
			hitRate: summary.hitRate,
			sourceRequests: summary.sourceRequests,
			sourceRequestKinds,
			sourceOutcomes: summary.sourceOutcomes,
			predictionsSettled: summary.predictionsSettled,
			predictionsObserved: summary.predictionsObserved,
			predictionsMatched: summary.predictionsMatched,
			predictionsAdopted: summary.predictionsAdopted,
			predictionPrecision: summary.predictionPrecision,
			adoptionYield: summary.adoptionYield,
			predictionUnobserved: summary.predictionUnobserved,
			predictionRejectedAfterMatch: summary.predictionRejectedAfterMatch,
			executionAheadMs: summary.executionAheadMs,
			hitLatencyMs: summary.hitLatencyMs,
			speculativeExecutionMs: summary.speculativeExecutionMs,
			actorExecutionMs: summary.actorExecutionMs,
			candidateStarted: summary.candidateStarted,
			candidateSucceeded: summary.candidateSucceeded,
			candidateFailed: summary.candidateFailed,
			candidateCancelled: summary.candidateCancelled,
			candidateTerminalCauses: summary.candidateTerminalCauses,
			actorCandidateRejections: summary.actorCandidateRejections,
			actorCost: actorUsage.cost,
			drafterCost,
			actorTokens: actorUsage.tokens,
			drafterTokens,
			actorInputTokens: actorUsage.inputTokens,
			actorOutputTokens: actorUsage.outputTokens,
			actorCacheReadTokens: actorUsage.cacheReadTokens,
			actorCacheWriteTokens: actorUsage.cacheWriteTokens,
			drafterInputTokens,
			drafterOutputTokens,
			drafterCacheReadTokens,
			drafterCacheWriteTokens,
			turns: turnSequence,
			turnLimitReached,
			timedOut,
			agentError: agent.state.errorMessage,
			toolIntentMs,
			toolExecutions: counters.executions,
			toolServiceMs: counters.serviceMs,
			changedFiles,
			goldFiles,
			testPatchFiles,
			failToPassTests: task.row.FAIL_TO_PASS,
			passToPassTests: task.row.PASS_TO_PASS,
			coveredGoldFiles,
			goldFileRecall: goldFiles.length ? coveredGoldFiles.length / goldFiles.length : 0,
			patchClean,
			patchCandidate:
				!timedOut &&
				!turnLimitReached &&
				!agent.state.errorMessage &&
				patchClean &&
				changedFiles.length > 0 &&
				coveredGoldFiles.length > 0,
		},
	};
}

function instrumentTool(tool: AgentTool, addedLatencyMs: number, counters: ToolCounters): AgentTool {
	return {
		...tool,
		execute: async (callID, args, signal, onUpdate) => {
			const startedAt = performance.now();
			counters.executions[tool.name] = (counters.executions[tool.name] ?? 0) + 1;
			try {
				await delay(addedLatencyMs, signal);
				return withPiProjectionCoverage(
					tool.name,
					args,
					await tool.execute(callID, args as never, signal, onUpdate as never),
				);
			} finally {
				counters.serviceMs[tool.name] =
					(counters.serviceMs[tool.name] ?? 0) + Math.max(0, performance.now() - startedAt);
			}
		},
	};
}

function instrumentProcessBackend(
	backend: SandboxProcessBackend,
	addedLatencyMs: number,
	counters: ToolCounters,
): SandboxProcessBackend {
	return {
		check: (options) => backend.check(options),
		...(backend.supports ? { supports: (invocation) => backend.supports!(invocation) } : {}),
		fingerprint: (invocation) => backend.fingerprint(invocation),
		prepare: (input) => backend.prepare(input),
		open: async (input) => {
			const session = await backend.open(input);
			return {
				processRoot: session.processRoot,
				execute: async (invocation) => {
					const startedAt = performance.now();
					counters.executions.bash = (counters.executions.bash ?? 0) + 1;
					try {
						await delay(addedLatencyMs, invocation.signal);
						return await session.execute(invocation);
					} finally {
						counters.serviceMs.bash =
							(counters.serviceMs.bash ?? 0) + Math.max(0, performance.now() - startedAt);
					}
				},
				close: session.close,
			};
		},
		dispose: () => backend.dispose(),
	};
}

async function inspectBashIsolation(backend: SandboxProcessBackend, invocation: ToolInvocation | undefined) {
	if (!invocation?.process) return { state: "unavailable" as const, detail: "Bash invocation is unresolved." };
	try {
		return { state: "ready" as const, fingerprint: await backend.fingerprint(invocation.process) };
	} catch (error) {
		return {
			state: "unavailable" as const,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

function benchmarkShellEnvironment(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined && !/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(entry[0]),
		),
	);
}

async function datasetRow(instanceID: string): Promise<DatasetRow> {
	const response = await fetch(DATASET_ROWS);
	if (!response.ok) throw new Error(`Dataset request failed with HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (!value || typeof value !== "object" || !("rows" in value) || !Array.isArray(value.rows)) {
		throw new Error("Dataset response has no rows");
	}
	for (const item of value.rows) {
		if (!item || typeof item !== "object" || !("row" in item)) continue;
		const row = validDatasetRow(item.row);
		if (row?.instance_id === instanceID) return row;
	}
	throw new Error(`Claw-SWE-Bench Lite instance not found: ${instanceID}`);
}

function validDatasetRow(value: unknown): DatasetRow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Partial<Record<keyof DatasetRow, unknown>>;
	for (const key of [
		"instance_id",
		"repo",
		"base_commit",
		"patch",
		"test_patch",
		"problem_statement",
		"language",
		"source_dataset",
	] as const) {
		if (typeof row[key] !== "string") return undefined;
	}
	for (const key of ["FAIL_TO_PASS", "PASS_TO_PASS"] as const) {
		if (!Array.isArray(row[key]) || !row[key].every((item) => typeof item === "string")) return undefined;
	}
	return row as DatasetRow;
}

function model(value: string): Model<Api> {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid model ${value}; expected provider/id`);
	const providerName = value.slice(0, separator);
	const provider = getProviders().find((candidate) => candidate === providerName);
	if (!provider) throw new Error(`Unknown model provider ${providerName}`);
	const modelID = value.slice(separator + 1);
	const resolved = getModels(provider).find((candidate) => candidate.id === modelID);
	if (!resolved) throw new Error(`Unknown model ${value}`);
	return resolved;
}

function standardMessages(messages: readonly AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function patchFiles(patch: string): string[] {
	return [
		...new Set(
			patch
				.split(/\r?\n/)
				.flatMap((line) => (line.startsWith("diff --git a/") ? [line.slice("diff --git a/".length).split(" b/")[0]!] : [])),
		),
	];
}

function lines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function latencyProfile(value: string | undefined): LatencyProfile {
	if (value && Object.hasOwn(latencyProfiles, value)) return value as LatencyProfile;
	throw new Error(`Invalid --latency ${value}; expected ${Object.keys(latencyProfiles).join(", ")}`);
}

function positiveInteger(value: string | undefined, option: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
	return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string, maximum: number): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
		throw new Error(`${option} must be an integer from 0 through ${maximum}`);
	}
	return parsed;
}

function required(value: string | undefined, option: string): string {
	if (!value?.trim()) throw new Error(`${option} is required`);
	return value.trim();
}

function safeName(value: string): string {
	return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

async function exists(value: string): Promise<boolean> {
	try {
		await stat(value);
		return true;
	} catch {
		return false;
	}
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
	if (durationMs <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, durationMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function command(file: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || error.message}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}
