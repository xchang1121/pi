import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	acquirePatternAwareStore,
	captureResourceVersion,
	createWorkspaceSandbox,
	installSpeculativeAction,
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
			installSpeculativeAction,
			acquirePatternAwareStore,
			captureResourceVersion,
			releaseResourceVersion,
			createWorkspaceSandbox,
			prepareSandboxWorkspace,
		]) {
			expect(exported).toBeTypeOf("function");
		}
	});

	test("publishes one package entry point without coupling agent-core back to speculation", async () => {
		const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
			exports: Record<string, unknown>;
			files: string[];
		};
		expect(Object.keys(manifest.exports).sort()).toEqual([".", "./package.json"]);
		expect(manifest.files).toEqual(expect.arrayContaining(["dist", "native/sandbox"]));

		const agentManifest = JSON.parse(
			await fs.readFile(path.join(workspaceRoot, "packages/agent/package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(agentManifest.dependencies).not.toHaveProperty("@earendil-works/pi-speculative-action");
		const agentSources = await readTypeScript(path.join(workspaceRoot, "packages/agent/src"));
		expect(agentSources).not.toContain("@earendil-works/pi-speculative-action");
	});

	test("keeps the coding-agent adapter on the public package API", async () => {
		const sources = await Promise.all(
			[
				"packages/coding-agent/src/core/settings-manager.ts",
				"packages/coding-agent/src/extensions/speculative-action/index.ts",
			].map((file) => fs.readFile(path.join(workspaceRoot, file), "utf8")),
		);
		const combined = sources.join("\n");
		expect(combined).toContain('from "@earendil-works/pi-speculative-action"');
		expect(combined).not.toMatch(/pi-speculative-action\//);
		expect(combined).not.toContain("packages/speculative-action/src");
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
