import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPiActionKey } from "../src/common.ts";
import { fingerprintActionResources } from "../src/resource-version.ts";

describe("speculative resource versions", () => {
	it("changes a read fingerprint when its file changes", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-speculative-resource-"));
		try {
			await writeFile(path.join(cwd, "README.md"), "first");
			const action = buildPiActionKey("read", { path: "README.md" }, cwd);
			expect(action).toBeDefined();
			if (!action) return;
			const before = await fingerprintActionResources(action, cwd);
			await writeFile(path.join(cwd, "README.md"), "second-version");
			const after = await fingerprintActionResources(action, cwd);

			expect(after).not.toBe(before);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("changes a find fingerprint when a nested directory entry changes", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-speculative-resource-"));
		try {
			await mkdir(path.join(cwd, "src"));
			await writeFile(path.join(cwd, "src", "a.ts"), "export const a = 1;");
			const action = buildPiActionKey("find", { pattern: "**/*.ts", path: "src" }, cwd);
			expect(action).toBeDefined();
			if (!action) return;
			const before = await fingerprintActionResources(action, cwd);
			await writeFile(path.join(cwd, "src", "b.ts"), "export const b = 2;");
			const after = await fingerprintActionResources(action, cwd);

			expect(after).not.toBe(before);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("tracks a sandbox bash result against the complete Pi workspace", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-speculative-resource-"));
		try {
			await mkdir(path.join(cwd, "src"));
			await writeFile(path.join(cwd, "src", "value.txt"), "one");
			await writeFile(path.join(cwd, "outside.txt"), "outside-one");
			const action = buildPiActionKey("bash", { command: "cat value.txt", workdir: "src" }, cwd);
			expect(action).toBeDefined();
			if (!action) return;
			const before = await fingerprintActionResources(action, cwd);
			await writeFile(path.join(cwd, "outside.txt"), "outside-two");
			const afterWorkspaceChange = await fingerprintActionResources(action, cwd);
			expect(afterWorkspaceChange).not.toBe(before);

			await writeFile(path.join(cwd, "src", "value.txt"), "two");
			expect(await fingerprintActionResources(action, cwd)).not.toBe(afterWorkspaceChange);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
