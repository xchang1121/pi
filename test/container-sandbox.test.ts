import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ContainerRuntimeInvocation,
	type ContainerRuntimeInvocationResult,
	createContainerSandboxProcessBackend,
} from "../src/container-sandbox.ts";

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

	it("recycles a warm slot while removing branch state and never mounting the actor source", async () => {
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
		expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(2);
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
});

function fakeRuntime(
	calls: ContainerRuntimeInvocation[],
	execute: (input: ContainerRuntimeInvocation) => Promise<ContainerRuntimeInvocationResult> = async () => result("ok"),
) {
	return async (input: ContainerRuntimeInvocation): Promise<ContainerRuntimeInvocationResult> => {
		calls.push(input);
		if (input.args[0] === "version") return result("25.0");
		if (input.args[0] === "image") return result("sha256:worker|linux|x86_64");
		if (input.args[0] === "exec") return execute(input);
		return result(input.args[0] === "create" ? "container-id" : "");
	};
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
		sourceRoot,
		signal: new AbortController().signal,
	};
}

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}
