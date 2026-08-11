import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contains } from "./common.ts";
import type {
	SandboxProcessBackend,
	SandboxProcessBackendStatus,
	SandboxProcessRunnerInput,
} from "./workspace-sandbox.ts";

export const NATIVE_SANDBOX_PROTOCOL_VERSION = 4;
export const NATIVE_SANDBOX_DEFAULT_TIMEOUT_MS = 120_000;
export const NATIVE_SANDBOX_DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

const CHECK_TIMEOUT_MS = 30_000;
const CHECK_MAX_OUTPUT_BYTES = 256 * 1024;
const RESPONSE_OVERHEAD_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MIN_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_NATIVE_ROOT = path.join(PACKAGE_ROOT, "native", "sandbox");

export type NativeSandboxBinarySource = "explicit" | "environment" | "prebuilt" | "development";

export interface NativeSandboxBinary {
	readonly path: string;
	readonly source: NativeSandboxBinarySource;
	readonly sha256?: string;
}

export interface NativeSandboxStatus extends SandboxProcessBackendStatus {
	readonly backend: "native" | "workspace";
	readonly state: "ready" | "unavailable";
	readonly source: NativeSandboxBinarySource | "none";
	readonly detail: string;
	readonly fingerprint?: string;
	readonly path?: string;
}

export interface NativeSandboxInvocation {
	readonly binaryPath: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
	readonly signal?: AbortSignal;
}

export interface NativeSandboxInvocationResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type NativeSandboxInvoker = (input: NativeSandboxInvocation) => Promise<NativeSandboxInvocationResult>;

export interface NativeSandboxOptions {
	/** Exact trusted broker path. When set, discovery never falls through to another binary. */
	readonly binaryPath?: string;
	/** Root containing manifest.json and platform prebuilds. */
	readonly assetRoot?: string;
	/** Private cache used to materialize hash-verified packaged assets. */
	readonly cacheRoot?: string;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
	readonly libc?: "gnu" | "musl";
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly invoker?: NativeSandboxInvoker;
	readonly defaultTimeoutMs?: number;
	readonly maxOutputBytes?: number;
}

export interface CheckNativeSandboxOptions extends NativeSandboxOptions {
	readonly refresh?: boolean;
}

export interface NativeSandboxExecuteResponse {
	readonly version: number;
	readonly output: string;
	readonly exit: number;
	readonly timeout: boolean;
	readonly truncated: boolean;
	readonly sandbox: string;
	readonly isolated: boolean;
}

interface NativeSandboxCheckResponse {
	readonly version: number;
	readonly platform: string;
	readonly ready: boolean;
	readonly detail: string;
}

interface NativeAssetManifestEntry {
	readonly platform: string;
	readonly arch: string;
	readonly libc?: "gnu" | "musl";
	readonly file: string;
	readonly sha256: string;
}

interface NativeAssetManifest {
	readonly version: number;
	readonly protocolVersion: number;
	readonly assets: readonly NativeAssetManifestEntry[];
}

let cachedDefaultStatus: Promise<NativeSandboxStatus> | undefined;

/** Native broker adapter with one private process root per speculative branch. */
export function createNativeSandboxProcessBackend(options: NativeSandboxOptions = {}): SandboxProcessBackend {
	return {
		check: (input) => checkNativeSandboxRuntime({ ...options, ...input }),
		fingerprint: async () => {
			const status = await checkNativeSandboxRuntime(options);
			if (status.state !== "ready" || !status.fingerprint) throw new Error(status.detail);
			return status.fingerprint;
		},
		prepare: async ({ signal }) => {
			throwIfAborted(signal);
			const status = await checkNativeSandboxRuntime(options);
			if (status.state !== "ready") throw new Error(status.detail);
			throwIfAborted(signal);
		},
		open: async ({ parent, signal }) => {
			throwIfAborted(signal);
			const processRoot = await mkdtemp(path.join(parent, "action-"));
			let closed = false;
			return {
				processRoot,
				execute: async (input) => settlementFromNative(await executeNativeSandbox(input, options)),
				close: async () => {
					if (closed) return;
					closed = true;
					await rm(processRoot, { recursive: true, force: true });
				},
			};
		},
		dispose: async () => {},
	};
}

/** Execute one command through the versioned native broker protocol. */
export async function executeNativeSandbox(
	input: SandboxProcessRunnerInput,
	options: NativeSandboxOptions = {},
): Promise<NativeSandboxExecuteResponse> {
	const binary = await resolveNativeSandboxBinary(options);
	if (!binary) throw new Error("Pi native sandbox payload is unavailable for this platform.");
	const timeoutMs = resolveCommandTimeout(input.timeout, options.defaultTimeoutMs);
	const maxOutputBytes = resolveMaxOutputBytes(options.maxOutputBytes);
	const request = validateExecuteRequest({
		version: NATIVE_SANDBOX_PROTOCOL_VERSION,
		command: input.command,
		shell: input.shell,
		shellArgs: [...input.shellArgs],
		commandTransport: input.commandTransport,
		environment: input.environment,
		cwd: path.resolve(input.cwd),
		sandboxRoot: path.resolve(input.processRoot),
		sourceRoot: path.resolve(input.sourceRoot),
		timeoutMs,
		maxOutputBytes,
	});
	const requestDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-native-sandbox-"));
	const requestFile = path.join(requestDirectory, "request.json");
	await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
	try {
		const invocation = await (options.invoker ?? invokeNativeSandbox)({
			binaryPath: binary.path,
			args: ["--native-sandbox", "execute", "--request", requestFile],
			timeoutMs: timeoutMs + 10_000,
			maxOutputBytes: maxOutputBytes + RESPONSE_OVERHEAD_BYTES,
			signal: input.signal,
		});
		if (invocation.exitCode !== 0) {
			throw new Error(`Native sandbox broker failed: ${oneLine(invocation.stderr || invocation.stdout)}`);
		}
		const response = parseExecuteResponse(invocation.stdout);
		assertProtocol(response.version);
		if (!response.isolated) throw new Error("Native sandbox response did not attest process isolation.");
		if (process.platform === "win32" && response.exit < 0) {
			throw new Error(`Native sandbox process initialization failed with NTSTATUS ${windowsStatus(response.exit)}.`);
		}
		return response;
	} finally {
		await rm(requestDirectory, { recursive: true, force: true });
	}
}

/** Probe native isolation readiness. Default calls are cached until refresh is requested. */
export function checkNativeSandboxRuntime(options: CheckNativeSandboxOptions = {}): Promise<NativeSandboxStatus> {
	if (!usesDefaultDiscovery(options)) return probeNativeSandbox(options);
	if (options.refresh) cachedDefaultStatus = undefined;
	cachedDefaultStatus ??= probeNativeSandbox(options);
	return cachedDefaultStatus;
}

/** Resolve and integrity-check the broker selected for this host. */
export async function resolveNativeSandboxBinary(
	options: NativeSandboxOptions = {},
): Promise<NativeSandboxBinary | undefined> {
	if (options.binaryPath !== undefined) {
		return requireBinary(options.binaryPath, "explicit");
	}
	const environment = options.environment ?? process.env;
	const configured = environment.PI_SPECULATIVE_SANDBOX_NATIVE_BIN;
	if (configured) return requireBinary(configured, "environment");

	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const libc = platform === "linux" ? (options.libc ?? detectLinuxLibc()) : undefined;
	for (const assetRoot of assetRoots(options.assetRoot)) {
		const manifestPath = path.join(assetRoot, "manifest.json");
		if (await isFile(manifestPath)) {
			const manifest = parseAssetManifest(await readFile(manifestPath, "utf8"));
			if (manifest.protocolVersion !== NATIVE_SANDBOX_PROTOCOL_VERSION) {
				throw new Error(
					`Native sandbox asset protocol ${manifest.protocolVersion} does not match ${NATIVE_SANDBOX_PROTOCOL_VERSION}.`,
				);
			}
			const entry = manifest.assets.find(
				(asset) => asset.platform === platform && asset.arch === arch && asset.libc === libc,
			);
			if (entry) {
				const source = path.resolve(assetRoot, entry.file);
				if (!contains(assetRoot, source)) throw new Error(`Native sandbox asset escapes its root: ${entry.file}`);
				if (!(await isFile(source))) throw new Error(`Native sandbox asset not found: ${source}`);
				const actual = await fileSha256(source);
				if (actual !== entry.sha256) throw new Error(`Native sandbox asset failed SHA-256 verification: ${source}`);
				const materialized = await materializeAsset(source, entry.sha256, options.cacheRoot, platform);
				return { path: materialized, source: "prebuilt", sha256: entry.sha256 };
			}
		}
	}

	for (const candidate of developmentCandidates(platform)) {
		if (await isFile(candidate)) return { path: candidate, source: "development" };
	}
	return undefined;
}

async function probeNativeSandbox(options: NativeSandboxOptions): Promise<NativeSandboxStatus> {
	let binary: NativeSandboxBinary | undefined;
	try {
		binary = await resolveNativeSandboxBinary(options);
	} catch (error) {
		return unavailableStatus("none", `Native sandbox payload failed validation: ${oneLine(errorMessage(error))}`);
	}
	if (!binary) return unavailableStatus("none", "Pi native sandbox payload is unavailable for this platform.");
	try {
		const invocation = await (options.invoker ?? invokeNativeSandbox)({
			binaryPath: binary.path,
			args: ["--native-sandbox", "check"],
			timeoutMs: CHECK_TIMEOUT_MS,
			maxOutputBytes: CHECK_MAX_OUTPUT_BYTES,
		});
		const response = parseCheckResponse(invocation.stdout);
		assertProtocol(response.version);
		if (!response.ready || invocation.exitCode !== 0) {
			return unavailableStatus(binary.source, response.detail, binary.path);
		}
		return {
			backend: "native",
			state: "ready",
			source: binary.source,
			detail: response.detail,
			fingerprint: `native:${NATIVE_SANDBOX_PROTOCOL_VERSION}:${binary.sha256 ?? binary.path}`,
			path: binary.path,
		};
	} catch (error) {
		return unavailableStatus(
			binary.source,
			`Native sandbox probe failed: ${oneLine(errorMessage(error))}`,
			binary.path,
		);
	}
}

function unavailableStatus(
	source: NativeSandboxStatus["source"],
	detail: string,
	binaryPath?: string,
): NativeSandboxStatus {
	return {
		backend: "workspace",
		state: "unavailable",
		source,
		detail,
		...(binaryPath ? { path: binaryPath } : {}),
	};
}

async function requireBinary(binaryPath: string, source: NativeSandboxBinarySource): Promise<NativeSandboxBinary> {
	const resolved = path.resolve(binaryPath);
	if (!(await isFile(resolved))) throw new Error(`Native sandbox binary not found: ${resolved}`);
	return { path: resolved, source, sha256: await fileSha256(resolved) };
}

async function materializeAsset(
	source: string,
	hash: string,
	cacheRoot: string | undefined,
	platform: NodeJS.Platform,
): Promise<string> {
	const executable = platform === "win32" ? "pi-sandbox-native.exe" : "pi-sandbox-native";
	const root = cacheRoot ? path.resolve(cacheRoot) : defaultCacheRoot();
	const target = path.join(root, hash, executable);
	if ((await fileSha256(target)) === hash) return target;
	await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	await writeFile(temporary, await readFile(source), { mode: 0o700 });
	await chmod(temporary, 0o700).catch(() => undefined);
	try {
		await rename(temporary, target);
	} catch (error) {
		if ((await fileSha256(target)) !== hash) throw error;
	} finally {
		await rm(temporary, { force: true });
	}
	if ((await fileSha256(target)) !== hash)
		throw new Error("Materialized native sandbox failed integrity verification.");
	return target;
}

function defaultCacheRoot(): string {
	if (process.platform === "win32") {
		return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "pi", "native");
	}
	return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "pi", "native");
}

function developmentCandidates(platform: NodeJS.Platform): string[] {
	const executable = platform === "win32" ? "pi-sandbox-native.exe" : "pi-sandbox-native";
	const target = path.join(DEFAULT_NATIVE_ROOT, "target");
	return [path.join(target, "release", executable), path.join(target, "debug", executable)];
}

function assetRoots(configured: string | undefined): string[] {
	if (configured !== undefined) return [path.resolve(configured)];
	return [
		...new Set([
			path.join(DEFAULT_NATIVE_ROOT, "prebuilds"),
			path.join(path.dirname(process.execPath), "native", "sandbox", "prebuilds"),
		]),
	];
}

function detectLinuxLibc(): "gnu" | "musl" {
	const report = process.report?.getReport();
	if (!report || typeof report !== "object" || !("header" in report)) return "musl";
	const header = report.header;
	return header && typeof header === "object" && "glibcVersionRuntime" in header && header.glibcVersionRuntime
		? "gnu"
		: "musl";
}

function resolveCommandTimeout(timeoutSeconds: number | undefined, configuredDefault: number | undefined): number {
	if (timeoutSeconds === undefined) return validateTimeout(configuredDefault ?? NATIVE_SANDBOX_DEFAULT_TIMEOUT_MS);
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	return validateTimeout(timeoutSeconds * 1000);
}

function validateTimeout(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Native sandbox timeout must be between 1 and ${MAX_TIMEOUT_MS} ms.`);
	}
	return Math.round(timeoutMs);
}

function resolveMaxOutputBytes(value: number | undefined): number {
	const result = value ?? NATIVE_SANDBOX_DEFAULT_MAX_OUTPUT_BYTES;
	if (!Number.isInteger(result) || result < MIN_OUTPUT_BYTES || result > MAX_OUTPUT_BYTES) {
		throw new Error(`Native sandbox maxOutputBytes must be between ${MIN_OUTPUT_BYTES} and ${MAX_OUTPUT_BYTES}.`);
	}
	return result;
}

function validateExecuteRequest<
	T extends {
		version: number;
		command: string;
		cwd: string;
		sandboxRoot: string;
		sourceRoot: string;
		timeoutMs: number;
		maxOutputBytes: number;
		shell: string;
		shellArgs: readonly string[];
		commandTransport: "argv" | "stdin";
		environment: Readonly<Record<string, string>>;
	},
>(request: T): T {
	if (request.version !== NATIVE_SANDBOX_PROTOCOL_VERSION) throw new Error("Unsupported native sandbox protocol.");
	if (request.command.trim() === "") throw new Error("Native sandbox command must not be empty.");
	for (const [name, value] of [
		["cwd", request.cwd],
		["sandboxRoot", request.sandboxRoot],
		["sourceRoot", request.sourceRoot],
	] as const) {
		if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute.`);
	}
	if (request.cwd !== request.sandboxRoot && !contains(request.sandboxRoot, request.cwd)) {
		throw new Error("cwd must be inside sandboxRoot.");
	}
	if (
		request.sandboxRoot === request.sourceRoot ||
		contains(request.sandboxRoot, request.sourceRoot) ||
		contains(request.sourceRoot, request.sandboxRoot)
	) {
		throw new Error("sandboxRoot and sourceRoot must not overlap.");
	}
	validateTimeout(request.timeoutMs);
	resolveMaxOutputBytes(request.maxOutputBytes);
	return request;
}

function settlementFromNative(response: NativeSandboxExecuteResponse) {
	let text = response.output || "(no output)";
	if (response.exit !== 0 && !response.timeout) text = `${text}\n\nCommand exited with code ${response.exit}`;
	return {
		result: { content: [{ type: "text" as const, text }], details: undefined },
		isError: response.exit !== 0 || response.timeout,
	};
}

function parseCheckResponse(value: string): NativeSandboxCheckResponse {
	const record = parseJsonRecord(value, "check");
	if (
		typeof record.version !== "number" ||
		typeof record.platform !== "string" ||
		typeof record.ready !== "boolean" ||
		typeof record.detail !== "string"
	) {
		throw new Error("Native sandbox check response has an invalid shape.");
	}
	return {
		version: record.version,
		platform: record.platform,
		ready: record.ready,
		detail: record.detail,
	};
}

function parseExecuteResponse(value: string): NativeSandboxExecuteResponse {
	const record = parseJsonRecord(value, "execute");
	if (
		typeof record.version !== "number" ||
		typeof record.output !== "string" ||
		typeof record.exit !== "number" ||
		!Number.isInteger(record.exit) ||
		typeof record.timeout !== "boolean" ||
		typeof record.truncated !== "boolean" ||
		typeof record.sandbox !== "string" ||
		typeof record.isolated !== "boolean"
	) {
		throw new Error("Native sandbox execute response has an invalid shape.");
	}
	return {
		version: record.version,
		output: record.output,
		exit: record.exit,
		timeout: record.timeout,
		truncated: record.truncated,
		sandbox: record.sandbox,
		isolated: record.isolated,
	};
}

function windowsStatus(value: number): string {
	return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`Native sandbox ${label} response is not valid JSON.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Native sandbox ${label} response must be an object.`);
	}
	return parsed as Record<string, unknown>;
}

function parseAssetManifest(value: string): NativeAssetManifest {
	const record = parseJsonRecord(value, "asset manifest");
	if (record.version !== 1 || typeof record.protocolVersion !== "number" || !Array.isArray(record.assets)) {
		throw new Error("Native sandbox asset manifest has an invalid shape.");
	}
	const assets = record.assets.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error("Native sandbox asset manifest entry must be an object.");
		}
		const asset = entry as Record<string, unknown>;
		if (
			typeof asset.platform !== "string" ||
			typeof asset.arch !== "string" ||
			(asset.libc !== undefined && asset.libc !== "gnu" && asset.libc !== "musl") ||
			typeof asset.file !== "string" ||
			!isSha256(asset.sha256)
		) {
			throw new Error("Native sandbox asset manifest entry has an invalid shape.");
		}
		return {
			platform: asset.platform,
			arch: asset.arch,
			...(asset.libc ? { libc: asset.libc } : {}),
			file: asset.file,
			sha256: asset.sha256,
		} satisfies NativeAssetManifestEntry;
	});
	return { version: 1, protocolVersion: record.protocolVersion, assets };
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function assertProtocol(version: number): void {
	if (version !== NATIVE_SANDBOX_PROTOCOL_VERSION) {
		throw new Error(`Native sandbox protocol mismatch: got ${version}, expected ${NATIVE_SANDBOX_PROTOCOL_VERSION}.`);
	}
}

async function fileSha256(file: string): Promise<string | undefined> {
	try {
		return createHash("sha256")
			.update(await readFile(file))
			.digest("hex");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function isFile(file: string): Promise<boolean> {
	try {
		return (await stat(file)).isFile();
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function usesDefaultDiscovery(options: CheckNativeSandboxOptions): boolean {
	return Object.keys(options).every((key) => key === "refresh");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 2_000) || "unknown error";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Native sandbox operation aborted.");
}

export function invokeNativeSandbox(input: NativeSandboxInvocation): Promise<NativeSandboxInvocationResult> {
	return new Promise((resolve, reject) => {
		if (input.signal?.aborted) {
			reject(new Error("Native sandbox invocation aborted."));
			return;
		}
		const child = spawn(input.binaryPath, [...input.args], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		let timedOut = false;
		let overflowed = false;
		let exitCode: number | null | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		const terminate = () => {
			try {
				child.kill();
			} catch {
				// The process may already have exited.
			}
		};
		const onAbort = () => terminate();
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, input.timeoutMs);
		const append = (target: Buffer[], chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > input.maxOutputBytes) {
				overflowed = true;
				terminate();
				return;
			}
			target.push(chunk);
		};
		const finish = () => {
			if (settled || exitCode === undefined || !stdoutEnded || !stderrEnded) return;
			settled = true;
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
			if (input.signal?.aborted) {
				reject(new Error("Native sandbox invocation aborted."));
				return;
			}
			if (timedOut) {
				reject(new Error(`Native sandbox broker timed out after ${input.timeoutMs} ms.`));
				return;
			}
			if (overflowed) {
				reject(new Error(`Native sandbox broker exceeded ${input.maxOutputBytes} output bytes.`));
				return;
			}
			resolve({
				exitCode,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		};
		child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
		child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
		child.stdout?.on("end", () => {
			stdoutEnded = true;
			finish();
		});
		child.stderr?.on("end", () => {
			stderrEnded = true;
			finish();
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
			reject(new Error(`Native sandbox failed to start: ${error.message}`));
		});
		child.on("close", (code) => {
			exitCode = code;
			finish();
		});
		input.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
