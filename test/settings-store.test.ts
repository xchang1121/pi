import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpeculativeActionSettingsStore } from "../src/settings-store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("extension-owned speculative settings", () => {
	it("persists global and project layers without writing Pi settings.json", async () => {
		const { root, agent, cwd } = await fixture();
		const store = new SpeculativeActionSettingsStore(cwd, agent);
		await store.load();
		store.set({ enabled: true, candidateLimit: 4, patternAware: { enabled: true, beamWidth: 2 } });
		await store.flush();
		store.setScope("project");
		store.set({ candidateLimit: 2, patternAware: { beamWidth: 5 } });
		await store.flush();

		const reloaded = new SpeculativeActionSettingsStore(cwd, agent);
		await reloaded.load();
		expect(reloaded.scope).toBe("project");
		expect(reloaded.get()).toMatchObject({
			enabled: true,
			candidateLimit: 2,
			patternAware: { enabled: true, beamWidth: 5 },
		});
		await expect(readFile(path.join(root, ".pi", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes only the selected layer and falls back to global settings", async () => {
		const { agent, cwd } = await fixture();
		const store = new SpeculativeActionSettingsStore(cwd, agent);
		await store.load();
		store.set({ enabled: true, candidateLimit: 6 });
		await store.flush();
		store.setScope("project");
		store.set({ enabled: false });
		await store.flush();
		expect(store.get()?.enabled).toBe(false);
		store.set(undefined);
		await store.flush();
		expect(store.get()).toMatchObject({ enabled: true, candidateLimit: 6 });
	});

	it("treats malformed optional layers as absent", async () => {
		const { agent, cwd } = await fixture();
		await writeFile(path.join(agent, "speculative-action.json"), "{broken", "utf8");
		const store = new SpeculativeActionSettingsStore(cwd, agent);
		await expect(store.load()).resolves.toBeUndefined();
		expect(store.get()).toBeUndefined();
	});
});

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-spec-settings-"));
	roots.push(root);
	const agent = path.join(root, "agent");
	const cwd = path.join(root, "workspace");
	await Promise.all([mkdir(agent, { recursive: true }), mkdir(cwd, { recursive: true })]);
	return { root, agent, cwd };
}
