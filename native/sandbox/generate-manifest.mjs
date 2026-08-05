import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const crate = path.dirname(fileURLToPath(import.meta.url));
const assetRootArgument = process.argv.find((argument) => argument.startsWith("--asset-root="));
const assetRoot = path.resolve(assetRootArgument?.slice("--asset-root=".length) ?? path.join(crate, "prebuilds"));
const allowPartial = process.argv.includes("--allow-partial");
const targets = [
	{ platform: "linux", arch: "x64", libc: "gnu", directory: "linux-x64-gnu" },
	{ platform: "linux", arch: "arm64", libc: "gnu", directory: "linux-arm64-gnu" },
	{ platform: "darwin", arch: "x64", directory: "darwin-x64" },
	{ platform: "darwin", arch: "arm64", directory: "darwin-arm64" },
	{ platform: "win32", arch: "x64", directory: "win32-x64" },
	{ platform: "win32", arch: "arm64", directory: "win32-arm64" },
];
const assets = [];
for (const target of targets) {
	const executable = target.platform === "win32" ? "pi-sandbox-native.exe" : "pi-sandbox-native";
	const file = `${target.directory}/${executable}`;
	const absolute = path.join(assetRoot, file);
	if (!(await isFile(absolute))) {
		if (allowPartial) continue;
		throw new Error(`Missing native sandbox release asset: ${absolute}`);
	}
	assets.push({
		platform: target.platform,
		arch: target.arch,
		...(target.libc ? { libc: target.libc } : {}),
		file,
		sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"),
	});
}
await writeFile(
	path.join(assetRoot, "manifest.json"),
	`${JSON.stringify({ version: 1, protocolVersion: 1, assets }, undefined, "\t")}\n`,
);

async function isFile(file) {
	try {
		return (await stat(file)).isFile();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
