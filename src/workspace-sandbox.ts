import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, SettleToolCallResult } from "@earendil-works/pi-agent-core";
import type { ActionKey } from "./common.ts";
import { asRecord, contains, slash } from "./common.ts";
import { ResourceVersionManager, type ResourceVersionToken } from "./resource-version.ts";

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
	readonly setupMs?: number;
	readonly changeCollectionMs?: number;
	commitMetrics?: SandboxCommitMetrics;
}

export interface SandboxCommitMetrics {
	readonly durationMs: number;
	readonly validationMs: number;
	readonly bytesValidated: number;
	readonly filesValidated: number;
	readonly filesCommitted: number;
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
	readonly shell?: string;
	readonly cwd: string;
	/** Private parent mounted by native isolation; cwd must remain inside it. */
	readonly processRoot: string;
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
	readonly shell?: string;
	readonly gitBinary?: string;
}

export interface SandboxWorkspaceContext {
	readonly sourceRoot: string;
	readonly sandboxRoot: string;
	readonly processRoot: string;
}

interface PrivateGitWorkspace extends SandboxWorkspaceContext {
	readonly repository: string;
	readonly gitBinary: string;
	readonly pool: PooledGitRepository;
}

interface PooledGitRepository {
	readonly sourceRoot: string;
	readonly parent: string;
	readonly repository: string;
	readonly gitBinary: string;
	readonly versions: ResourceVersionManager;
	commit?: string;
	version?: ResourceVersionToken;
	active: number;
	lock: Promise<void>;
	idleTimer?: ReturnType<typeof setTimeout>;
}

const SNAPSHOT_EXCLUDES = [".git", ".pi", "node_modules", "dist", ".next"] as const;
const SANDBOX_REPOSITORY_IDLE_MS = 5 * 60 * 1000;
const sandboxRepositories = new Map<string, Promise<PooledGitRepository>>();

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
				return executeBash(context, options.processRunner, options.gitBinary, options.shell);
			}
			throw new Error(`Sandbox does not support tool ${context.toolName}`);
		},
		adopt: commitSandboxExecution,
	};
}

export async function commitSandboxExecution(execution: SpeculativeSandboxExecution): Promise<SettleToolCallResult> {
	const started = performance.now();
	const validationStarted = performance.now();
	let bytesValidated = 0;
	for (const change of execution.changes) {
		const root = path.resolve(change.root);
		const target = path.resolve(change.target);
		if (!contains(root, target) || target === root || target !== path.resolve(root, change.resource)) {
			throw new Error(`sandbox adoption path escapes workspace: ${change.resource}`);
		}
		await assertNoSymlinkPath(root, target);
		const current = await readOptional(target);
		bytesValidated += current?.byteLength ?? 0;
		if (!sameOptionalBytes(current, change.before)) {
			throw new Error(`resource changed before adoption: ${change.resource}`);
		}
	}
	const validationMs = Math.max(0, performance.now() - validationStarted);

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
	execution.commitMetrics = {
		durationMs: Math.max(0, performance.now() - started),
		validationMs,
		bytesValidated,
		filesValidated: execution.changes.length,
		filesCommitted: execution.changes.length,
	};
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
	const setupStarted = performance.now();

	return withPrivateGitWorkspace(sourceRoot, gitBinary ?? "git", async (workspace) => {
		const setupMs = Math.max(0, performance.now() - setupStarted);
		const sandboxTarget = path.resolve(workspace.sandboxRoot, resource);
		await assertNoSymlinkPath(workspace.sandboxRoot, sandboxTarget);
		const redirected = { ...args, path: sandboxTarget };
		const result = await context.tool.execute(context.callID, redirected as never, context.signal);
		const collectionStarted = performance.now();
		const changes = await collectSandboxChanges(workspace);
		const changeCollectionMs = Math.max(0, performance.now() - collectionStarted);
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
			setupMs,
			changeCollectionMs,
		};
	});
}

async function executeBash(
	context: SpeculativeSandboxExecuteContext,
	runner: SandboxProcessRunner,
	gitBinary?: string,
	shell?: string,
): Promise<SpeculativeSandboxExecution> {
	const args = asRecord(context.args);
	if (!args || typeof args.command !== "string") throw new Error("bash.command must be a string");
	if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout))) {
		throw new Error("bash.timeout must be a finite number");
	}
	const sourceRoot = path.resolve(context.cwd);
	const command = args.command;
	const setupStarted = performance.now();
	return withPrivateGitWorkspace(sourceRoot, gitBinary ?? "git", async (workspace) => {
		const setupMs = Math.max(0, performance.now() - setupStarted);
		const output = await runner({
			command,
			...(shell ? { shell } : {}),
			cwd: workspace.sandboxRoot,
			processRoot: workspace.processRoot,
			sourceRoot,
			...(typeof args.timeout === "number" ? { timeout: args.timeout } : {}),
			signal: context.signal,
		});
		const collectionStarted = performance.now();
		const changes = await collectSandboxChanges(workspace);
		return {
			output: replacePaths(output, [[workspace.sandboxRoot, sourceRoot]]),
			changes,
			sandbox: "git_worktree",
			setupMs,
			changeCollectionMs: Math.max(0, performance.now() - collectionStarted),
		};
	});
}

async function createPrivateGitWorkspace(cwd: string, gitBinary: string): Promise<PrivateGitWorkspace> {
	const sourceRoot = path.resolve(cwd);
	await assertNoSymlinkPath(sourceRoot, sourceRoot);
	const pool = await acquireSandboxRepository(sourceRoot, gitBinary);
	let parent: string | undefined;
	let sandboxRoot: string | undefined;
	let attached = false;
	const repository = pool.repository;
	const authorEnvironment = {
		GIT_AUTHOR_NAME: "Pi Speculative Action",
		GIT_AUTHOR_EMAIL: "speculative-action@localhost",
		GIT_COMMITTER_NAME: "Pi Speculative Action",
		GIT_COMMITTER_EMAIL: "speculative-action@localhost",
	};
	try {
		parent = await mkdtemp(path.join(pool.parent, "action-"));
		sandboxRoot = path.join(parent, "workspace");
		const actionParent = parent;
		const actionRoot = sandboxRoot;
		const commit = await acquireSandboxBaseline(pool, authorEnvironment);
		await git(gitBinary, ["--git-dir", repository, "worktree", "add", "--detach", actionRoot, commit], actionParent);
		attached = true;
		return { sourceRoot, sandboxRoot: actionRoot, processRoot: actionParent, repository, gitBinary, pool };
	} catch (error) {
		if (attached && sandboxRoot) {
			await git(
				gitBinary,
				["--git-dir", repository, "worktree", "remove", "--force", sandboxRoot],
				pool.parent,
			).catch(() => undefined);
		}
		if (parent) await rm(parent, { recursive: true, force: true }).catch(() => undefined);
		releaseSandboxRepository(pool);
		throw error;
	}
}

async function acquireSandboxRepository(sourceRoot: string, gitBinary: string): Promise<PooledGitRepository> {
	const key = `${pathKey(sourceRoot)}\0${gitBinary}`;
	let pending = sandboxRepositories.get(key);
	if (!pending) {
		pending = createSandboxRepository(sourceRoot, gitBinary);
		sandboxRepositories.set(key, pending);
		void pending.catch(() => {
			if (sandboxRepositories.get(key) === pending) sandboxRepositories.delete(key);
		});
	}
	const repository = await pending;
	if (repository.idleTimer) {
		clearTimeout(repository.idleTimer);
		repository.idleTimer = undefined;
	}
	repository.active++;
	return repository;
}

async function createSandboxRepository(sourceRoot: string, gitBinary: string): Promise<PooledGitRepository> {
	const parent = await mkdtemp(path.join(os.tmpdir(), "pi-speculative-action-pool-"));
	const repository = path.join(parent, "snapshot.git");
	try {
		await git(gitBinary, ["init", "--bare", repository], parent);
		await git(gitBinary, ["--git-dir", repository, "config", "core.autocrlf", "false"], parent);
		await git(gitBinary, ["--git-dir", repository, "config", "core.longpaths", "true"], parent);
		return {
			sourceRoot,
			parent,
			repository,
			gitBinary,
			versions: new ResourceVersionManager(sourceRoot),
			active: 0,
			lock: Promise.resolve(),
		};
	} catch (error) {
		await rm(parent, { recursive: true, force: true });
		throw error;
	}
}

async function acquireSandboxBaseline(
	repository: PooledGitRepository,
	authorEnvironment: Readonly<Record<string, string>>,
): Promise<string> {
	return withRepositoryLock(repository, async () => {
		if (repository.commit && repository.version) {
			const [current, indexed] = await Promise.all([
				repository.versions.validate(repository.version),
				sandboxIndexChanges(repository),
			]);
			if (!current.expired && indexed.length === 0) return repository.commit;
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			const version = await repository.versions.capture([{ path: repository.sourceRoot, scope: "tree_content" }]);
			let retained = false;
			try {
				const changes = repository.version ? repository.versions.changesSince(repository.version) : undefined;
				const indexed = repository.commit ? await sandboxIndexChanges(repository) : [];
				const changedPaths = [...new Set([...(changes?.paths ?? []), ...indexed])];
				const changedPathspecs =
					repository.commit && changes && !changes.uncertain
						? incrementalPathspecs(repository.sourceRoot, changedPaths)
						: undefined;
				if (repository.commit && changedPathspecs) {
					await git(
						repository.gitBinary,
						[
							"--git-dir",
							repository.repository,
							"--work-tree",
							repository.sourceRoot,
							"read-tree",
							repository.commit,
						],
						repository.sourceRoot,
					);
					if (changedPathspecs.length) {
						await git(
							repository.gitBinary,
							[
								"--git-dir",
								repository.repository,
								"--work-tree",
								repository.sourceRoot,
								"add",
								"-f",
								"-A",
								"--",
								...changedPathspecs,
							],
							repository.sourceRoot,
						);
					}
				} else {
					await git(
						repository.gitBinary,
						["--git-dir", repository.repository, "--work-tree", repository.sourceRoot, "read-tree", "--empty"],
						repository.sourceRoot,
					);
					await git(
						repository.gitBinary,
						[
							"--git-dir",
							repository.repository,
							"--work-tree",
							repository.sourceRoot,
							"add",
							"-f",
							"-A",
							"--",
							...snapshotPathspecs(),
						],
						repository.sourceRoot,
					);
				}
				const tree = (
					await git(
						repository.gitBinary,
						["--git-dir", repository.repository, "--work-tree", repository.sourceRoot, "write-tree"],
						repository.sourceRoot,
					)
				)
					.toString("utf8")
					.trim();
				if (repository.commit) {
					const previousTree = (
						await git(
							repository.gitBinary,
							["--git-dir", repository.repository, "show", "-s", "--format=%T", repository.commit],
							repository.parent,
						)
					)
						.toString("utf8")
						.trim();
					if (tree === previousTree) {
						if ((await repository.versions.validate(version)).expired) continue;
						replaceSandboxVersion(repository, version);
						retained = true;
						return repository.commit;
					}
				}
				const commit = (
					await git(
						repository.gitBinary,
						[
							"--git-dir",
							repository.repository,
							"commit-tree",
							tree,
							...(repository.commit ? ["-p", repository.commit] : []),
							"-m",
							"speculative baseline",
						],
						repository.parent,
						authorEnvironment,
					)
				)
					.toString("utf8")
					.trim();
				if ((await repository.versions.validate(version)).expired) continue;
				await git(
					repository.gitBinary,
					["--git-dir", repository.repository, "update-ref", "refs/heads/baseline", commit],
					repository.parent,
				);
				repository.commit = commit;
				replaceSandboxVersion(repository, version);
				retained = true;
				return commit;
			} finally {
				if (!retained) version.release();
			}
		}
		throw new Error("workspace changed repeatedly while preparing sandbox baseline");
	});
}

async function sandboxIndexChanges(repository: PooledGitRepository): Promise<string[]> {
	const prefix = ["--git-dir", repository.repository, "--work-tree", repository.sourceRoot];
	const [tracked, untracked] = await Promise.all([
		git(
			repository.gitBinary,
			[...prefix, "diff-files", "--name-only", "--no-renames", "-z", "--"],
			repository.sourceRoot,
		),
		git(
			repository.gitBinary,
			[...prefix, "ls-files", "--others", "--exclude-standard", "-z", "--"],
			repository.sourceRoot,
		),
	]);
	return [...new Set([...parseNullList(tracked), ...parseNullList(untracked)])].map((file) =>
		path.resolve(repository.sourceRoot, file),
	);
}

async function withRepositoryLock<T>(repository: PooledGitRepository, run: () => Promise<T>): Promise<T> {
	const previous = repository.lock;
	let release: () => void = () => {};
	repository.lock = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await run();
	} finally {
		release();
	}
}

function releaseSandboxRepository(repository: PooledGitRepository): void {
	repository.active = Math.max(0, repository.active - 1);
	if (repository.active > 0 || repository.idleTimer) return;
	repository.idleTimer = setTimeout(() => {
		if (repository.active > 0) return;
		sandboxRepositories.delete(`${pathKey(repository.sourceRoot)}\0${repository.gitBinary}`);
		repository.version?.release();
		repository.version = undefined;
		repository.versions.close();
		void rm(repository.parent, { recursive: true, force: true }).catch(() => undefined);
	}, SANDBOX_REPOSITORY_IDLE_MS);
	repository.idleTimer.unref?.();
}

export async function closeWorkspaceSandboxPools(): Promise<void> {
	const pending = [...sandboxRepositories.values()];
	sandboxRepositories.clear();
	for (const item of pending) {
		const repository = await item.catch(() => undefined);
		if (!repository) continue;
		if (repository.idleTimer) clearTimeout(repository.idleTimer);
		repository.version?.release();
		repository.version = undefined;
		repository.versions.close();
		await rm(repository.parent, { recursive: true, force: true });
	}
}

function replaceSandboxVersion(repository: PooledGitRepository, next: ResourceVersionToken): void {
	const previous = repository.version;
	repository.version = next;
	if (previous !== next) previous?.release();
}

function incrementalPathspecs(root: string, changedPaths: readonly string[]): string[] | undefined {
	const result = new Set<string>();
	for (const changedPath of changedPaths) {
		const relative = slash(path.relative(root, path.resolve(changedPath)) || ".");
		if (relative === ".") return undefined;
		if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return undefined;
		if (relative.split("/").some((segment) => (SNAPSHOT_EXCLUDES as readonly string[]).includes(segment))) continue;
		result.add(relative);
	}
	return [...result].sort();
}

function snapshotPathspecs(): string[] {
	return [".", ...SNAPSHOT_EXCLUDES.flatMap((item) => [`:(glob,exclude)**/${item}`, `:(glob,exclude)**/${item}/**`])];
}

function pathKey(value: string): string {
	const normalized = path.resolve(value).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
			workspace.processRoot,
		);
	} catch {
		// The private parent removal below is the final cleanup boundary.
	}
	await rm(workspace.processRoot, { recursive: true, force: true });
	releaseSandboxRepository(workspace.pool);
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
