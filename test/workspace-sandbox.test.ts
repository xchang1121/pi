import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, SettleToolCallResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildPiActionKey } from "../src/common.ts";
import { createWorkspaceSandbox } from "../src/workspace-sandbox.ts";

const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });
const editParameters = Type.Object({
	path: Type.String(),
	edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
});
const bashParameters = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });

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

describe("M3 workspace sandbox", () => {
	it("stages write output without touching the workspace and adopts after base validation", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-write-test-"));
		try {
			const args = { path: "nested/created.txt", content: "from sandbox\n" };
			const action = requiredAction("write", args, root);
			const sandbox = createWorkspaceSandbox();
			const execution = await sandbox.execute({
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
			await sandbox.adopt(execution);
			expect(await readFile(path.join(root, args.path), "utf8")).toBe("from sandbox\n");
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
			const execution = await sandbox.execute({
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
			await expect(sandbox.adopt(execution)).rejects.toThrow("resource changed before adoption");
			expect(await readFile(target, "utf8")).toBe("actor changed\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("runs bash through an explicit provider in a copied cwd without workspace pollution", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-bash-test-"));
		try {
			await writeFile(path.join(root, "input.txt"), "hello", "utf8");
			const sandbox = createWorkspaceSandbox({
				processRunner: async ({ command, cwd, signal }) => {
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
				"console.log(process.cwd())",
			].join(";");
			const args = { command: script, timeout: 5 };
			const execution = await sandbox.execute({
				cwd: root,
				tool: bashTool,
				toolName: "bash",
				args,
				action: requiredAction("bash", args, root),
				callID: "spec-bash",
				signal: new AbortController().signal,
			});

			expect(sandbox.supports("bash")).toBe(true);
			expect(execution.output.result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("workspace"),
			});
			await expect(stat(path.join(root, "sandbox-created.txt"))).rejects.toThrow();
			expect(await sandbox.adopt(execution)).toBe(execution.output);
			expect(createWorkspaceSandbox().supports("bash")).toBe(false);
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
				sandbox.execute({
					cwd: root,
					tool: writeTool,
					toolName: "write",
					args,
					action: {
						key: "invalid",
						hash: "invalid",
						tool: "write",
						resources: ["../outside.txt"],
						execution: "sandbox",
					},
					callID: "spec-escape",
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("escapes workspace");
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
