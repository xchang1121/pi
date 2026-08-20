import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as packageApi from "../src/index.ts";
import {
	acquirePatternAwareStore,
	captureResourceVersion,
	createSpeculativeActionExtension,
	createSpeculativeActionHost,
	createWorkspaceSandbox,
	ExecutionWorldRouter,
	makeSpeculativeActionRuntime,
	prepareSandboxWorkspace,
	releaseResourceVersion,
} from "../src/index.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = path.resolve(packageRoot, "../..");

describe("speculative action package boundary", () => {
	test("exports runtime, learning, resource, and file-mutation entry points", () => {
		for (const exported of [
			makeSpeculativeActionRuntime,
			createSpeculativeActionHost,
			createSpeculativeActionExtension,
			acquirePatternAwareStore,
			captureResourceVersion,
			releaseResourceVersion,
			createWorkspaceSandbox,
			prepareSandboxWorkspace,
			ExecutionWorldRouter,
		]) {
			expect(exported).toBeTypeOf("function");
		}
		for (const internal of [
			"ActorAction",
			"CandidateExecution",
			"PlanRuntime",
			"PostSettlementQueue",
			"ResultCache",
			"SourceGeneration",
			"SpeculationScheduler",
		]) {
			expect(packageApi).not.toHaveProperty(internal);
		}
	});

	test("keeps source implementations and Pi dependencies outside the host-neutral runtime", async () => {
		const core = await Promise.all(
			["runtime.ts", "runtime-engine.ts", "settlement.ts"].map((file) =>
				fs.readFile(path.join(packageRoot, "src", file), "utf8"),
			),
		);
		expect(core.join("\n")).not.toMatch(/pattern-aware|@earendil-works\/pi-/);
	});

	test("publishes an installable Pi extension without coupling Pi core back to speculation", async () => {
		const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
			exports: Record<string, unknown>;
			files: string[];
			scripts?: Record<string, string>;
			pi?: { extensions?: string[] };
			peerDependencies?: Record<string, string>;
		};
		expect(Object.keys(manifest.exports).sort()).toEqual([".", "./extension", "./package.json"]);
		expect(manifest.files).toEqual(["dist", "README.md", "README-CN.md", "CHANGELOG.md"]);
		expect(manifest.scripts?.build).toMatch(/^shx rm -rf dist && /);
		expect(Object.keys(manifest.scripts ?? {})).not.toEqual(
			expect.arrayContaining(["build:native", "build:worker", "generate:native-manifest", "smoke:native"]),
		);
		await expect(fs.stat(path.join(packageRoot, "native", "sandbox"))).rejects.toThrow();
		await expect(fs.stat(path.join(packageRoot, "native", "worker"))).rejects.toThrow();
		for (const removed of ["container-sandbox.ts", "native-sandbox.ts", "oci-setup.ts"]) {
			await expect(fs.stat(path.join(packageRoot, "src", removed))).rejects.toThrow();
		}
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
