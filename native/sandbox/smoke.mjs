import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binaryArgument = process.argv.find((argument) => argument.startsWith("--binary="));
if (!binaryArgument) throw new Error("usage: node smoke.mjs --binary=FILE");
const binary = path.resolve(binaryArgument.slice("--binary=".length));
const protocolVersion = 4;
const check = await invoke(["--native-sandbox", "check"]);
if (check.status !== 0 || check.json.version !== protocolVersion || check.json.ready !== true) {
	throw new Error(`Native sandbox is not ready: ${check.stderr || check.stdout}`);
}

const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-smoke-"));
const sourceRoot = path.join(root, "source");
const sandboxRoot = path.join(root, "sandbox");
try {
	await mkdir(sourceRoot);
	await mkdir(sandboxRoot);
	const secret = path.join(sourceRoot, "secret.txt");
	await writeFile(secret, "source-secret");
	const command =
		process.platform === "win32"
			? `echo smoke>native-smoke.txt & type "${secret}" >nul 2>&1 & if errorlevel 1 (echo SOURCE_HIDDEN) else (echo SOURCE_VISIBLE)`
			: `printf smoke > native-smoke.txt; if cat ${shellQuote(secret)} >/dev/null 2>&1; then printf SOURCE_VISIBLE; else printf SOURCE_HIDDEN; fi`;
	const requestFile = path.join(root, "request.json");
	await writeFile(
		requestFile,
		JSON.stringify({
			version: protocolVersion,
			command,
			shell: process.platform === "win32" ? process.env.ComSpec : "/bin/sh",
			shellArgs: process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"],
			commandTransport: "argv",
			environment: process.env,
			cwd: sandboxRoot,
			sandboxRoot,
			sourceRoot,
			timeoutMs: 15_000,
			maxOutputBytes: 64 * 1024,
		}),
	);
	const execute = await invoke(["--native-sandbox", "execute", "--request", requestFile]);
	if (
		execute.status !== 0 ||
		execute.json.version !== protocolVersion ||
		execute.json.exit !== 0 ||
		execute.json.isolated !== true
	) {
		throw new Error(`Native sandbox execution failed: ${execute.stderr || execute.stdout}`);
	}
	if (typeof execute.json.output !== "string" || !execute.json.output.includes("SOURCE_HIDDEN")) {
		throw new Error(`Native sandbox exposed sourceRoot: ${execute.stdout}`);
	}
	if ((await readFile(path.join(sandboxRoot, "native-smoke.txt"), "utf8")).trim() !== "smoke") {
		throw new Error("Native sandbox did not persist its staged workspace mutation.");
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

function invoke(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const stdout = [];
		const stderr = [];
		const timer = setTimeout(() => child.kill(), 30_000);
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (status) => {
			clearTimeout(timer);
			const stdoutText = Buffer.concat(stdout).toString("utf8");
			const stderrText = Buffer.concat(stderr).toString("utf8");
			let json;
			try {
				json = JSON.parse(stdoutText);
			} catch {
				reject(new Error(`Native sandbox returned invalid JSON: ${stdoutText || stderrText}`));
				return;
			}
			resolve({ status, stdout: stdoutText, stderr: stderrText, json });
		});
	});
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
