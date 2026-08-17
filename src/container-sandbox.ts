import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	SandboxProcessBackend,
	SandboxProcessBackendStatus,
	SandboxProcessRunnerInput,
	SandboxProcessSession,
} from "./workspace-sandbox.ts";

export const DEFAULT_CONTAINER_SANDBOX_IMAGE = "pi-speculative-worker:latest";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const CHECK_TIMEOUT_MS = 15_000;
const LIFECYCLE_TIMEOUT_MS = 60_000;
const LIFECYCLE_OUTPUT_BYTES = 256 * 1024;

export type ContainerRuntimeName = "docker" | "podman";
export type ContainerRuntimePreference = "auto" | ContainerRuntimeName;

export interface ContainerRuntimeInvocation {
	readonly binaryPath: string;
	readonly args: readonly string[];
	readonly stdin?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
}

export interface ContainerRuntimeInvocationResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** stdout and stderr in observed arrival order. */
	readonly output: string;
	readonly timedOut: boolean;
	readonly truncated: boolean;
}

export type ContainerRuntimeInvoker = (input: ContainerRuntimeInvocation) => Promise<ContainerRuntimeInvocationResult>;

export interface ContainerSandboxOptions {
	readonly runtime?: ContainerRuntimePreference;
	readonly binaryPath?: string;
	readonly image?: string;
	readonly guestShell?: string;
	readonly maxWorkers?: number;
	readonly workerRoot?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly invoker?: ContainerRuntimeInvoker;
	readonly maxOutputBytes?: number;
	readonly defaultTimeoutMs?: number;
}

interface ContainerRuntimeInfo {
	readonly binaryPath: string;
	readonly runtime: ContainerRuntimeName;
	readonly image: string;
	readonly imageID: string;
	readonly os: "linux" | "windows";
	readonly arch: string;
	readonly guestRoot: string;
	readonly guestTmp: string;
	readonly guestShell: string;
	readonly fingerprint: string;
}

interface WorkerSlot {
	readonly processRoot: string;
	container?: string;
	busy: boolean;
	ready: Promise<void>;
}

/** Create an OCI worker pool whose process and filesystem state is reset after every branch. */
export function createContainerSandboxProcessBackend(options: ContainerSandboxOptions = {}): SandboxProcessBackend {
	return new ContainerSandboxBackend(options);
}

class ContainerSandboxBackend implements SandboxProcessBackend {
	private readonly options: ContainerSandboxOptions;
	private readonly invoke: ContainerRuntimeInvoker;
	private readonly maxWorkers: number;
	private readonly slots: WorkerSlot[] = [];
	private readonly waiters = new Set<() => void>();
	private info?: Promise<ContainerRuntimeInfo>;
	private status?: Promise<SandboxProcessBackendStatus>;
	private creating = 0;
	private disposed = false;

	constructor(options: ContainerSandboxOptions) {
		this.options = options;
		this.invoke = options.invoker ?? invokeContainerRuntime;
		this.maxWorkers = Math.max(1, Math.min(32, Math.floor(options.maxWorkers ?? 8)));
	}

	readonly check = async (input: { readonly refresh?: boolean } = {}): Promise<SandboxProcessBackendStatus> => {
		if (input.refresh && this.slots.length === 0) {
			this.info = undefined;
			this.status = undefined;
		}
		this.status ??= this.probeStatus();
		return this.status;
	};

	readonly fingerprint = async (): Promise<string> => {
		const info = await this.runtimeInfo();
		return info.fingerprint;
	};

	readonly prepare = async ({ signal }: { readonly signal?: AbortSignal }): Promise<void> => {
		throwIfAborted(signal);
		await this.runtimeInfo();
		throwIfAborted(signal);
	};

	readonly open = async ({
		signal,
	}: {
		readonly parent: string;
		readonly signal: AbortSignal;
	}): Promise<SandboxProcessSession> => {
		const slot = await this.acquire(signal);
		let closed = false;
		let executed = false;
		return {
			processRoot: slot.processRoot,
			execute: async (input) => {
				if (closed) throw new Error("Container sandbox session is closed.");
				if (executed) throw new Error("Container sandbox session can execute only once.");
				executed = true;
				return this.execute(slot, input);
			},
			close: async () => {
				if (closed) return;
				closed = true;
				await this.release(slot);
			},
		};
	};

	readonly dispose = async (): Promise<void> => {
		if (this.disposed) return;
		this.disposed = true;
		this.notify();
		await Promise.all(
			this.slots.map(async (slot) => {
				await slot.ready.catch(() => undefined);
				await this.destroyContainer(slot).catch(() => undefined);
				await rm(slot.processRoot, { recursive: true, force: true });
			}),
		);
		this.slots.length = 0;
	};

	private async probeStatus(): Promise<SandboxProcessBackendStatus> {
		try {
			const info = await this.runtimeInfo();
			return {
				backend: "container",
				state: "ready",
				source: info.runtime,
				detail: `${info.runtime} worker image ${info.image} (${info.os}/${info.arch}) is ready`,
				fingerprint: info.fingerprint,
				path: info.binaryPath,
			};
		} catch (error) {
			return {
				backend: "workspace",
				state: "unavailable",
				source: "none",
				detail: oneLine(errorMessage(error)),
			};
		}
	}

	private runtimeInfo(): Promise<ContainerRuntimeInfo> {
		if (this.disposed) return Promise.reject(new Error("Container sandbox backend is disposed."));
		this.info ??= probeRuntime(this.options, this.invoke);
		return this.info;
	}

	private async acquire(signal: AbortSignal): Promise<WorkerSlot> {
		for (;;) {
			throwIfAborted(signal);
			if (this.disposed) throw new Error("Container sandbox backend is disposed.");
			let slot = this.slots.find((candidate) => !candidate.busy);
			if (slot) {
				slot.busy = true;
				try {
					await slot.ready;
					return slot;
				} catch {
					await this.removeSlot(slot);
					continue;
				}
			}
			if (this.slots.length + this.creating < this.maxWorkers) {
				this.creating++;
				try {
					slot = await this.newSlot();
					slot.busy = true;
					this.slots.push(slot);
				} finally {
					this.creating--;
					this.notify();
				}
				try {
					await slot.ready;
					return slot;
				} catch (error) {
					await this.removeSlot(slot);
					throw error;
				}
			}
			await this.wait(signal);
		}
	}

	private async newSlot(): Promise<WorkerSlot> {
		const base = path.resolve(this.options.workerRoot ?? os.tmpdir());
		await mkdir(base, { recursive: true, mode: 0o700 });
		const processRoot = await mkdtemp(path.join(base, "pi-speculative-worker-"));
		const slot: WorkerSlot = { processRoot, busy: false, ready: Promise.resolve() };
		slot.ready = this.resetSlot(slot);
		return slot;
	}

	private async resetSlot(slot: WorkerSlot): Promise<void> {
		await rm(slot.processRoot, { recursive: true, force: true });
		await mkdir(path.join(slot.processRoot, "tmp"), { recursive: true, mode: 0o700 });
	}

	private async startContainer(slot: WorkerSlot, input: SandboxProcessRunnerInput): Promise<ContainerRuntimeInfo> {
		const info = await this.runtimeInfo();
		const container = `pi-spec-${randomUUID()}`;
		slot.container = container;
		try {
			const create = await this.lifecycle(info, createArguments(info, input, container));
			if (create.exitCode !== 0) throw lifecycleError(info.runtime, "create", create);
			const start = await this.lifecycle(info, ["start", container]);
			if (start.exitCode !== 0) throw lifecycleError(info.runtime, "start", start);
		} catch (error) {
			await this.destroyContainer(slot).catch(() => undefined);
			throw error;
		}
		return info;
	}

	private async execute(slot: WorkerSlot, input: SandboxProcessRunnerInput) {
		const processRoot = path.resolve(input.processRoot);
		const workspaceRoot = path.resolve(input.workspaceRoot);
		const cwd = path.resolve(input.cwd);
		if (processRoot !== path.resolve(slot.processRoot))
			throw new Error("Container session does not own processRoot.");
		const relativeWorkspace = path.relative(processRoot, workspaceRoot);
		if (relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
			throw new Error("Container workspaceRoot escapes its private root.");
		}
		const relativeCwd = path.relative(workspaceRoot, cwd);
		if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
			throw new Error("Container sandbox cwd escapes workspaceRoot.");
		}
		const info = await this.startContainer(slot, input);
		if (!slot.container) throw new Error("Container worker is not running.");
		const logicalRoot = guestWorkspaceRoot(info, input);
		const guestCwd = joinGuestPath(info, logicalRoot, relativeCwd);
		const args = ["exec"];
		if (input.commandTransport === "stdin") args.push("-i");
		args.push("--workdir", guestCwd);
		for (const [name, value] of Object.entries(containerEnvironment(input.environment, info))) {
			args.push("--env", `${name}=${value}`);
		}
		args.push(slot.container, info.guestShell, ...input.shellArgs);
		if (input.commandTransport === "argv") args.push(input.command);
		let result: ContainerRuntimeInvocationResult;
		try {
			result = await this.invoke({
				binaryPath: info.binaryPath,
				args,
				...(input.commandTransport === "stdin" ? { stdin: input.command } : {}),
				timeoutMs: commandTimeout(input.timeout, this.options.defaultTimeoutMs),
				maxOutputBytes: outputLimit(this.options.maxOutputBytes),
				signal: input.signal,
			});
		} finally {
			// `docker exec` can leave background descendants. Removing the branch container is
			// the process-tree settlement boundary, including on cancellation and timeout.
			await this.destroyContainer(slot);
		}
		if (result.exitCode === 125 && /(?:daemon|container|podman)/i.test(result.stderr)) {
			throw new Error(`Container sandbox execution failed: ${oneLine(result.stderr || result.output)}`);
		}
		return settlementFromContainer(result);
	}

	private async release(slot: WorkerSlot): Promise<void> {
		await this.destroyContainer(slot);
		if (this.disposed) {
			await this.removeSlot(slot);
			return;
		}
		slot.ready = this.resetSlot(slot);
		void slot.ready.catch(() => this.notify());
		slot.busy = false;
		this.notify();
	}

	private async removeSlot(slot: WorkerSlot): Promise<void> {
		const index = this.slots.indexOf(slot);
		if (index !== -1) this.slots.splice(index, 1);
		await this.destroyContainer(slot).catch(() => undefined);
		await rm(slot.processRoot, { recursive: true, force: true });
		this.notify();
	}

	private async destroyContainer(slot: WorkerSlot): Promise<void> {
		const container = slot.container;
		if (!container) return;
		const info = await this.runtimeInfo();
		const result = await this.lifecycle(info, ["rm", "--force", container]);
		if (result.exitCode !== 0 && !/no such (?:container|object)/i.test(`${result.stdout}\n${result.stderr}`)) {
			throw lifecycleError(info.runtime, "remove", result);
		}
		if (slot.container === container) slot.container = undefined;
	}

	private lifecycle(info: ContainerRuntimeInfo, args: readonly string[]) {
		return this.invoke({
			binaryPath: info.binaryPath,
			args,
			timeoutMs: LIFECYCLE_TIMEOUT_MS,
			maxOutputBytes: LIFECYCLE_OUTPUT_BYTES,
		});
	}

	private wait(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const wake = () => {
				cleanup();
				resolve();
			};
			const abort = () => {
				cleanup();
				reject(signal.reason instanceof Error ? signal.reason : new Error("Container worker acquisition aborted."));
			};
			const cleanup = () => {
				this.waiters.delete(wake);
				signal.removeEventListener("abort", abort);
			};
			this.waiters.add(wake);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
	}

	private notify(): void {
		for (const wake of this.waiters) wake();
	}
}

async function probeRuntime(
	options: ContainerSandboxOptions,
	invoke: ContainerRuntimeInvoker,
): Promise<ContainerRuntimeInfo> {
	const environment = options.environment ?? process.env;
	const image = options.image ?? environment.PI_SPECULATIVE_WORKER_IMAGE ?? DEFAULT_CONTAINER_SANDBOX_IMAGE;
	const candidates = runtimeCandidates(options, environment);
	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			const version = await invoke({
				binaryPath: candidate.binaryPath,
				args: ["version"],
				timeoutMs: CHECK_TIMEOUT_MS,
				maxOutputBytes: LIFECYCLE_OUTPUT_BYTES,
			});
			if (version.exitCode !== 0 || version.timedOut) throw lifecycleError(candidate.runtime, "version", version);
			const inspected = await invoke({
				binaryPath: candidate.binaryPath,
				args: ["image", "inspect", "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}", image],
				timeoutMs: CHECK_TIMEOUT_MS,
				maxOutputBytes: LIFECYCLE_OUTPUT_BYTES,
			});
			if (inspected.exitCode !== 0 || inspected.timedOut)
				throw lifecycleError(candidate.runtime, "image inspect", inspected);
			const [imageID, imageOS, arch] = inspected.stdout.trim().split("|");
			if (!imageID || (imageOS !== "linux" && imageOS !== "windows") || !arch) {
				throw new Error(`${candidate.runtime} returned invalid image metadata for ${image}`);
			}
			const osName = imageOS;
			const guestRoot = osName === "windows" ? "C:\\pi" : "/pi";
			const guestTmp = osName === "windows" ? "C:\\pi-tmp" : "/tmp";
			const guestShell =
				options.guestShell ??
				environment.PI_SPECULATIVE_WORKER_SHELL ??
				(osName === "windows" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash");
			return {
				...candidate,
				image,
				imageID,
				os: osName,
				arch,
				guestRoot,
				guestTmp,
				guestShell,
				fingerprint: `container:${candidate.runtime}:${imageID}:${osName}:${arch}:${guestShell}`,
			};
		} catch (error) {
			failures.push(`${candidate.runtime}: ${oneLine(errorMessage(error))}`);
		}
	}
	throw new Error(`No OCI worker runtime is ready for ${image}. ${failures.join("; ")}`);
}

function runtimeCandidates(
	options: ContainerSandboxOptions,
	environment: Readonly<Record<string, string | undefined>>,
): Array<{ readonly runtime: ContainerRuntimeName; readonly binaryPath: string }> {
	const configuredBinary = options.binaryPath ?? environment.PI_SPECULATIVE_WORKER_RUNTIME_BIN;
	const configuredRuntime = options.runtime ?? runtimePreference(environment.PI_SPECULATIVE_WORKER_RUNTIME);
	if (configuredBinary) {
		const inferred = path.basename(configuredBinary).toLowerCase().includes("podman") ? "podman" : "docker";
		return [{ runtime: configuredRuntime === "auto" ? inferred : configuredRuntime, binaryPath: configuredBinary }];
	}
	const runtimes: readonly ContainerRuntimeName[] =
		configuredRuntime === "auto" ? ["docker", "podman"] : [configuredRuntime];
	return runtimes.map((runtime) => ({
		runtime,
		binaryPath: runtime,
	}));
}

function runtimePreference(value: string | undefined): ContainerRuntimePreference {
	return value === "docker" || value === "podman" ? value : "auto";
}

function createArguments(info: ContainerRuntimeInfo, input: SandboxProcessRunnerInput, container: string): string[] {
	const processRoot = path.resolve(input.processRoot);
	const workspaceRoot = path.resolve(input.workspaceRoot);
	const logicalRoot = guestWorkspaceRoot(info, input);
	const mountedWorkspace = guestPath(info, path.relative(processRoot, workspaceRoot));
	const args = [
		"create",
		"--name",
		container,
		"--network",
		"none",
		"--mount",
		`type=bind,src=${processRoot},dst=${info.guestRoot}`,
		"--mount",
		`type=bind,src=${path.join(processRoot, "tmp")},dst=${info.guestTmp}`,
	];
	if (logicalRoot !== mountedWorkspace) {
		args.push("--mount", `type=bind,src=${workspaceRoot},dst=${logicalRoot}`);
	}
	if (info.os === "linux") {
		args.push("--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256");
		if (typeof process.getuid === "function" && typeof process.getgid === "function") {
			args.push("--user", `${process.getuid()}:${process.getgid()}`);
		}
	}
	args.push("--entrypoint", info.os === "windows" ? "cmd.exe" : "/bin/sh", info.image, ...keepAliveCommand(info.os));
	return args;
}

function keepAliveCommand(osName: ContainerRuntimeInfo["os"]): string[] {
	return osName === "windows" ? ["/d", "/s", "/c", "ping -t 127.0.0.1 >NUL"] : ["-c", "while :; do sleep 3600; done"];
}

function guestPath(info: ContainerRuntimeInfo, relative: string): string {
	if (!relative || relative === ".") return info.guestRoot;
	const segments = relative.split(/[\\/]+/).filter(Boolean);
	return joinGuestPath(info, info.guestRoot, ...segments);
}

function guestWorkspaceRoot(info: ContainerRuntimeInfo, input: SandboxProcessRunnerInput): string {
	const sourceRoot = input.sourceRoot;
	if (info.os === "linux" && path.posix.isAbsolute(sourceRoot)) return path.posix.normalize(sourceRoot);
	if (info.os === "windows" && path.win32.isAbsolute(sourceRoot)) return path.win32.normalize(sourceRoot);
	return guestPath(info, path.relative(path.resolve(input.processRoot), path.resolve(input.workspaceRoot)));
}

function joinGuestPath(info: ContainerRuntimeInfo, root: string, ...segments: string[]): string {
	const clean = segments.flatMap((segment) => segment.split(/[\\/]+/).filter(Boolean));
	return info.os === "windows" ? path.win32.join(root, ...clean) : path.posix.join(root, ...clean);
}

function containerEnvironment(
	environment: Readonly<Record<string, string>>,
	info: ContainerRuntimeInfo,
): Record<string, string> {
	const skipped = new Set(["home", "oldpwd", "path", "pwd", "temp", "tmp", "tmpdir"]);
	const result = Object.fromEntries(Object.entries(environment).filter(([name]) => !skipped.has(name.toLowerCase())));
	return {
		...result,
		HOME: info.guestTmp,
		TEMP: info.guestTmp,
		TMP: info.guestTmp,
		TMPDIR: info.guestTmp,
		PI_SPECULATIVE_SANDBOX: "container",
	};
}

function commandTimeout(seconds: number | undefined, configured: number | undefined): number {
	const value = seconds === undefined ? (configured ?? DEFAULT_TIMEOUT_MS) : seconds * 1000;
	if (!Number.isFinite(value) || value <= 0 || value > 24 * 60 * 60 * 1000) {
		throw new Error("Container sandbox timeout must be between 1 ms and 24 hours.");
	}
	return Math.round(value);
}

function outputLimit(value: number | undefined): number {
	const limit = value ?? DEFAULT_MAX_OUTPUT_BYTES;
	if (!Number.isInteger(limit) || limit < 16 * 1024 || limit > 64 * 1024 * 1024) {
		throw new Error("Container sandbox output limit must be between 16384 and 67108864 bytes.");
	}
	return limit;
}

function settlementFromContainer(result: ContainerRuntimeInvocationResult) {
	let text = result.output || "(no output)";
	if (result.truncated) text = `[output truncated to the last bytes]\n${text}`;
	if (result.exitCode !== 0 && !result.timedOut) text = `${text}\n\nCommand exited with code ${result.exitCode ?? 1}`;
	return {
		result: { content: [{ type: "text" as const, text }], details: undefined },
		isError: result.exitCode !== 0 || result.timedOut,
	};
}

function lifecycleError(runtime: string, operation: string, result: ContainerRuntimeInvocationResult): Error {
	const detail = oneLine(result.stderr || result.stdout || (result.timedOut ? "timed out" : "unknown error"));
	return new Error(`${runtime} ${operation} failed: ${detail}`);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Container sandbox operation aborted.");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 2_000) || "unknown error";
}

/** Spawn one Docker/Podman CLI operation with bounded, arrival-ordered output. */
export function invokeContainerRuntime(input: ContainerRuntimeInvocation): Promise<ContainerRuntimeInvocationResult> {
	return new Promise((resolve, reject) => {
		if (input.signal?.aborted) {
			reject(
				input.signal.reason instanceof Error
					? input.signal.reason
					: new Error("Container runtime invocation aborted."),
			);
			return;
		}
		const child = spawn(input.binaryPath, [...input.args], {
			stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout = new TailBuffer(input.maxOutputBytes);
		const stderr = new TailBuffer(input.maxOutputBytes);
		const output = new TailBuffer(input.maxOutputBytes);
		let timedOut = false;
		let settled = false;
		const terminate = () => {
			try {
				child.kill();
			} catch {
				// The CLI may already have exited.
			}
		};
		const abort = () => terminate();
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, input.timeoutMs);
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", abort);
			if (input.signal?.aborted) {
				reject(
					input.signal.reason instanceof Error
						? input.signal.reason
						: new Error("Container runtime invocation aborted."),
				);
				return;
			}
			resolve({
				exitCode,
				stdout: stdout.text(),
				stderr: stderr.text(),
				output: output.text(),
				timedOut,
				truncated: output.truncated,
			});
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout.append(chunk);
			output.append(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.append(chunk);
			output.append(chunk);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", abort);
			reject(new Error(`Container runtime failed to start: ${error.message}`));
		});
		child.on("close", finish);
		input.signal?.addEventListener("abort", abort, { once: true });
		if (input.stdin !== undefined) child.stdin?.end(input.stdin);
	});
}

class TailBuffer {
	private readonly limit: number;
	private chunks: Buffer[] = [];
	private bytes = 0;
	truncated = false;

	constructor(limit: number) {
		this.limit = limit;
	}

	append(chunk: Buffer): void {
		if (chunk.length >= this.limit) {
			this.chunks = [chunk.subarray(chunk.length - this.limit)];
			this.bytes = this.limit;
			this.truncated = true;
			return;
		}
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		let overflow = this.bytes - this.limit;
		if (overflow <= 0) return;
		this.truncated = true;
		while (overflow > 0) {
			const first = this.chunks[0]!;
			if (first.length <= overflow) {
				this.chunks.shift();
				this.bytes -= first.length;
				overflow -= first.length;
			} else {
				this.chunks[0] = first.subarray(overflow);
				this.bytes -= overflow;
				overflow = 0;
			}
		}
	}

	text(): string {
		return Buffer.concat(this.chunks, this.bytes).toString("utf8");
	}
}
