// Modified for Pi's speculative-action sandbox migration.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 5;
const crate = path.dirname(fileURLToPath(import.meta.url));
const requested = parseArguments(process.argv.slice(2));
const target = {
	os: requested.os ?? process.platform,
	arch: requested.arch ?? process.arch,
	libc: requested.libc ?? (process.platform === "linux" ? detectLinuxLibc() : undefined),
};
if (!isSupportedPlatform(target.os) || (target.arch !== "arm64" && target.arch !== "x64")) {
	throw new Error("Native sandbox supports linux, darwin, and win32 on arm64 or x64.");
}
if (target.os === "linux" && target.libc === undefined) {
	throw new Error("Cross-building a Linux native sandbox requires --libc=gnu or --libc=musl.");
}
if (target.os !== "linux" && target.libc !== undefined) {
	throw new Error("--libc is valid only for Linux targets.");
}

const rust = rustTarget(target);
const native =
	target.os === process.platform &&
	target.arch === process.arch &&
	(target.os !== "linux" || target.libc === detectLinuxLibc());
const executable = target.os === "win32" ? "pi-sandbox-native.exe" : "pi-sandbox-native";
const command = [...(rust.toolchain ? [`+${rust.toolchain}`] : []), "build", "--release", ...(native ? [] : ["--target", rust.triple])];
const cargo = spawnSync("cargo", command, {
	cwd: crate,
	env: { ...process.env, ...rust.environment },
	stdio: "inherit",
});
if (cargo.error) throw new Error(`Failed to start cargo: ${cargo.error.message}`);
if (cargo.status !== 0) throw new Error(`Failed to build native sandbox for ${rust.triple}.`);

const compiled = path.join(path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(crate, "target")), ...(native ? [] : [rust.triple]), "release", executable);
const assetRoot = path.resolve(requested.assetRoot ?? path.join(crate, "prebuilds"));
const platformKey = target.os === "linux" ? `${target.os}-${target.arch}-${target.libc}` : `${target.os}-${target.arch}`;
const outputDirectory = path.join(assetRoot, platformKey);
const output = path.join(outputDirectory, executable);
await mkdir(outputDirectory, { recursive: true });
await copyFile(compiled, output);
await chmod(output, 0o700).catch(() => undefined);
const sha256 = createHash("sha256").update(await readFile(output)).digest("hex");
const manifestPath = path.join(assetRoot, "manifest.json");
const current = await readManifest(manifestPath);
const entry = {
	platform: target.os,
	arch: target.arch,
	...(target.libc ? { libc: target.libc } : {}),
	file: path.relative(assetRoot, output).split(path.sep).join("/"),
	sha256,
};
const assets = [...current.assets.filter((asset) => asset.file !== entry.file), entry].sort((left, right) =>
	left.file.localeCompare(right.file),
);
await writeFile(
	manifestPath,
	`${JSON.stringify({ version: 1, protocolVersion: PROTOCOL_VERSION, assets }, undefined, "\t")}\n`,
);
console.log(output);

function parseArguments(args) {
	const result = {};
	for (const argument of args) {
		const [name, value] = argument.split("=", 2);
		if (!value) throw new Error(`Expected --name=value, received ${argument}`);
		if (name === "--os") result.os = value;
		else if (name === "--arch") result.arch = value;
		else if (name === "--libc") result.libc = value;
		else if (name === "--asset-root") result.assetRoot = value;
		else throw new Error(`Unknown native sandbox build option: ${name}`);
	}
	if (result.libc !== undefined && result.libc !== "gnu" && result.libc !== "musl") {
		throw new Error("--libc must be gnu or musl.");
	}
	return result;
}

function rustTarget(target) {
	if (target.os === "win32") {
		const configured = process.env.PI_WINDOWS_RUST_ABI;
		const gnu = configured === "gnu" || (configured !== "msvc" && process.platform === "win32" && !hasCommand("link.exe"));
		if (target.arch === "x64" && gnu) {
			const toolchain = "stable-x86_64-pc-windows-gnu";
			const targetLibdir = spawnSync("rustc", [`+${toolchain}`, "--print", "target-libdir"], {
				encoding: "utf8",
			});
			if (targetLibdir.status !== 0) throw new Error(`Failed to inspect ${toolchain}.`);
			const targetRoot = path.dirname(targetLibdir.stdout.trim());
			const rustBin = path.join(targetRoot, "bin");
			const foundLlvmDlltool = findCommand("llvm-dlltool.exe");
			const llvmBin = process.env.LLVM_MINGW_BIN ?? (foundLlvmDlltool ? path.dirname(foundLlvmDlltool) : undefined);
			const llvmDlltool = llvmBin ? path.join(llvmBin, "llvm-dlltool.exe") : undefined;
			return {
				triple: "x86_64-pc-windows-gnu",
				toolchain,
				environment: {
					PATH: [llvmBin, rustBin, path.join(rustBin, "self-contained"), process.env.PATH]
						.filter(Boolean)
						.join(path.delimiter),
					CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: path.join(rustBin, "rust-lld.exe"),
					RUSTFLAGS: [
						process.env.RUSTFLAGS,
						"-C link-self-contained=yes",
						...(llvmDlltool ? [`-C dlltool=${llvmDlltool}`] : []),
					]
						.filter(Boolean)
						.join(" "),
				},
			};
		}
		return {
			triple: target.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc",
			toolchain: undefined,
			environment: {},
		};
	}
	if (target.os === "darwin") {
		return {
			triple: target.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
			toolchain: undefined,
			environment: {},
		};
	}
	const architecture = target.arch === "arm64" ? "aarch64" : "x86_64";
	return { triple: `${architecture}-unknown-linux-${target.libc}`, toolchain: undefined, environment: {} };
}

async function readManifest(file) {
	try {
		const value = JSON.parse(await readFile(file, "utf8"));
		if (value.version !== 1 || value.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(value.assets)) {
			throw new Error("Existing native sandbox manifest is incompatible.");
		}
		return value;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { assets: [] };
		throw error;
	}
}

function detectLinuxLibc() {
	return process.report?.getReport().header.glibcVersionRuntime ? "gnu" : "musl";
}

function isSupportedPlatform(value) {
	return value === "linux" || value === "darwin" || value === "win32";
}

function hasCommand(command) {
	return findCommand(command) !== undefined;
}

function findCommand(command) {
	const locator = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(locator, [command], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim().split(/\r?\n/, 1)[0] : undefined;
}
