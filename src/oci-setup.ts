import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTAINER_SANDBOX_IMAGE, invokeContainerRuntime } from "./container-sandbox.ts";

export type OciRuntime = "docker" | "podman";

export interface OciSetupOption {
	readonly runtime: OciRuntime;
	readonly label: string;
	readonly detail: string;
}

export interface OciSetupService {
	readonly discover: (preference: "auto" | OciRuntime) => Promise<readonly OciSetupOption[]>;
	readonly setup: (input: {
		readonly runtime: OciRuntime;
		readonly image: string;
		readonly onProgress?: (message: string) => void;
	}) => Promise<void>;
}

export interface OciSetupCommandResult {
	readonly exitCode: number | null;
	readonly output: string;
}

export type OciSetupCommandRunner = (
	command: string,
	args: readonly string[],
	timeoutMs: number,
) => Promise<OciSetupCommandResult>;

interface OciSetupServiceOptions {
	readonly platform?: NodeJS.Platform;
	readonly environment?: NodeJS.ProcessEnv;
	readonly getuid?: () => number;
	readonly run?: OciSetupCommandRunner;
	readonly workerRoot?: string;
}

interface PackageInstaller {
	readonly command: string;
	readonly args: (runtime: OciRuntime) => readonly string[];
	readonly elevation: boolean;
}

const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
const ENGINE_START_TIMEOUT_MS = 90_000;

export function createOciSetupService(options: OciSetupServiceOptions = {}): OciSetupService {
	const platform = options.platform ?? process.platform;
	const environment = options.environment ?? process.env;
	const getuid = options.getuid ?? process.getuid;
	const run = options.run ?? runOciSetupCommand;
	const commandAvailable = async (command: string) =>
		(await run(command, ["--version"], PROBE_TIMEOUT_MS)).exitCode === 0;

	return {
		discover: async (preference) => {
			const runtimes: readonly OciRuntime[] = preference === "auto" ? ["docker", "podman"] : [preference];
			const installer = await findPackageInstaller(platform, getuid, commandAvailable);
			const result: OciSetupOption[] = [];
			for (const runtime of runtimes) {
				const binary = await findRuntimeBinary(runtime, platform, environment, run);
				if (binary) {
					result.push({
						runtime,
						label: `Prepare ${runtimeLabel(runtime, platform)}`,
						detail: "Runtime installed; initialize it and build the Pi worker image",
					});
				} else if (installer) {
					result.push({
						runtime,
						label: `Install ${runtimeLabel(runtime, platform)}`,
						detail: installerDescription(platform, runtime),
					});
				}
			}
			return result;
		},
		setup: async ({ runtime, image, onProgress }) => {
			let binary = await findRuntimeBinary(runtime, platform, environment, run);
			if (!binary) {
				const installer = await findPackageInstaller(platform, getuid, commandAvailable);
				if (!installer) throw new Error(manualInstallHint(platform, runtime));
				onProgress?.(`Installing ${runtimeLabel(runtime, platform)}...`);
				const elevated = await elevatedCommand(installer, platform, getuid, commandAvailable);
				await required(
					run,
					elevated.command,
					[...elevated.prefix, ...installer.args(runtime)],
					COMMAND_TIMEOUT_MS,
					"install",
				);
				binary = await findRuntimeBinary(runtime, platform, environment, run);
				if (!binary)
					throw new Error(
						`${runtimeLabel(runtime, platform)} was installed but is not visible yet. Restart Pi and retry.`,
					);
			}

			prependRuntimePath(binary, environment);
			onProgress?.(`Starting ${runtimeLabel(runtime, platform)}...`);
			await startRuntime(runtime, binary, platform, getuid, run, commandAvailable);
			await waitForRuntime(binary, runtime, platform, run);

			if (await imageReady(binary, image, run)) return;
			if (image !== DEFAULT_CONTAINER_SANDBOX_IMAGE) {
				throw new Error(
					`OCI image ${image} is not installed. Pull or build that custom image, then refresh the sandbox.`,
				);
			}
			onProgress?.("Building the bundled Pi speculative worker image...");
			const workerRoot = options.workerRoot ?? resolveWorkerRoot();
			await required(
				run,
				binary,
				["build", "--tag", image, "--file", path.join(workerRoot, "Containerfile"), workerRoot],
				COMMAND_TIMEOUT_MS,
				"worker image build",
			);
		},
	};
}

export async function runOciSetupCommand(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<OciSetupCommandResult> {
	try {
		const result = await invokeContainerRuntime({
			binaryPath: command,
			args,
			timeoutMs,
			maxOutputBytes: 16 * 1024,
		});
		return {
			exitCode: result.exitCode,
			output: result.timedOut ? `${result.output}\nCommand timed out.`.trim() : result.output,
		};
	} catch (error) {
		return { exitCode: null, output: error instanceof Error ? error.message : String(error) };
	}
}

async function findPackageInstaller(
	platform: NodeJS.Platform,
	getuid: (() => number) | undefined,
	available: (command: string) => Promise<boolean>,
): Promise<PackageInstaller | undefined> {
	if (platform === "win32") {
		return (await available("winget"))
			? {
					command: "winget",
					args: (runtime) => [
						"install",
						"--id",
						runtime === "docker" ? "Docker.DockerDesktop" : "RedHat.Podman",
						"--exact",
						"--accept-package-agreements",
						"--accept-source-agreements",
					],
					elevation: false,
				}
			: undefined;
	}
	if (platform === "darwin") {
		return (await available("brew"))
			? {
					command: "brew",
					args: (runtime) => (runtime === "docker" ? ["install", "--cask", "docker"] : ["install", "podman"]),
					elevation: false,
				}
			: undefined;
	}
	const managers: readonly PackageInstaller[] = [
		{
			command: "apt-get",
			args: (runtime) => ["install", "-y", runtime === "docker" ? "docker.io" : "podman"],
			elevation: true,
		},
		{
			command: "dnf",
			args: (runtime) => ["install", "-y", runtime === "docker" ? "moby-engine" : "podman"],
			elevation: true,
		},
		{ command: "pacman", args: (runtime) => ["-S", "--noconfirm", runtime], elevation: true },
		{ command: "zypper", args: (runtime) => ["--non-interactive", "install", runtime], elevation: true },
	];
	const canElevate = getuid?.() === 0 || (await available("pkexec"));
	if (!canElevate) return undefined;
	for (const manager of managers) if (await available(manager.command)) return manager;
	return undefined;
}

async function elevatedCommand(
	installer: PackageInstaller,
	platform: NodeJS.Platform,
	getuid: (() => number) | undefined,
	available: (command: string) => Promise<boolean>,
): Promise<{ readonly command: string; readonly prefix: readonly string[] }> {
	if (!installer.elevation || getuid?.() === 0 || platform === "win32")
		return { command: installer.command, prefix: [] };
	if (await available("pkexec")) return { command: "pkexec", prefix: [installer.command] };
	throw new Error(`Administrator authorization is required. ${manualInstallHint(platform, "podman")}`);
}

async function findRuntimeBinary(
	runtime: OciRuntime,
	platform: NodeJS.Platform,
	environment: NodeJS.ProcessEnv,
	run: OciSetupCommandRunner,
): Promise<string | undefined> {
	const candidates = [runtime, ...runtimePaths(runtime, platform, environment)];
	for (const candidate of candidates) {
		if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
		if ((await run(candidate, ["--version"], PROBE_TIMEOUT_MS)).exitCode === 0) return candidate;
	}
	return undefined;
}

function runtimePaths(runtime: OciRuntime, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
	if (platform !== "win32") return [];
	const programFiles = environment.ProgramFiles ?? "C:\\Program Files";
	const localAppData = environment.LOCALAPPDATA;
	if (runtime === "docker") return [path.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe")];
	return [
		path.join(programFiles, "RedHat", "Podman", "podman.exe"),
		...(localAppData ? [path.join(localAppData, "Programs", "Podman", "podman.exe")] : []),
	];
}

async function startRuntime(
	runtime: OciRuntime,
	binary: string,
	platform: NodeJS.Platform,
	getuid: (() => number) | undefined,
	run: OciSetupCommandRunner,
	available: (command: string) => Promise<boolean>,
): Promise<void> {
	if (runtime === "podman" && (platform === "win32" || platform === "darwin")) {
		const inspected = await run(binary, ["machine", "inspect"], PROBE_TIMEOUT_MS);
		if (inspected.exitCode !== 0)
			await required(run, binary, ["machine", "init"], COMMAND_TIMEOUT_MS, "machine init");
		await run(binary, ["machine", "start"], COMMAND_TIMEOUT_MS);
		return;
	}
	if (runtime !== "docker" || (await engineReady(binary, run))) return;
	if (platform === "win32") {
		const desktop = path.resolve(path.dirname(binary), "..", "..", "Docker Desktop.exe");
		if (!existsSync(desktop))
			throw new Error(
				"Docker Desktop is installed but its application could not be found. Start it manually, then refresh.",
			);
		const child = spawn(desktop, [], { detached: true, stdio: "ignore", windowsHide: true });
		child.unref();
		return;
	}
	if (platform === "darwin") {
		await required(run, "open", ["-a", "Docker"], PROBE_TIMEOUT_MS, "Docker Desktop start");
		return;
	}
	if (!(await available("systemctl")))
		throw new Error("Docker is installed but its daemon is not running. Start Docker, then refresh.");
	if (getuid?.() !== 0 && !(await available("pkexec"))) {
		throw new Error("Docker is installed but starting its daemon requires administrator authorization.");
	}
	const command = getuid?.() === 0 ? "systemctl" : "pkexec";
	const prefix = command === "pkexec" ? ["systemctl"] : [];
	await required(run, command, [...prefix, "start", "docker"], COMMAND_TIMEOUT_MS, "Docker daemon start");
}

async function waitForRuntime(
	binary: string,
	runtime: OciRuntime,
	platform: NodeJS.Platform,
	run: OciSetupCommandRunner,
): Promise<void> {
	const deadline = Date.now() + ENGINE_START_TIMEOUT_MS;
	do {
		if (await engineReady(binary, run)) return;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	} while (Date.now() < deadline);
	throw new Error(
		`${runtimeLabel(runtime, platform)} was installed but did not become ready. Complete its first-run setup, then refresh.`,
	);
}

async function engineReady(binary: string, run: OciSetupCommandRunner): Promise<boolean> {
	return (await run(binary, ["version"], PROBE_TIMEOUT_MS)).exitCode === 0;
}

async function imageReady(binary: string, image: string, run: OciSetupCommandRunner): Promise<boolean> {
	return (await run(binary, ["image", "inspect", image], PROBE_TIMEOUT_MS)).exitCode === 0;
}

async function required(
	run: OciSetupCommandRunner,
	command: string,
	args: readonly string[],
	timeoutMs: number,
	operation: string,
): Promise<void> {
	const result = await run(command, args, timeoutMs);
	if (result.exitCode === 0) return;
	throw new Error(`${operation} failed: ${oneLine(result.output)}`);
}

function prependRuntimePath(binary: string, environment: NodeJS.ProcessEnv): void {
	if (!path.isAbsolute(binary)) return;
	const directory = path.dirname(binary);
	const current = environment.PATH ?? "";
	if (!current.split(path.delimiter).some((entry) => path.resolve(entry) === directory)) {
		environment.PATH = `${directory}${path.delimiter}${current}`;
	}
}

function resolveWorkerRoot(): string {
	const packagePath = fileURLToPath(import.meta.resolve("@earendil-works/pi-speculative-action/package.json"));
	const root = path.join(path.dirname(packagePath), "native", "worker");
	if (!existsSync(path.join(root, "Containerfile")))
		throw new Error("The bundled Pi worker Containerfile is missing.");
	return root;
}

function runtimeLabel(runtime: OciRuntime, platform: NodeJS.Platform): string {
	return runtime === "docker" && platform !== "linux" ? "Docker Desktop" : runtime === "docker" ? "Docker" : "Podman";
}

function installerDescription(platform: NodeJS.Platform, runtime: OciRuntime): string {
	const manager = platform === "win32" ? "winget" : platform === "darwin" ? "Homebrew" : "the system package manager";
	return `${manager} will install ${runtimeLabel(runtime, platform)}; administrator approval or first-run setup may be required`;
}

function manualInstallHint(platform: NodeJS.Platform, runtime: OciRuntime): string {
	const manager =
		platform === "win32" ? "winget" : platform === "darwin" ? "Homebrew" : "a supported package manager and pkexec";
	return `No automatic installer is available. Install ${runtimeLabel(runtime, platform)} with ${manager}, then run /speculative-action refresh.`;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(-2_000) || "unknown error";
}
