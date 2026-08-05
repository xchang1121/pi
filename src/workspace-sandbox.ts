import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	readonly sandbox: "git_worktree";
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
	/** Revalidate and atomically adopt an execution, rolling back partial writes on failure. */
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
	 * a detached worktree alone is not a process security boundary.
	 */
	readonly processRunner?: SandboxProcessRunner;
	readonly gitBinary?: string;
}

export interface SandboxWorkspaceContext {
	readonly sourceRoot: string;
	readonly sandboxRoot: string;
}

interface PrivateGitWorkspace extends SandboxWorkspaceContext {
	readonly parent: string;
	readonly repository: string;
	readonly gitBinary: string;
}

const SNAPSHOT_EXCLUDES = [".git", ".pi", "node_modules", "dist", ".next"] as const;

/** Create M4's private Git snapshot sandbox with transactional multi-file adoption. */
export function createWorkspaceSandbox(options: WorkspaceSandboxOptions = {}): SpeculativeAgentSandbox {
	return {
		supports: (toolName) =>
			toolName === "write" || toolName === "edit" || (toolName === "bash" && !!options.processRunner),
		execute: async (context) => {
			if (context.toolName === "write" || context.toolName === "edit") {
				return executeMutation(context, options.gitBinary);
			}
			if (context.toolName === "bash" && options.processRunner) {
				return executeBash(context, options.processRunner, options.gitBinary);
			}
			throw new Error(`Sandbox does not support tool ${context.toolName}`);
		},
		adopt: commitSandboxExecution,
	};
}

export async function commitSandboxExecution(execution: SpeculativeSandboxExecution): Promise<SettleToolCallResult> {
	for (const change of execution.changes) {
		const root = path.resolve(change.root);
		const target = path.resolve(change.target);
		if (!contains(root, target) || target === root || target !== path.resolve(root, change.resource)) {
			throw new Error(`sandbox adoption path escapes workspace: ${change.resource}`);
		}
		await assertNoSymlinkPath(root, target);
		const current = await readOptional(target);
		if (!sameOptionalBytes(current, change.before)) {
			throw new Error(`resource changed before adoption: ${change.resource}`);
		}
	}

	const applied: SandboxFileChange[] = [];
	try {
		for (const change of execution.changes) {
			applied.push(change);
			await applyBytes(change.target, change.after);
		}
	} catch (error) {
		for (const change of applied.reverse()) {
			try {
				await applyBytes(change.target, change.before);
			} catch {
				// Continue restoring the remaining paths before surfacing the adoption failure.
			}
		}
		throw error;
	}
	return execution.output;
}

export async function withSandboxWorkspace<T>(
	cwd: string,
	run: (workspace: SandboxWorkspaceContext) => Promise<T>,
	gitBinary = "git",
): Promise<T> {
	const workspace = await createPrivateGitWorkspace(cwd, gitBinary);
	try {
		return await run(workspace);
	} finally {
		await cleanupPrivateGitWorkspace(workspace);
	}
}

async function executeMutation(
	context: SpeculativeSandboxExecuteContext,
	gitBinary?: string,
): Promise<SpeculativeSandboxExecution> {
	const args = asRecord(context.args);
	if (!args || typeof args.path !== "string") throw new Error(`${context.toolName}.path must be a string`);
	const sourceRoot = path.resolve(context.cwd);
	const target = path.resolve(sourceRoot, args.path);
	if (!contains(sourceRoot, target) || target === sourceRoot) {
		throw new Error(`sandbox mutation path escapes workspace: ${args.path}`);
	}
	await assertNoSymlinkPath(sourceRoot, target);
	const resource = slash(path.relative(sourceRoot, target));
	const requestedPath = args.path;

	return withPrivateGitWorkspace(sourceRoot, gitBinary ?? "git", async (workspace) => {
		const sandboxTarget = path.resolve(workspace.sandboxRoot, resource);
		await assertNoSymlinkPath(workspace.sandboxRoot, sandboxTarget);
		const redirected = { ...args, path: sandboxTarget };
		const result = await context.tool.execute(context.callID, redirected as never, context.signal);
		const changes = await collectSandboxChanges(workspace);
		return {
			output: {
				result: replacePaths(result, [
					[sandboxTarget, requestedPath],
					[workspace.sandboxRoot, sourceRoot],
				]),
				isError: false,
			},
			changes,
			sandbox: "git_worktree",
		};
	});
}

async function executeBash(
	context: SpeculativeSandboxExecuteContext,
	runner: SandboxProcessRunner,
	gitBinary?: string,
): Promise<SpeculativeSandboxExecution> {
	const args = asRecord(context.args);
	if (!args || typeof args.command !== "string") throw new Error("bash.command must be a string");
	if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout))) {
		throw new Error("bash.timeout must be a finite number");
	}
	const sourceRoot = path.resolve(context.cwd);
	const command = args.command;
	return withPrivateGitWorkspace(sourceRoot, gitBinary ?? "git", async (workspace) => {
		const output = await runner({
			command,
			cwd: workspace.sandboxRoot,
			sourceRoot,
			...(typeof args.timeout === "number" ? { timeout: args.timeout } : {}),
			signal: context.signal,
		});
		return {
			output: replacePaths(output, [[workspace.sandboxRoot, sourceRoot]]),
			changes: await collectSandboxChanges(workspace),
			sandbox: "git_worktree",
		};
	});
}

async function createPrivateGitWorkspace(cwd: string, gitBinary: string): Promise<PrivateGitWorkspace> {
	const sourceRoot = path.resolve(cwd);
	await assertNoSymlinkPath(sourceRoot, sourceRoot);
	const parent = await mkdtemp(path.join(os.tmpdir(), "pi-speculative-action-"));
	const repository = path.join(parent, "snapshot.git");
	const sandboxRoot = path.join(parent, "workspace");
	const authorEnvironment = {
		GIT_AUTHOR_NAME: "Pi Speculative Action",
		GIT_AUTHOR_EMAIL: "speculative-action@localhost",
		GIT_COMMITTER_NAME: "Pi Speculative Action",
		GIT_COMMITTER_EMAIL: "speculative-action@localhost",
	};
	try {
		await git(gitBinary, ["init", "--bare", repository], parent);
		await git(gitBinary, ["--git-dir", repository, "config", "core.autocrlf", "false"], parent);
		const pathspecs = SNAPSHOT_EXCLUDES.flatMap((item) => [
			`:(glob,exclude)**/${item}`,
			`:(glob,exclude)**/${item}/**`,
		]);
		await git(
			gitBinary,
			["--git-dir", repository, "--work-tree", sourceRoot, "add", "-f", "-A", "--", ".", ...pathspecs],
			sourceRoot,
		);
		const tree = (await git(gitBinary, ["--git-dir", repository, "write-tree"], parent)).toString("utf8").trim();
		const commit = (
			await git(
				gitBinary,
				["--git-dir", repository, "commit-tree", tree, "-m", "speculative baseline"],
				parent,
				authorEnvironment,
			)
		)
			.toString("utf8")
			.trim();
		await git(gitBinary, ["--git-dir", repository, "update-ref", "refs/heads/baseline", commit], parent);
		await git(gitBinary, ["--git-dir", repository, "worktree", "add", "--detach", sandboxRoot, commit], parent);
		return { sourceRoot, sandboxRoot, parent, repository, gitBinary };
	} catch (error) {
		await rm(parent, { recursive: true, force: true });
		throw error;
	}
}

async function withPrivateGitWorkspace<T>(
	cwd: string,
	gitBinary: string,
	run: (workspace: PrivateGitWorkspace) => Promise<T>,
): Promise<T> {
	const workspace = await createPrivateGitWorkspace(cwd, gitBinary);
	try {
		return await run(workspace);
	} finally {
		await cleanupPrivateGitWorkspace(workspace);
	}
}

async function cleanupPrivateGitWorkspace(workspace: PrivateGitWorkspace): Promise<void> {
	try {
		await git(
			workspace.gitBinary,
			["--git-dir", workspace.repository, "worktree", "remove", "--force", workspace.sandboxRoot],
			workspace.parent,
		);
	} catch {
		// The private parent removal below is the final cleanup boundary.
	}
	await rm(workspace.parent, { recursive: true, force: true });
}

async function collectSandboxChanges(workspace: PrivateGitWorkspace): Promise<readonly SandboxFileChange[]> {
	const tracked = await git(
		workspace.gitBinary,
		["-C", workspace.sandboxRoot, "diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
		workspace.sandboxRoot,
	);
	const untracked = await git(
		workspace.gitBinary,
		["-C", workspace.sandboxRoot, "ls-files", "--others", "--exclude-standard", "-z", "--"],
		workspace.sandboxRoot,
	);
	const resources = [...new Set([...parseNullList(tracked), ...parseNullList(untracked)])].sort();
	const changes: SandboxFileChange[] = [];
	for (const resource of resources) {
		if (!resource || path.isAbsolute(resource) || resource.split("/").includes("..")) {
			throw new Error(`invalid sandbox change path: ${resource}`);
		}
		const target = path.resolve(workspace.sourceRoot, resource);
		const sandboxTarget = path.resolve(workspace.sandboxRoot, resource);
		if (!contains(workspace.sourceRoot, target) || !contains(workspace.sandboxRoot, sandboxTarget)) {
			throw new Error(`sandbox change escapes workspace: ${resource}`);
		}
		await assertNoSymlinkPath(workspace.sourceRoot, target);
		await assertNoSymlinkPath(workspace.sandboxRoot, sandboxTarget);
		const before = await readBaselineBytes(workspace, resource);
		const after = await readOptional(sandboxTarget);
		if (!sameOptionalBytes(before, after)) {
			changes.push({ root: workspace.sourceRoot, target, resource, before, after });
		}
	}
	return changes;
}

async function readBaselineBytes(workspace: PrivateGitWorkspace, resource: string): Promise<Uint8Array | undefined> {
	const entry = await git(
		workspace.gitBinary,
		["-C", workspace.sandboxRoot, "ls-tree", "-z", "HEAD", "--", resource],
		workspace.sandboxRoot,
	);
	if (entry.length === 0) return undefined;
	const metadata = entry.subarray(0, entry.indexOf(0)).toString("utf8").split("\t", 1)[0];
	const hash = metadata.split(" ")[2];
	if (!hash) throw new Error(`invalid Git baseline entry: ${resource}`);
	return git(workspace.gitBinary, ["-C", workspace.sandboxRoot, "cat-file", "blob", hash], workspace.sandboxRoot);
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
			if (stats.isSymbolicLink()) {
				throw new Error(`sandbox path contains symlink: ${slash(path.relative(resolvedRoot, current))}`);
			}
		} catch (error) {
			if (isMissing(error)) break;
			throw error;
		}
	}
}

async function applyBytes(target: string, bytes: Uint8Array | undefined): Promise<void> {
	if (bytes === undefined) {
		await rm(target, { force: true });
		return;
	}
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, bytes);
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

function parseNullList(value: Uint8Array): string[] {
	return value
		.toString()
		.split("\0")
		.filter(Boolean)
		.map((item) => slash(item));
}

function replacePaths<T>(value: T, replacements: readonly (readonly [string, string])[]): T {
	if (typeof value === "string") {
		let result: string = value;
		for (const [from, to] of replacements) result = result.replaceAll(from, to);
		return result as T;
	}
	if (Array.isArray(value)) return value.map((item) => replacePaths(item, replacements)) as T;
	if (!value || typeof value !== "object" || value instanceof Uint8Array) return value;
	if (Object.getPrototypeOf(value) !== Object.prototype) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replacePaths(item, replacements)]),
	) as T;
}

function git(
	command: string,
	args: readonly string[],
	cwd: string,
	environment: Readonly<Record<string, string>> = {},
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{
				cwd,
				env: { ...process.env, ...environment },
				encoding: "buffer",
				maxBuffer: 64 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`${command} ${args.join(" ")} failed: ${Buffer.from(stderr).toString("utf8").trim()}`));
					return;
				}
				resolve(Buffer.from(stdout));
			},
		);
	});
}
