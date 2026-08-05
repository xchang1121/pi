import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, SettleToolCallResult } from "@earendil-works/pi-agent-core";
import type { ActionKey } from "./common.ts";
import { asRecord, contains, slash } from "./common.ts";

export interface SandboxFileChange {
	readonly root: string;
	readonly target: string;
	readonly resource: string;
	readonly before?: Uint8Array;
	readonly after?: Uint8Array;
}

export interface SpeculativeSandboxExecution {
	readonly output: SettleToolCallResult;
	readonly changes: readonly SandboxFileChange[];
	readonly sandbox: "temporary_workspace";
}

export interface SpeculativeSandboxExecuteContext {
	readonly cwd: string;
	readonly tool: AgentTool;
	readonly toolName: string;
	readonly args: unknown;
	readonly action: ActionKey;
	readonly callID: string;
	readonly signal: AbortSignal;
}

export interface SpeculativeAgentSandbox {
	/** Return true only when this instance can isolate the named tool. */
	readonly supports: (toolName: string) => boolean;
	/** Execute without changing the real workspace. */
	readonly execute: (context: SpeculativeSandboxExecuteContext) => Promise<SpeculativeSandboxExecution>;
	/** Revalidate and adopt an execution. Throw when adoption is unsafe. */
	readonly adopt: (execution: SpeculativeSandboxExecution) => Promise<SettleToolCallResult>;
}

export interface SandboxProcessRunnerInput {
	readonly command: string;
	readonly cwd: string;
	readonly sourceRoot: string;
	readonly timeout?: number;
	readonly signal: AbortSignal;
}

export type SandboxProcessRunner = (input: SandboxProcessRunnerInput) => Promise<SettleToolCallResult>;

export interface WorkspaceSandboxOptions {
	/**
	 * Process isolation provider used for bash. The provider must prevent access to sourceRoot;
	 * a temporary cwd alone is not a security boundary.
	 */
	readonly processRunner?: SandboxProcessRunner;
}

/**
 * Create M3's conservative workspace sandbox.
 *
 * Pi write/edit calls are redirected to a temporary file and adopted only after byte-for-byte
 * base validation. Bash additionally requires an explicit process isolation provider. Full
 * worktree transactions and native process isolation are intentionally deferred to M4/M5.
 */
export function createWorkspaceSandbox(options: WorkspaceSandboxOptions = {}): SpeculativeAgentSandbox {
	return {
		supports: (toolName) =>
			toolName === "write" || toolName === "edit" || (toolName === "bash" && !!options.processRunner),
		execute: async (context) => {
			if (context.toolName === "write" || context.toolName === "edit") {
				return executeMutation(context);
			}
			if (context.toolName === "bash" && options.processRunner) {
				return executeBash(context, options.processRunner);
			}
			throw new Error(`Sandbox does not support tool ${context.toolName}`);
		},
		adopt: commitSandboxExecution,
	};
}

export async function commitSandboxExecution(execution: SpeculativeSandboxExecution): Promise<SettleToolCallResult> {
	for (const change of execution.changes) {
		await assertNoSymlinkPath(change.root, change.target);
		const current = await readOptional(change.target);
		if (!sameOptionalBytes(current, change.before)) {
			throw new Error(`resource changed before adoption: ${change.resource}`);
		}
	}
	for (const change of execution.changes) {
		if (change.after === undefined) throw new Error(`M3 sandbox cannot delete files: ${change.resource}`);
		await mkdir(path.dirname(change.target), { recursive: true });
		await writeFile(change.target, change.after);
	}
	return execution.output;
}

async function executeMutation(context: SpeculativeSandboxExecuteContext): Promise<SpeculativeSandboxExecution> {
	const args = asRecord(context.args);
	if (!args || typeof args.path !== "string") throw new Error(`${context.toolName}.path must be a string`);
	const root = path.resolve(context.cwd);
	const target = path.resolve(root, args.path);
	if (!contains(root, target) || target === root)
		throw new Error(`sandbox mutation path escapes workspace: ${args.path}`);
	await assertNoSymlinkPath(root, target);

	const before = await readOptional(target);
	const sandboxParent = await mkdtemp(path.join(os.tmpdir(), "pi-speculative-action-"));
	const sandboxRoot = path.join(sandboxParent, "workspace");
	const resource = slash(path.relative(root, target));
	const sandboxTarget = path.join(sandboxRoot, resource);
	try {
		await mkdir(path.dirname(sandboxTarget), { recursive: true });
		if (before !== undefined) await writeFile(sandboxTarget, before);
		const redirected = { ...args, path: sandboxTarget };
		const result = await context.tool.execute(context.callID, redirected as never, context.signal);
		const after = await readOptional(sandboxTarget);
		if (after === undefined) throw new Error(`${context.toolName} did not produce its target file`);
		return {
			output: {
				result: sanitizeToolResult(result, sandboxTarget, args.path),
				isError: false,
			},
			changes: [{ root, target, resource, before, after }],
			sandbox: "temporary_workspace",
		};
	} finally {
		await rm(sandboxParent, { recursive: true, force: true });
	}
}

async function executeBash(
	context: SpeculativeSandboxExecuteContext,
	runner: SandboxProcessRunner,
): Promise<SpeculativeSandboxExecution> {
	const args = asRecord(context.args);
	if (!args || typeof args.command !== "string") throw new Error("bash.command must be a string");
	if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout))) {
		throw new Error("bash.timeout must be a finite number");
	}
	const sourceRoot = path.resolve(context.cwd);
	const sandboxParent = await mkdtemp(path.join(os.tmpdir(), "pi-speculative-action-"));
	const sandboxRoot = path.join(sandboxParent, "workspace");
	try {
		await cp(sourceRoot, sandboxRoot, {
			recursive: true,
			dereference: false,
			filter: (source) => shouldCopyWorkspacePath(sourceRoot, source),
		});
		const output = await runner({
			command: args.command,
			cwd: sandboxRoot,
			sourceRoot,
			...(typeof args.timeout === "number" ? { timeout: args.timeout } : {}),
			signal: context.signal,
		});
		return { output, changes: [], sandbox: "temporary_workspace" };
	} finally {
		await rm(sandboxParent, { recursive: true, force: true });
	}
}

function shouldCopyWorkspacePath(root: string, source: string): boolean {
	const relative = path.relative(root, source);
	if (relative === "") return true;
	const first = relative.split(path.sep)[0];
	return first !== ".git" && first !== ".pi" && first !== "node_modules" && first !== "dist" && first !== ".next";
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	if (!contains(resolvedRoot, resolvedTarget) && resolvedRoot !== resolvedTarget) {
		throw new Error(`sandbox path escapes workspace: ${resolvedTarget}`);
	}
	try {
		if ((await lstat(resolvedRoot)).isSymbolicLink()) throw new Error("sandbox workspace root is a symlink");
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const relative = path.relative(resolvedRoot, resolvedTarget);
	let current = resolvedRoot;
	for (const segment of relative === "" ? [] : relative.split(path.sep)) {
		current = path.join(current, segment);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink())
				throw new Error(`sandbox path contains symlink: ${slash(path.relative(resolvedRoot, current))}`);
		} catch (error) {
			if (isMissing(error)) break;
			throw error;
		}
	}
}

async function readOptional(target: string): Promise<Uint8Array | undefined> {
	try {
		return await readFile(target);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function sameOptionalBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
	return true;
}

function sanitizeToolResult<T>(result: T, sandboxTarget: string, requestedPath: string): T {
	return replaceSandboxPath(result, sandboxTarget, requestedPath) as T;
}

function replaceSandboxPath(value: unknown, sandboxTarget: string, requestedPath: string): unknown {
	if (typeof value === "string") return value.replaceAll(sandboxTarget, requestedPath);
	if (Array.isArray(value)) return value.map((item) => replaceSandboxPath(item, sandboxTarget, requestedPath));
	if (!value || typeof value !== "object" || value instanceof Uint8Array) return value;
	if (Object.getPrototypeOf(value) !== Object.prototype) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			replaceSandboxPath(item, sandboxTarget, requestedPath),
		]),
	);
}
