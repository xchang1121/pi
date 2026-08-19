import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiActionKey } from "../src/action-semantics.ts";
import {
	type ContainerRuntimeInvocation,
	type ContainerRuntimeInvocationResult,
	createContainerSandboxProcessBackend,
	invokeContainerRuntime,
} from "../src/container-sandbox.ts";
import { createWorkspaceSandbox } from "../src/workspace-sandbox.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("container sandbox backend", () => {
	it("selects Docker or Podman without pulling and fingerprints the immutable image", async () => {
		const calls: ContainerRuntimeInvocation[] = [];
		const backend = createContainerSandboxProcessBackend({
			image: "pi-worker:test",
			guestShell: "/usr/bin/bash",
			invoker: async (input) => {
				calls.push(input);
				if (input.binaryPath === "docker") throw new Error("docker missing");
				if (input.args[0] === "version") return result("25.0");
				return result("sha256:worker|linux|arm64");
			},
		});

		await expect(backend.check()).resolves.toMatchObject({
			backend: "container",
			state: "ready",
			source: "podman",
			fingerprint: "container:podman:sha256:worker:linux:arm64:/usr/bin/bash",
		});
		expect(calls.some((call) => call.args[0] === "pull")).toBe(false);
		await backend.dispose();
	});

	it("recycles an isolated slot while removing branch state and never mounting a cross-OS actor source", async () => {
		const workerRoot = await temporaryRoot("pi-container-worker-test-");
		const sourceRoot = await temporaryRoot("pi-container-source-test-");
		const calls: ContainerRuntimeInvocation[] = [];
		const backend = createContainerSandboxProcessBackend({
			runtime: "docker",
			image: "pi-worker:test",
			workerRoot,
			maxWorkers: 1,
			invoker: fakeRuntime(calls),
		});

		await backend.prepare({});
		const first = await backend.open({ parent: workerRoot, signal: new AbortController().signal });
		const firstWorkspace = path.join(first.processRoot, "workspace");
		await mkdir(firstWorkspace);
		await writeFile(path.join(first.processRoot, "unadopted-state"), "must disappear");
		const settlement = await first.execute(commandInput(sourceRoot, first.processRoot, firstWorkspace));
		expect(settlement).toMatchObject({ isError: false });
		await first.close();

		const second = await backend.open({ parent: workerRoot, signal: new AbortController().signal });
		expect(second.processRoot).toBe(first.processRoot);
		await expect(readFile(path.join(second.processRoot, "unadopted-state"))).rejects.toThrow();

		const create = calls.find((call) => call.args[0] === "create");
		expect(create?.args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL"]));
		expect(create?.args.join(" ")).toContain(first.processRoot);
		expect(create?.args.join(" ")).not.toContain(sourceRoot);
		const execute = calls.find((call) => call.args[0] === "exec");
		expect(execute?.args).toEqual(
			expect.arrayContaining(["--workdir", "/pi/workspace", "/bin/bash", "-c", "printf ok"]),
		);
		expect(execute?.args.some((value) => value.startsWith("PATH="))).toBe(false);
		expect(execute?.args).toEqual(expect.arrayContaining(["HOME=/tmp", "PI_SPECULATIVE_SANDBOX=container"]));
		expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
		expect(calls.filter((call) => call.args[0] === "rm")).toHaveLength(1);

		await second.close();
		await backend.dispose();
	});

	it("leases distinct workers concurrently and wakes a bounded waiter", async () => {
		const workerRoot = await temporaryRoot("pi-container-concurrency-test-");
		const calls: ContainerRuntimeInvocation[] = [];
		const backend = createContainerSandboxProcessBackend({
			runtime: "podman",
			workerRoot,
			maxWorkers: 2,
			invoker: fakeRuntime(calls),
		});
		const signal = new AbortController().signal;
		const [first, second] = await Promise.all([
			backend.open({ parent: workerRoot, signal }),
			backend.open({ parent: workerRoot, signal }),
		]);
		expect(first.processRoot).not.toBe(second.processRoot);
		let thirdSettled = false;
		const thirdPending = backend.open({ parent: workerRoot, signal }).then((session) => {
			thirdSettled = true;
			return session;
		});
		await Promise.resolve();
		expect(thirdSettled).toBe(false);
		await first.close();
		const third = await thirdPending;
		expect(third.processRoot).toBe(first.processRoot);

		await Promise.all([second.close(), third.close()]);
		await backend.dispose();
	});

	it("destroys the branch container after timeout and abort", async () => {
		const workerRoot = await temporaryRoot("pi-container-cancel-test-");
		const calls: ContainerRuntimeInvocation[] = [];
		let abortExecution = false;
		const backend = createContainerSandboxProcessBackend({
			runtime: "docker",
			workerRoot,
			invoker: fakeRuntime(calls, async (_input) => {
				if (abortExecution) throw new Error("cancelled");
				return result("partial", { exitCode: null, timedOut: true });
			}),
		});
		const sourceRoot = await temporaryRoot("pi-container-cancel-source-");
		const first = await backend.open({ parent: workerRoot, signal: new AbortController().signal });
		const firstCwd = path.join(first.processRoot, "workspace");
		await mkdir(firstCwd);
		await expect(first.execute(commandInput(sourceRoot, first.processRoot, firstCwd))).resolves.toMatchObject({
			isError: true,
		});
		await first.close();

		abortExecution = true;
		const second = await backend.open({ parent: workerRoot, signal: new AbortController().signal });
		const secondCwd = path.join(second.processRoot, "workspace");
		await mkdir(secondCwd);
		await expect(second.execute(commandInput(sourceRoot, second.processRoot, secondCwd))).rejects.toThrow(
			"cancelled",
		);
		expect(calls.filter((call) => call.args[0] === "rm")).toHaveLength(2);

		await second.close();
		await backend.dispose();
	});

	it("maps a Windows worker image and Git Bash path without shell reinterpretation", async () => {
		const workerRoot = await temporaryRoot("pi-container-windows-image-test-");
		const sourceRoot = await temporaryRoot("pi-container-windows-source-test-");
		const calls: ContainerRuntimeInvocation[] = [];
		const backend = createContainerSandboxProcessBackend({
			runtime: "docker",
			workerRoot,
			invoker: fakeRuntime(calls, undefined, "windows"),
		});
		const session = await backend.open({ parent: workerRoot, signal: new AbortController().signal });
		const cwd = path.join(session.processRoot, "workspace", "nested");
		await mkdir(cwd, { recursive: true });

		await session.execute(commandInput(sourceRoot, session.processRoot, cwd));
		const create = calls.find((call) => call.args[0] === "create")!;
		const execute = calls.find((call) => call.args[0] === "exec")!;
		expect(create.args).toEqual(expect.arrayContaining(["--entrypoint", "cmd.exe", "pi-speculative-worker:latest"]));
		expect(create.args).not.toContain("--read-only");
		expect(create.args.some((value) => value.endsWith("dst=C:\\pi"))).toBe(true);
		expect(create.args.some((value) => value.endsWith(`dst=${sourceRoot}`))).toBe(true);
		expect(execute.args).toEqual(
			expect.arrayContaining([
				"--workdir",
				path.win32.join(sourceRoot, "nested"),
				"C:\\Program Files\\Git\\bin\\bash.exe",
				"-c",
				"printf ok",
			]),
		);

		await session.close();
		await backend.dispose();
	});

	it("mounts a same-OS private workspace at the actor's logical Linux path", async () => {
		const workerRoot = await temporaryRoot("pi-container-logical-root-test-");
		const calls: ContainerRuntimeInvocation[] = [];
		const backend = createContainerSandboxProcessBackend({
			runtime: "docker",
			workerRoot,
			invoker: fakeRuntime(calls),
		});
		const session = await backend.open({ parent: workerRoot, signal: new AbortController().signal });
		const workspaceRoot = path.join(session.processRoot, "workspace");
		const cwd = path.join(workspaceRoot, "nested");
		await mkdir(cwd, { recursive: true });
		await session.execute({
			...commandInput("/testbed", session.processRoot, cwd),
			workspaceRoot,
		});

		const create = calls.find((call) => call.args[0] === "create")!;
		const execute = calls.find((call) => call.args[0] === "exec")!;
		expect(create.args).toEqual(expect.arrayContaining(["--mount", `type=bind,src=${workspaceRoot},dst=/testbed`]));
		expect(execute.args).toEqual(expect.arrayContaining(["--workdir", "/testbed/nested"]));

		await session.close();
		await backend.dispose();
	});

	it("spawns and bounds the real container CLI subprocess boundary on Windows", async () => {
		const completed = await invokeContainerRuntime({
			binaryPath: process.execPath,
			args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
			timeoutMs: 5_000,
			maxOutputBytes: 16 * 1024,
		});
		expect(completed).toMatchObject({ exitCode: 0, stdout: "out", stderr: "err", timedOut: false });
		expect(completed.output).toContain("out");
		expect(completed.output).toContain("err");

		const truncated = await invokeContainerRuntime({
			binaryPath: process.execPath,
			args: ["-e", "process.stdout.write('x'.repeat(20000))"],
			timeoutMs: 5_000,
			maxOutputBytes: 1024,
		});
		expect(truncated.truncated).toBe(true);
		expect(Buffer.byteLength(truncated.output)).toBe(1024);

		const timedOut = await invokeContainerRuntime({
			binaryPath: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			timeoutMs: 100,
			maxOutputBytes: 16 * 1024,
		});
		expect(timedOut).toMatchObject({ exitCode: null, timedOut: true });

		const controller = new AbortController();
		const aborted = invokeContainerRuntime({
			binaryPath: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			signal: controller.signal,
			timeoutMs: 5_000,
			maxOutputBytes: 16 * 1024,
		});
		controller.abort(new Error("Windows invocation cancelled"));
		await expect(aborted).rejects.toThrow("Windows invocation cancelled");
	});

	it("composes the OCI backend with workspace capture, commit, and discard", async () => {
		const root = await temporaryRoot("pi-container-workspace-source-test-");
		const workerRoot = await temporaryRoot("pi-container-workspace-worker-test-");
		await writeFile(path.join(root, "input.txt"), "source\n");
		const calls: ContainerRuntimeInvocation[] = [];
		const backend = createContainerSandboxProcessBackend({
			runtime: "docker",
			workerRoot,
			invoker: workspaceRuntime(calls),
		});
		const sandbox = createWorkspaceSandbox({ processBackend: backend });
		const adopted = await runWorkspaceBranch(sandbox, root, "adopt");

		expect(await readFile(path.join(root, "input.txt"), "utf8")).toBe("source\n");
		await expect(stat(path.join(root, "adopted.txt"))).rejects.toThrow();
		expect(adopted.resources).toEqual(["adopted.txt", "input.txt"]);
		await adopted.commit();
		expect(await readFile(path.join(root, "input.txt"), "utf8")).toBe("container\n");
		expect(await readFile(path.join(root, "adopted.txt"), "utf8")).toBe("adopted\n");

		await runWorkspaceBranch(sandbox, root, "discard");
		await expect(stat(path.join(root, "discarded.txt"))).rejects.toThrow();
		expect(calls.some((call) => call.args[0] === "rm")).toBe(true);
		await sandbox.dispose?.();
	});
});

function fakeRuntime(
	calls: ContainerRuntimeInvocation[],
	execute: ((input: ContainerRuntimeInvocation) => Promise<ContainerRuntimeInvocationResult>) | undefined = async () =>
		result("ok"),
	imageOS: "linux" | "windows" = "linux",
) {
	return async (input: ContainerRuntimeInvocation): Promise<ContainerRuntimeInvocationResult> => {
		calls.push(input);
		if (input.args[0] === "version") return result("25.0");
		if (input.args[0] === "image") return result(`sha256:worker|${imageOS}|x86_64`);
		if (input.args[0] === "exec") return (execute ?? (async () => result("ok")))(input);
		return result(input.args[0] === "create" ? "container-id" : "");
	};
}

function workspaceRuntime(calls: ContainerRuntimeInvocation[]) {
	const roots = new Map<string, string>();
	return async (input: ContainerRuntimeInvocation): Promise<ContainerRuntimeInvocationResult> => {
		calls.push(input);
		if (input.args[0] === "version") return result("25.0");
		if (input.args[0] === "image") return result("sha256:worker|linux|x86_64");
		if (input.args[0] === "create") {
			const container = input.args[input.args.indexOf("--name") + 1]!;
			const mount = input.args.find((value) => value.startsWith("type=bind") && value.endsWith("dst=/pi"))!;
			roots.set(container, mount.slice("type=bind,src=".length, -",dst=/pi".length));
			return result(container);
		}
		if (input.args[0] === "exec") {
			const container = input.args.find((value) => roots.has(value))!;
			const root = roots.get(container)!;
			const guestCwd = input.args[input.args.indexOf("--workdir") + 1]!;
			const cwd = path.join(root, ...guestCwd.slice("/pi".length).split("/").filter(Boolean));
			const command = input.args.at(-1);
			if (command === "adopt") {
				await writeFile(path.join(cwd, "input.txt"), "container\n");
				await writeFile(path.join(cwd, "adopted.txt"), "adopted\n");
			} else {
				await writeFile(path.join(cwd, "discarded.txt"), "discarded\n");
			}
			return result(`${command} completed`);
		}
		if (input.args[0] === "rm") roots.delete(input.args.at(-1)!);
		return result("");
	};
}

const bashParameters = Type.Object({ command: Type.String() });
const bashTool: AgentTool<typeof bashParameters> = {
	name: "bash",
	label: "bash",
	description: "bash",
	parameters: bashParameters,
	async execute() {
		throw new Error("actor Bash must not run inside the speculative branch");
	},
};

async function runWorkspaceBranch(sandbox: ReturnType<typeof createWorkspaceSandbox>, root: string, command: string) {
	const args = { command };
	const action = buildPiActionKey("bash", args, root);
	if (!action) throw new Error("expected Bash action key");
	return sandbox.fork({
		mode: "workspace_snapshot",
		cwd: root,
		tool: bashTool,
		toolName: "bash",
		args,
		action,
		invocation: {
			executor: "pi.bash.local.v2",
			process: {
				command,
				cwd: root,
				environment: { PATH: "C:\\Program Files\\Git\\usr\\bin" },
				shell: "C:\\Program Files\\Git\\bin\\bash.exe",
				shellArgs: ["-c"],
				commandTransport: "argv",
			},
		},
		callID: `spec-${command}`,
		signal: new AbortController().signal,
	});
}

function result(
	output: string,
	overrides: Partial<Pick<ContainerRuntimeInvocationResult, "exitCode" | "timedOut" | "truncated">> = {},
): ContainerRuntimeInvocationResult {
	return {
		exitCode: 0,
		stdout: output,
		stderr: "",
		output,
		timedOut: false,
		truncated: false,
		...overrides,
	};
}

function commandInput(sourceRoot: string, processRoot: string, cwd: string) {
	return {
		command: "printf ok",
		shell: "C:\\Program Files\\Git\\bin\\bash.exe",
		shellArgs: ["-c"],
		commandTransport: "argv" as const,
		environment: { PATH: "C:\\Windows", PI_TEST: "visible" },
		cwd,
		processRoot,
		workspaceRoot: path.join(processRoot, "workspace"),
		sourceRoot,
		signal: new AbortController().signal,
	};
}

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}
