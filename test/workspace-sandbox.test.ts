import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, SettleToolCallResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiActionKey } from "../src/common.ts";
import {
	closeWorkspaceSandboxPools,
	commitSandboxDelta,
	createWorkspaceSandbox,
	prepareSandboxWorkspace,
	withSandboxWorkspace,
} from "../src/workspace-sandbox.ts";

afterEach(async () => {
	await closeWorkspaceSandboxPools();
});

const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });
const editParameters = Type.Object({
	path: Type.String(),
	edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
});
const bashParameters = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });
const itWithSymlink = process.platform === "win32" ? it.skip : it;
const itWithPosixShell = process.platform === "win32" ? it.skip : it;

const writeTool: AgentTool<typeof writeParameters> = {
	name: "write",
	label: "write",
	description: "write",
	parameters: writeParameters,
	async execute(_callID, args) {
		await mkdir(path.dirname(args.path), { recursive: true });
		await writeFile(args.path, args.content, "utf8");
		return { content: [{ type: "text", text: `Successfully wrote ${args.path}` }], details: undefined };
	},
};

const editTool: AgentTool<typeof editParameters> = {
	name: "edit",
	label: "edit",
	description: "edit",
	parameters: editParameters,
	async execute(_callID, args) {
		let content = await readFile(args.path, "utf8");
		for (const edit of args.edits) {
			if (!content.includes(edit.oldText)) throw new Error("oldText missing");
			content = content.replace(edit.oldText, edit.newText);
		}
		await writeFile(args.path, content, "utf8");
		return { content: [{ type: "text", text: `Successfully edited ${args.path}` }], details: { path: args.path } };
	},
};

const bashTool: AgentTool<typeof bashParameters> = {
	name: "bash",
	label: "bash",
	description: "bash",
	parameters: bashParameters,
	async execute() {
		throw new Error("The real bash tool must not run during speculation");
	},
};

describe("workspace ExecutionWorld", () => {
	it("stages write output without touching the workspace and adopts after base validation", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-write-test-"));
		try {
			const args = { path: "nested/created.txt", content: "from sandbox\n" };
			const action = requiredAction("write", args, root);
			const sandbox = createWorkspaceSandbox();
			const execution = await sandbox.fork({
				mode: "file_mutation",
				cwd: root,
				tool: writeTool,
				toolName: "write",
				args,
				action,
				callID: "spec-write",
				signal: new AbortController().signal,
			});

			await expect(stat(path.join(root, args.path))).rejects.toThrow();
			expect(execution.output.result.content).toEqual([
				{ type: "text", text: "Successfully wrote nested/created.txt" },
			]);
			expect(execution.state).toBe("ready");
			expect(execution.resources).toEqual(["nested/created.txt"]);
			expect(execution.capturedBytes).toBe(Buffer.byteLength("from sandbox\n"));
			expect(execution.executionMetrics.setupMs).toBeGreaterThanOrEqual(0);
			expect(execution.executionMetrics.captureMs).toBeGreaterThanOrEqual(0);
			await execution.adopt();
			expect(execution.state).toBe("adopted");
			expect(await readFile(path.join(root, args.path), "utf8")).toBe("from sandbox\n");
			expect(execution.adoptionMetrics).toEqual(
				expect.objectContaining({ resourcesValidated: 1, resourcesAdopted: 1, bytesValidated: 0 }),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("joins concurrent adoption calls and applies a world branch exactly once", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-world-adopt-once-"));
		try {
			const args = { path: "once.txt", content: "one adoption\n" };
			const world = createWorkspaceSandbox();
			const branch = await world.fork({
				mode: "file_mutation",
				cwd: root,
				tool: writeTool,
				toolName: "write",
				args,
				action: requiredAction("write", args, root),
				callID: "spec-adopt-once",
				signal: new AbortController().signal,
			});

			const first = branch.adopt();
			const second = branch.adopt();
			expect(second).toBe(first);
			expect(branch.state).toBe("adopting");
			await expect(Promise.all([first, second])).resolves.toEqual([branch.output, branch.output]);
			expect(await branch.adopt()).toBe(branch.output);
			expect(branch.state).toBe("adopted");
			expect(await readFile(path.join(root, "once.txt"), "utf8")).toBe("one adoption\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stages edit output but rejects adoption after a concurrent real-file change", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-edit-test-"));
		try {
			const target = path.join(root, "file.txt");
			await writeFile(target, "hello\n", "utf8");
			const args = { path: "file.txt", edits: [{ oldText: "hello", newText: "hi" }] };
			const action = requiredAction("edit", args, root);
			const sandbox = createWorkspaceSandbox();
			const execution = await sandbox.fork({
				mode: "file_mutation",
				cwd: root,
				tool: editTool,
				toolName: "edit",
				args,
				action,
				callID: "spec-edit",
				signal: new AbortController().signal,
			});

			expect(await readFile(target, "utf8")).toBe("hello\n");
			expect(execution.output.result.details).toEqual({ path: "file.txt" });
			await writeFile(target, "actor changed\n", "utf8");
			const adoption = execution.adopt();
			await expect(adoption).rejects.toThrow("resource changed before adoption");
			expect(execution.state).toBe("failed");
			expect(execution.adopt()).toBe(adoption);
			expect(await readFile(target, "utf8")).toBe("actor changed\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses a private repository without changing an existing workspace Git index or branch", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-git-test-"));
		try {
			await runGit(["init", "-b", "actor-branch"], root);
			await writeFile(path.join(root, "dirty.txt"), "dirty working tree", "utf8");
			const beforeStatus = await runGit(["status", "--short"], root);
			const beforeBranch = await runGit(["branch", "--show-current"], root);
			const args = { path: "created.txt", content: "staged" };
			const execution = await createWorkspaceSandbox().fork({
				mode: "file_mutation",
				cwd: root,
				tool: writeTool,
				toolName: "write",
				args,
				action: requiredAction("write", args, root),
				callID: "spec-private-git",
				signal: new AbortController().signal,
			});

			expect(execution.backend).toBe("git_worktree");
			expect(await runGit(["status", "--short"], root)).toBe(beforeStatus);
			expect(await runGit(["branch", "--show-current"], root)).toBe(beforeBranch);
			await expect(stat(path.join(root, "created.txt"))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("dispatches by registered world mode instead of hard-coded tool names", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-custom-world-tool-"));
		try {
			const args = { path: "custom.txt", content: "custom mode\n" };
			const action = { ...requiredAction("write", args, root), tool: "custom_mutation" };
			const customWriteTool: AgentTool<typeof writeParameters> = { ...writeTool, name: "custom_mutation" };
			const branch = await createWorkspaceSandbox().fork({
				mode: "file_mutation",
				cwd: root,
				tool: customWriteTool,
				toolName: "custom_mutation",
				args,
				action,
				callID: "spec-custom-mode",
				signal: new AbortController().signal,
			});

			await expect(stat(path.join(root, args.path))).rejects.toThrow();
			await branch.adopt();
			expect(await readFile(path.join(root, args.path), "utf8")).toBe("custom mode\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("runs bash through an explicit provider in a copied cwd without workspace pollution", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-bash-test-"));
		try {
			await writeFile(path.join(root, "input.txt"), "hello", "utf8");
			await writeFile(path.join(root, "delete.txt"), "remove me", "utf8");
			const sandbox = createWorkspaceSandbox({
				shell: "/bin/bash",
				processRunner: async ({ command, shell, cwd, processRoot, sourceRoot, signal }) => {
					expect(shell).toBe("/bin/bash");
					expect(path.dirname(cwd)).toBe(processRoot);
					expect(sourceRoot).toBe(root);
					expect(processRoot).not.toBe(root);
					await runNodeScript(command, cwd, signal);
					return {
						result: { content: [{ type: "text", text: `sandbox cwd: ${cwd}` }], details: undefined },
						isError: false,
					};
				},
			});
			const script = [
				"const fs = require('node:fs')",
				"fs.writeFileSync('sandbox-created.txt', fs.readFileSync('input.txt', 'utf8'))",
				"fs.writeFileSync('input.txt', 'changed')",
				"fs.unlinkSync('delete.txt')",
				"console.log(process.cwd())",
			].join(";");
			const args = { command: script, timeout: 5 };
			const execution = await sandbox.fork({
				mode: "workspace_snapshot",
				cwd: root,
				tool: bashTool,
				toolName: "bash",
				args,
				action: requiredAction("bash", args, root),
				callID: "spec-bash",
				signal: new AbortController().signal,
			});

			expect(sandbox.supports("workspace_snapshot")).toBe(true);
			expect(execution.output.result.content[0]).toEqual({ type: "text", text: `sandbox cwd: ${root}` });
			await expect(stat(path.join(root, "sandbox-created.txt"))).rejects.toThrow();
			expect(await readFile(path.join(root, "input.txt"), "utf8")).toBe("hello");
			expect(await readFile(path.join(root, "delete.txt"), "utf8")).toBe("remove me");
			expect(execution.resources).toEqual(["delete.txt", "input.txt", "sandbox-created.txt"]);
			expect(await execution.adopt()).toBe(execution.output);
			expect(await readFile(path.join(root, "sandbox-created.txt"), "utf8")).toBe("hello");
			expect(await readFile(path.join(root, "input.txt"), "utf8")).toBe("changed");
			await expect(stat(path.join(root, "delete.txt"))).rejects.toThrow();
			expect(createWorkspaceSandbox().supports("workspace_snapshot")).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);

	it("validates every base before applying any multi-file change", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-conflict-test-"));
		try {
			await writeFile(path.join(root, "a.txt"), "a0", "utf8");
			await writeFile(path.join(root, "b.txt"), "b0", "utf8");
			const sandbox = createWorkspaceSandbox({
				processRunner: async ({ cwd }) => {
					await writeFile(path.join(cwd, "a.txt"), "a1", "utf8");
					await writeFile(path.join(cwd, "b.txt"), "b1", "utf8");
					return settlement("changed two files");
				},
			});
			const args = { command: "unused" };
			const execution = await sandbox.fork({
				mode: "workspace_snapshot",
				cwd: root,
				tool: bashTool,
				toolName: "bash",
				args,
				action: requiredAction("bash", args, root),
				callID: "spec-conflict",
				signal: new AbortController().signal,
			});
			await writeFile(path.join(root, "b.txt"), "actor", "utf8");

			await expect(execution.adopt()).rejects.toThrow("resource changed before adoption: b.txt");
			expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("a0");
			expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("actor");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not create target directories when another baseline is stale", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-validation-staging-test-"));
		try {
			const stale = path.join(root, "z-stale.txt");
			const nested = path.join(root, "a-new", "created.txt");
			await writeFile(stale, "changed", "utf8");
			const execution: Parameters<typeof commitSandboxDelta>[0] = {
				output: settlement("staged"),
				changes: [
					{ root, target: nested, resource: "a-new/created.txt", after: Buffer.from("created") },
					{
						root,
						target: stale,
						resource: "z-stale.txt",
						before: Buffer.from("original"),
						after: Buffer.from("adopted"),
					},
				],
			};

			await expect(commitSandboxDelta(execution)).rejects.toThrow("resource changed before adoption");
			await expect(stat(path.dirname(nested))).rejects.toThrow();
			expect(await readFile(stale, "utf8")).toBe("changed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("serializes competing commits and accepts only one shared baseline", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-commit-lock-test-"));
		const target = path.join(root, "value.txt");
		try {
			await writeFile(target, "original\n", "utf8");
			const executions = ["first\n", "second\n"].map((content): Parameters<typeof commitSandboxDelta>[0] => ({
				output: settlement(content.trim()),
				changes: [
					{
						root,
						target,
						resource: "value.txt",
						before: Buffer.from("original\n"),
						after: Buffer.from(content),
					},
				],
			}));

			const results = await Promise.allSettled(executions.map(commitSandboxDelta));

			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
			expect(["first\n", "second\n"]).toContain(await readFile(target, "utf8"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rolls back already applied paths when a later adoption write fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-rollback-test-"));
		try {
			const first = path.join(root, "a.txt");
			const second = path.join(root, "b.txt");
			await writeFile(first, "a0", "utf8");
			await writeFile(second, "b0", "utf8");
			const execution: Parameters<typeof commitSandboxDelta>[0] = {
				output: settlement("staged"),
				changes: [
					{
						root,
						target: first,
						resource: "a.txt",
						before: Buffer.from("a0"),
						after: Buffer.from("a1"),
					},
					{
						root,
						target: second,
						resource: "b.txt",
						before: Buffer.from("b0"),
						after: null as unknown as Uint8Array,
					},
				],
			};

			await expect(commitSandboxDelta(execution)).rejects.toThrow();
			expect(await readFile(first, "utf8")).toBe("a0");
			expect(await readFile(second, "utf8")).toBe("b0");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	if (process.platform !== "win32") {
		it("preserves source permission bits that Git snapshots do not represent", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-mode-test-"));
			const target = path.join(root, "script.sh");
			try {
				await writeFile(target, "#!/bin/sh\necho old\n", { mode: 0o640 });
				const args = { path: "script.sh", edits: [{ oldText: "old", newText: "new" }] };
				const sandbox = createWorkspaceSandbox();
				const execution = await sandbox.fork({
					mode: "file_mutation",
					cwd: root,
					tool: editTool,
					toolName: "edit",
					args,
					action: requiredAction("edit", args, root),
					callID: "spec-mode",
					signal: new AbortController().signal,
				});

				await execution.adopt();
				expect((await stat(target)).mode & 0o777).toBe(0o640);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}

	itWithSymlink("fails closed on source symlinks before invoking a mutation tool", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-symlink-test-"));
		const outside = await mkdtemp(path.join(os.tmpdir(), "pi-spec-symlink-outside-"));
		try {
			await symlink(outside, path.join(root, "linked"), "dir");
			const args = { path: "linked/out.txt", content: "no" };
			await expect(
				createWorkspaceSandbox().fork({
					mode: "file_mutation",
					cwd: root,
					tool: writeTool,
					toolName: "write",
					args,
					action: requiredAction("write", args, root),
					callID: "spec-symlink",
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("contains symlink");
			await expect(stat(path.join(outside, "out.txt"))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	itWithSymlink("rejects a symlink created inside the staged workspace", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-created-symlink-test-"));
		try {
			const sandbox = createWorkspaceSandbox({
				processRunner: async ({ cwd }) => {
					await symlink("missing-target", path.join(cwd, "created-link"));
					return settlement("created symlink");
				},
			});
			const args = { command: "unused" };
			await expect(
				sandbox.fork({
					mode: "workspace_snapshot",
					cwd: root,
					tool: bashTool,
					toolName: "bash",
					args,
					action: requiredAction("bash", args, root),
					callID: "spec-created-symlink",
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("contains symlink");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("cleans the private worktree after process execution fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-cleanup-test-"));
		let stagedRoot = "";
		try {
			const sandbox = createWorkspaceSandbox({
				processRunner: async ({ cwd }) => {
					stagedRoot = cwd;
					throw new Error("runner failed");
				},
			});
			const args = { command: "unused" };
			await expect(
				sandbox.fork({
					mode: "workspace_snapshot",
					cwd: root,
					tool: bashTool,
					toolName: "bash",
					args,
					action: requiredAction("bash", args, root),
					callID: "spec-cleanup",
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("runner failed");
			expect(stagedRoot).not.toBe("");
			await expect(stat(stagedRoot)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("cleans the private worktree after process execution is aborted", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-abort-test-"));
		const controller = new AbortController();
		let stagedRoot = "";
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		try {
			const sandbox = createWorkspaceSandbox({
				processRunner: ({ cwd, signal }) =>
					new Promise((_resolve, reject) => {
						stagedRoot = cwd;
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						markStarted?.();
					}),
			});
			const args = { command: "unused" };
			const execution = sandbox.fork({
				mode: "workspace_snapshot",
				cwd: root,
				tool: bashTool,
				toolName: "bash",
				args,
				action: requiredAction("bash", args, root),
				callID: "spec-abort",
				signal: controller.signal,
			});
			await started;
			controller.abort();
			await expect(execution).rejects.toThrow("aborted");
			await expect(stat(stagedRoot)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects mutation paths outside the workspace before invoking the tool", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-escape-test-"));
		try {
			const sandbox = createWorkspaceSandbox();
			const args = { path: "../outside.txt", content: "no" };
			await expect(
				sandbox.fork({
					mode: "file_mutation",
					cwd: root,
					tool: writeTool,
					toolName: "write",
					args,
					action: {
						key: "invalid",
						hash: "invalid",
						tool: "write",
						input: args,
						resources: ["../outside.txt"],
						execution: "sandbox",
						semanticsEpoch: "test.write.v1",
						schemaHash: "",
					},
					callID: "spec-escape",
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("escapes workspace");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reuses one private repository while keeping action worktrees isolated", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-pool-test-"));
		try {
			await writeFile(path.join(root, "value.txt"), "one\n");
			const contexts = [] as Array<{ processRoot: string; sandboxRoot: string }>;
			await withSandboxWorkspace(root, async (workspace) => {
				contexts.push({ processRoot: workspace.processRoot, sandboxRoot: workspace.sandboxRoot });
				expect(await readFile(path.join(workspace.sandboxRoot, "value.txt"), "utf8")).toBe("one\n");
			});
			await withSandboxWorkspace(root, async (workspace) => {
				contexts.push({ processRoot: workspace.processRoot, sandboxRoot: workspace.sandboxRoot });
			});

			expect(contexts[0]?.processRoot).not.toBe(contexts[1]?.processRoot);
			expect(path.dirname(contexts[0]!.processRoot)).toBe(path.dirname(contexts[1]!.processRoot));
			expect(contexts[0]?.sandboxRoot).not.toBe(contexts[1]?.sandboxRoot);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("waits for active worktrees before closing the shared pool", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-pool-close-test-"));
		let poolRoot = "";
		let markStarted: (() => void) | undefined;
		let releaseAction: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const actionGate = new Promise<void>((resolve) => {
			releaseAction = resolve;
		});
		let execution: Promise<void> | undefined;
		try {
			execution = withSandboxWorkspace(root, async (workspace) => {
				poolRoot = path.dirname(workspace.processRoot);
				markStarted?.();
				await actionGate;
			});
			await started;

			let closed = false;
			const closing = closeWorkspaceSandboxPools().then(() => {
				closed = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(closed).toBe(false);
			await expect(stat(poolRoot)).resolves.toBeDefined();

			releaseAction?.();
			await execution;
			await closing;
			expect(closed).toBe(true);
			await expect(stat(poolRoot)).rejects.toThrow();
		} finally {
			releaseAction?.();
			await execution?.catch(() => undefined);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refreshes a pooled baseline even before filesystem watcher delivery", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-pool-refresh-test-"));
		try {
			await writeFile(path.join(root, "value.txt"), "one\n");
			await withSandboxWorkspace(root, async (workspace) => {
				expect(await readFile(path.join(workspace.sandboxRoot, "value.txt"), "utf8")).toBe("one\n");
			});
			await writeFile(path.join(root, "value.txt"), "two\n");
			await writeFile(path.join(root, "added.txt"), "added\n");

			await withSandboxWorkspace(root, async (workspace) => {
				expect(await readFile(path.join(workspace.sandboxRoot, "value.txt"), "utf8")).toBe("two\n");
				expect(await readFile(path.join(workspace.sandboxRoot, "added.txt"), "utf8")).toBe("added\n");
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("excludes atomic-adoption staging files from workspace snapshots", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-staging-exclusion-test-"));
		try {
			await writeFile(path.join(root, "value.txt"), "real\n");
			await writeFile(path.join(root, ".pi-speculative-in-flight.tmp"), "staged\n");

			await withSandboxWorkspace(root, async (workspace) => {
				expect(await readFile(path.join(workspace.sandboxRoot, "value.txt"), "utf8")).toBe("real\n");
				await expect(stat(path.join(workspace.sandboxRoot, ".pi-speculative-in-flight.tmp"))).rejects.toThrow();
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	itWithPosixShell(
		"batches large incremental path lists before invoking git add",
		async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-path-batch-test-"));
			const wrapper = path.join(root, "git-wrapper");
			try {
				await writeFile(
					wrapper,
					[
						"#!/bin/sh",
						"bytes=0",
						"is_add=0",
						'for argument in "$@"; do',
						'  argument_bytes=$(printf %s "$argument" | wc -c)',
						"  bytes=$((bytes + argument_bytes + 1))",
						'  if [ "$argument" = "add" ]; then is_add=1; fi',
						"done",
						'if [ "$is_add" = "1" ] && [ "$bytes" -gt 49152 ]; then',
						'  echo "oversized git add invocation: $bytes bytes" >&2',
						"  exit 97",
						"fi",
						'exec git "$@"',
					].join("\n"),
					"utf8",
				);
				await chmod(wrapper, 0o700);
				const files = Array.from(
					{ length: 700 },
					(_, index) => `files/path-${String(index).padStart(4, "0")}-${"deliberately-long-".repeat(4)}name.txt`,
				);
				await mkdir(path.join(root, "files"));
				await Promise.all(files.map((file) => writeFile(path.join(root, file), "before\n")));
				await prepareSandboxWorkspace(root, { gitBinary: wrapper });
				await Promise.all(files.map((file) => writeFile(path.join(root, file), "after\n")));

				await withSandboxWorkspace(
					root,
					async (workspace) => {
						expect(await readFile(path.join(workspace.sandboxRoot, files.at(-1)!), "utf8")).toBe("after\n");
					},
					wrapper,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		15_000,
	);

	itWithPosixShell("retries incremental staging when an untracked file disappears during git add", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-transient-path-test-"));
		const wrapper = path.join(root, "git-wrapper");
		try {
			await writeFile(
				wrapper,
				[
					"#!/bin/sh",
					"work_tree=",
					"previous=",
					"remove_transient=0",
					'for argument in "$@"; do',
					'  if [ "$previous" = "--work-tree" ]; then work_tree="$argument"; fi',
					'  if [ "$argument" = "transient.tmp" ]; then remove_transient=1; fi',
					'  previous="$argument"',
					"done",
					'if [ "$remove_transient" = "1" ]; then rm -f "$work_tree/transient.tmp"; fi',
					'exec git "$@"',
				].join("\n"),
				"utf8",
			);
			await chmod(wrapper, 0o700);
			await writeFile(path.join(root, "value.txt"), "before\n");
			await prepareSandboxWorkspace(root, { gitBinary: wrapper });
			await writeFile(path.join(root, "value.txt"), "after\n");
			await writeFile(path.join(root, "transient.tmp"), "temporary\n");

			await withSandboxWorkspace(
				root,
				async (workspace) => {
					expect(await readFile(path.join(workspace.sandboxRoot, "value.txt"), "utf8")).toBe("after\n");
					await expect(stat(path.join(workspace.sandboxRoot, "transient.tmp"))).rejects.toThrow();
				},
				wrapper,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refreshes a warmed workspace before it is claimed after a source change", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-prewarm-refresh-test-"));
		try {
			await writeFile(path.join(root, "value.txt"), "before\n");
			await prepareSandboxWorkspace(root);
			await writeFile(path.join(root, "value.txt"), "after\n");

			await withSandboxWorkspace(root, async (workspace) => {
				expect(await readFile(path.join(workspace.sandboxRoot, "value.txt"), "utf8")).toBe("after\n");
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("allows parallel actions to claim a warmed workspace without cross-contamination", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-pool-parallel-test-"));
		try {
			await writeFile(path.join(root, "value.txt"), "base\n");
			await prepareSandboxWorkspace(root);
			const values = await Promise.all(
				["first\n", "second\n"].map((content) =>
					withSandboxWorkspace(root, async (workspace) => {
						await writeFile(path.join(workspace.sandboxRoot, "value.txt"), content);
						await new Promise((resolve) => setTimeout(resolve, 10));
						return {
							root: workspace.sandboxRoot,
							content: await readFile(path.join(workspace.sandboxRoot, "value.txt"), "utf8"),
						};
					}),
				),
			);

			expect(new Set(values.map((value) => value.root)).size).toBe(2);
			expect(values.map((value) => value.content).sort()).toEqual(["first\n", "second\n"]);
			expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("base\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an already-cancelled workspace preparation", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-prewarm-cancelled-test-"));
		const controller = new AbortController();
		controller.abort(new Error("prewarm cancelled"));
		try {
			await expect(prepareSandboxWorkspace(root, { signal: controller.signal })).rejects.toThrow(
				"prewarm cancelled",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("warms process isolation only for workspace-snapshot mode", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-prewarm-process-test-"));
		let processPreparations = 0;
		const sandbox = createWorkspaceSandbox({
			processRunner: async () => settlement("unused"),
			prepareProcess: async () => {
				processPreparations++;
			},
		});
		try {
			await sandbox.prepare?.({ cwd: root, modes: ["file_mutation"] });
			expect(processPreparations).toBe(0);
			await sandbox.prepare?.({ cwd: root, modes: ["workspace_snapshot"] });
			expect(processPreparations).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function requiredAction(tool: string, args: unknown, cwd: string) {
	const action = buildPiActionKey(tool, args, cwd);
	if (!action) throw new Error(`Expected action key for ${tool}`);
	return action;
}

function settlement(text: string): SettleToolCallResult {
	return {
		result: { content: [{ type: "text", text }], details: undefined },
		isError: false,
	};
}

function runNodeScript(command: string, cwd: string, signal: AbortSignal): Promise<SettleToolCallResult> {
	return new Promise((resolve, reject) => {
		execFile(process.execPath, ["-e", command], { cwd, signal }, (error, stdout, stderr) => {
			if (error) {
				reject(error);
				return;
			}
			resolve({
				result: { content: [{ type: "text", text: `${stdout}${stderr}`.trim() }], details: undefined },
				isError: false,
			});
		});
	});
}

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr));
				return;
			}
			resolve(stdout);
		});
	});
}
