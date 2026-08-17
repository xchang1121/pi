import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkNativeSandboxRuntime,
	createNativeSandboxProcessBackend,
	executeNativeSandbox,
	invokeNativeSandbox,
	NATIVE_SANDBOX_PROTOCOL_VERSION,
	type NativeSandboxInvoker,
	resolveNativeSandboxBinary,
} from "../src/native-sandbox.ts";

describe("M5 native sandbox broker", () => {
	it("probes a ready broker and exposes its protocol status", async () => {
		await withPlaceholderBinary(async (binaryPath) => {
			const invoker: NativeSandboxInvoker = async (input) => {
				expect(input.binaryPath).toBe(binaryPath);
				expect(input.args).toEqual(["--native-sandbox", "check"]);
				return invocationResult({
					version: NATIVE_SANDBOX_PROTOCOL_VERSION,
					platform: "linux",
					ready: true,
					detail: "namespaces ready",
				});
			};

			await expect(checkNativeSandboxRuntime({ binaryPath, invoker })).resolves.toMatchObject({
				backend: "native",
				state: "ready",
				source: "explicit",
				detail: "namespaces ready",
				fingerprint: expect.stringMatching(/^native:5:[a-f0-9]{64}$/),
				path: binaryPath,
			});
		});
	});

	it("fails closed for an explicitly configured missing binary", async () => {
		const missing = path.join(os.tmpdir(), `pi-native-missing-${Date.now()}`);
		const input = commandInput(os.tmpdir(), path.join(os.tmpdir(), "pi-native-process"));
		const status = await checkNativeSandboxRuntime({ binaryPath: missing });
		expect(status).toMatchObject({ backend: "workspace", state: "unavailable", source: "none" });
		expect(status.detail).toContain("binary not found");
		await expect(executeNativeSandbox(input, { binaryPath: missing })).rejects.toThrow("binary not found");
	});

	it("rejects a protocol mismatch instead of accepting an incompatible broker", async () => {
		await withPlaceholderBinary(async (binaryPath) => {
			const status = await checkNativeSandboxRuntime({
				binaryPath,
				invoker: async () =>
					invocationResult({ version: 99, platform: "linux", ready: true, detail: "wrong version" }),
			});
			expect(status.state).toBe("unavailable");
			expect(status.detail).toContain("protocol mismatch");
		});
	});

	it("selects, verifies, and privately materializes the matching packaged asset", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-assets-"));
		try {
			const assetRoot = path.join(root, "prebuilds");
			const source = path.join(assetRoot, "linux-x64-gnu", "pi-sandbox-native");
			const cacheRoot = path.join(root, "cache");
			await mkdir(path.dirname(source), { recursive: true });
			await writeFile(source, "trusted native bytes");
			const sha256 = createHash("sha256").update("trusted native bytes").digest("hex");
			await writeFile(
				path.join(assetRoot, "manifest.json"),
				JSON.stringify({
					version: 1,
					protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
					assets: [
						{ platform: "linux", arch: "x64", libc: "gnu", file: "linux-x64-gnu/pi-sandbox-native", sha256 },
					],
				}),
			);

			const binary = await resolveNativeSandboxBinary({
				assetRoot,
				cacheRoot,
				platform: "linux",
				arch: "x64",
				libc: "gnu",
				environment: {},
			});
			expect(binary).toMatchObject({ source: "prebuilt", sha256 });
			expect(binary?.path).not.toBe(source);
			expect(await readFile(binary?.path ?? "", "utf8")).toBe("trusted native bytes");
			if (process.platform !== "win32") expect((await stat(binary?.path ?? "")).mode & 0o700).toBe(0o700);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a corrupt packaged asset", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-corrupt-"));
		try {
			const assetRoot = path.join(root, "prebuilds");
			const assetDirectory = path.join(assetRoot, "linux-x64-gnu");
			await mkdir(assetDirectory, { recursive: true });
			await writeFile(path.join(assetDirectory, "pi-sandbox-native"), "corrupt");
			await writeFile(
				path.join(assetRoot, "manifest.json"),
				JSON.stringify({
					version: 1,
					protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
					assets: [
						{
							platform: "linux",
							arch: "x64",
							libc: "gnu",
							file: "linux-x64-gnu/pi-sandbox-native",
							sha256: "0".repeat(64),
						},
					],
				}),
			);

			await expect(
				resolveNativeSandboxBinary({
					assetRoot,
					cacheRoot: path.join(root, "cache"),
					platform: "linux",
					arch: "x64",
					libc: "gnu",
					environment: {},
				}),
			).rejects.toThrow("SHA-256 verification");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("sends camelCase roots and converts Pi timeout seconds to protocol milliseconds", async () => {
		await withPlaceholderBinary(async (binaryPath) => {
			const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-request-"));
			const processRoot = path.join(root, "private");
			const cwd = path.join(processRoot, "workspace");
			const sourceRoot = path.join(root, "source");
			await mkdir(cwd, { recursive: true });
			await mkdir(sourceRoot, { recursive: true });
			let requestFile = "";
			try {
				const response = await executeNativeSandbox(
					{
						command: "printf ok",
						shell: "/bin/bash",
						shellArgs: ["--noprofile", "-c"],
						commandTransport: "argv",
						environment: { PATH: "/usr/bin", PI_TEST: "resolved" },
						cwd,
						processRoot,
						workspaceRoot: cwd,
						sourceRoot,
						timeout: 2.5,
						signal: new AbortController().signal,
					},
					{
						binaryPath,
						maxOutputBytes: 16 * 1024,
						invoker: async (invocation) => {
							requestFile = invocation.args.at(-1) ?? "";
							const request = JSON.parse(await readFile(requestFile, "utf8")) as Record<string, unknown>;
							expect(request).toEqual({
								version: NATIVE_SANDBOX_PROTOCOL_VERSION,
								command: "printf ok",
								shell: "/bin/bash",
								shellArgs: ["--noprofile", "-c"],
								commandTransport: "argv",
								environment: { PATH: "/usr/bin", PI_TEST: "resolved" },
								cwd,
								sandboxRoot: processRoot,
								workspaceRoot: cwd,
								sourceRoot,
								timeoutMs: 2500,
								maxOutputBytes: 16 * 1024,
							});
							expect(invocation.timeoutMs).toBe(12_500);
							return invocationResult(executeResponse({ output: "ok" }));
						},
					},
				);
				expect(response.output).toBe("ok");
				await expect(stat(requestFile)).rejects.toThrow();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	it("maps exit and timeout responses to Pi settlement errors", async () => {
		await withPlaceholderBinary(async (binaryPath) => {
			const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-settlement-"));
			const sourceRoot = path.join(root, "source");
			await mkdir(sourceRoot, { recursive: true });
			try {
				const failedBackend = createNativeSandboxProcessBackend({
					binaryPath,
					invoker: async () => invocationResult(executeResponse({ output: "bad", exit: 7 })),
				});
				const failedSession = await failedBackend.open({ parent: root, signal: new AbortController().signal });
				const failedCwd = path.join(failedSession.processRoot, "workspace");
				await mkdir(failedCwd, { recursive: true });
				const failed = await failedSession.execute(commandInput(sourceRoot, failedSession.processRoot, failedCwd));
				expect(failed.isError).toBe(true);
				expect(failed.result.content).toEqual([{ type: "text", text: "bad\n\nCommand exited with code 7" }]);
				await failedSession.close();

				const timeoutBackend = createNativeSandboxProcessBackend({
					binaryPath,
					invoker: async () =>
						invocationResult(executeResponse({ output: "timed out metadata", exit: 1, timeout: true })),
				});
				const timeoutSession = await timeoutBackend.open({ parent: root, signal: new AbortController().signal });
				const timeoutCwd = path.join(timeoutSession.processRoot, "workspace");
				await mkdir(timeoutCwd, { recursive: true });
				const timedOut = await timeoutSession.execute(
					commandInput(sourceRoot, timeoutSession.processRoot, timeoutCwd),
				);
				expect(timedOut).toMatchObject({ isError: true });
				expect(timedOut.result.content).toEqual([{ type: "text", text: "timed out metadata" }]);
				await timeoutSession.close();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	it("rejects a broker response that does not attest native isolation", async () => {
		await withPlaceholderBinary(async (binaryPath) => {
			const sourceRoot = path.join(os.tmpdir(), "pi-native-source");
			const processRoot = path.join(os.tmpdir(), "pi-native-private");
			await expect(
				executeNativeSandbox(commandInput(sourceRoot, processRoot), {
					binaryPath,
					invoker: async () => invocationResult(executeResponse({ isolated: false })),
				}),
			).rejects.toThrow("did not attest process isolation");
		});
	});

	it("rejects source overlap before invoking the native broker", async () => {
		await withPlaceholderBinary(async (binaryPath) => {
			let invoked = false;
			const processRoot = path.join(os.tmpdir(), "pi-native-overlap");
			await expect(
				executeNativeSandbox(commandInput(processRoot, processRoot), {
					binaryPath,
					invoker: async () => {
						invoked = true;
						return invocationResult(executeResponse());
					},
				}),
			).rejects.toThrow("must not overlap");
			expect(invoked).toBe(false);
		});
	});

	it("rejects cwd and workspace roots outside the private execution root", async () => {
		await withPlaceholderBinary(async (binaryPath) => {
			const root = path.join(os.tmpdir(), "pi-native-containment");
			const processRoot = path.join(root, "private");
			const sourceRoot = path.join(root, "source");
			const outside = path.join(root, "outside");
			let invoked = false;
			const options = {
				binaryPath,
				invoker: async () => {
					invoked = true;
					return invocationResult(executeResponse());
				},
			};
			await expect(
				executeNativeSandbox(
					{ ...commandInput(sourceRoot, processRoot), workspaceRoot: outside, cwd: outside },
					options,
				),
			).rejects.toThrow("workspaceRoot must be inside sandboxRoot");
			await expect(
				executeNativeSandbox({ ...commandInput(sourceRoot, processRoot), cwd: outside }, options),
			).rejects.toThrow("cwd must be inside workspaceRoot");
			expect(invoked).toBe(false);
		});
	});

	it("surfaces broker launch failure without attempting a direct command", async () => {
		await withPlaceholderBinary(async (binaryPath) => {
			const sourceRoot = path.join(os.tmpdir(), "pi-native-source");
			const processRoot = path.join(os.tmpdir(), "pi-native-private");
			await expect(
				executeNativeSandbox(commandInput(sourceRoot, processRoot), {
					binaryPath,
					invoker: async () => {
						throw new Error("spawn denied");
					},
				}),
			).rejects.toThrow("spawn denied");
		});
	});

	it("bounds stdout and stderr and reports real process exit codes", async () => {
		const outputCommand = hostCommand(
			"printf out; printf err >&2; exit 4",
			"process.stdout.write('out'); process.stderr.write('err'); process.exitCode=4",
		);
		const result = await invokeNativeSandbox({
			binaryPath: outputCommand.binaryPath,
			args: outputCommand.args,
			timeoutMs: 5_000,
			maxOutputBytes: 16 * 1024,
		});
		expect(result).toEqual({ exitCode: 4, stdout: "out", stderr: "err" });

		const overflowCommand = hostCommand(
			"i=0; while [ $i -lt 20000 ]; do printf x; i=$((i+1)); done",
			"process.stdout.write('x'.repeat(20000))",
		);
		await expect(
			invokeNativeSandbox({
				binaryPath: overflowCommand.binaryPath,
				args: overflowCommand.args,
				timeoutMs: 5_000,
				maxOutputBytes: 16 * 1024,
			}),
		).rejects.toThrow("exceeded 16384 output bytes");
	});

	it("cancels and times out broker processes", async () => {
		const waitCommand = hostCommand("sleep 30", "setTimeout(() => {}, 30000)");
		const controller = new AbortController();
		const aborted = invokeNativeSandbox({
			binaryPath: waitCommand.binaryPath,
			args: waitCommand.args,
			timeoutMs: 5_000,
			maxOutputBytes: 16 * 1024,
			signal: controller.signal,
		});
		controller.abort();
		await expect(aborted).rejects.toThrow("aborted");

		await expect(
			invokeNativeSandbox({
				binaryPath: waitCommand.binaryPath,
				args: waitCommand.args,
				timeoutMs: 20,
				maxOutputBytes: 16 * 1024,
			}),
		).rejects.toThrow("timed out after 20 ms");
	});
});

function commandInput(sourceRoot: string, processRoot: string, cwd = processRoot) {
	return {
		command: "printf ok",
		shell: "/bin/bash",
		shellArgs: ["-c"],
		commandTransport: "argv" as const,
		environment: { PATH: "/usr/bin" },
		cwd,
		processRoot,
		workspaceRoot: cwd,
		sourceRoot,
		signal: new AbortController().signal,
	};
}

function executeResponse(
	overrides: Partial<
		Record<"output" | "sandbox", string> &
			Record<"exit", number> &
			Record<"timeout" | "truncated" | "isolated", boolean>
	> = {},
) {
	return {
		version: NATIVE_SANDBOX_PROTOCOL_VERSION,
		output: "ok",
		exit: 0,
		timeout: false,
		truncated: false,
		sandbox: "workspace+native-test",
		isolated: true,
		...overrides,
	};
}

function invocationResult(value: object, exitCode = 0) {
	return { exitCode, stdout: JSON.stringify(value), stderr: "" };
}

async function withPlaceholderBinary(run: (binaryPath: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-binary-"));
	const binaryPath = path.join(root, process.platform === "win32" ? "pi-sandbox-native.exe" : "pi-sandbox-native");
	try {
		await writeFile(binaryPath, "placeholder");
		await chmod(binaryPath, 0o700).catch(() => undefined);
		await run(binaryPath);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function hostCommand(unix: string, windowsJavaScript: string): { binaryPath: string; args: string[] } {
	return process.platform === "win32"
		? { binaryPath: process.execPath, args: ["-e", windowsJavaScript] }
		: { binaryPath: "/bin/sh", args: ["-c", unix] };
}
