import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	acquirePatternAwareStore,
	captureResourceVersion,
	createContainerSandboxProcessBackend,
	createFallbackSandboxProcessBackend,
	createSpeculativeActionExtension,
	createSpeculativeActionHost,
	createWorkspaceSandbox,
	makeSpeculativeActionRuntime,
	prepareSandboxWorkspace,
	releaseResourceVersion,
} from "../src/index.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = path.resolve(packageRoot, "../..");

describe("speculative action package boundary", () => {
	test("exports the runtime, integration, learning, resource, and sandbox entry points", () => {
		for (const exported of [
			makeSpeculativeActionRuntime,
			createSpeculativeActionHost,
			createSpeculativeActionExtension,
			acquirePatternAwareStore,
			captureResourceVersion,
			releaseResourceVersion,
			createContainerSandboxProcessBackend,
			createFallbackSandboxProcessBackend,
			createWorkspaceSandbox,
			prepareSandboxWorkspace,
		]) {
			expect(exported).toBeTypeOf("function");
		}
	});

	test("publishes an installable Pi extension without coupling Pi core back to speculation", async () => {
		const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
			exports: Record<string, unknown>;
			files: string[];
			pi?: { extensions?: string[] };
			peerDependencies?: Record<string, string>;
		};
		expect(Object.keys(manifest.exports).sort()).toEqual([".", "./extension", "./package.json"]);
		expect(manifest.files).toEqual(expect.arrayContaining(["dist", "native/sandbox", "native/worker"]));
		expect(manifest.pi?.extensions).toEqual(["./dist/extension.js"]);
		expect(manifest.peerDependencies).toMatchObject({
			"@earendil-works/pi-agent-core": "*",
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
		});

		const agentManifest = JSON.parse(
			await fs.readFile(path.join(workspaceRoot, "packages/agent/package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(agentManifest.dependencies).not.toHaveProperty("@earendil-works/pi-speculative-action");
		const agentSources = await readTypeScript(path.join(workspaceRoot, "packages/agent/src"));
		expect(agentSources).not.toContain("@earendil-works/pi-speculative-action");
	});

	test("leaves the upstream coding-agent source and manifest unaware of speculation", async () => {
		const codingSources = await readTypeScript(path.join(workspaceRoot, "packages/coding-agent/src"));
		expect(codingSources).not.toContain("pi-speculative-action");
		expect(codingSources).not.toContain("speculative-action");
		const codingManifest = JSON.parse(
			await fs.readFile(path.join(workspaceRoot, "packages/coding-agent/package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(codingManifest.dependencies).not.toHaveProperty("@earendil-works/pi-speculative-action");
	});
});

async function readTypeScript(directory: string): Promise<string> {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const contents = await Promise.all(
		entries.map(async (entry) => {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) return readTypeScript(target);
			return entry.isFile() && entry.name.endsWith(".ts") ? fs.readFile(target, "utf8") : "";
		}),
	);
	return contents.join("\n");
}
