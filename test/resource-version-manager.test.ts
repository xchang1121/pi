import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildActionKey } from "../src/common.ts";
import {
	captureResourceVersion,
	closeResourceVersionManagers,
	ResourceVersionManager,
	releaseResourceVersion,
	resourceDependencies,
	validateResourceVersion,
	watchResourceVersion,
} from "../src/resource-version.ts";

const roots: string[] = [];

afterEach(async () => {
	closeResourceVersionManagers();
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("speculative action resource versions", () => {
	test("validates an unchanged watched subtree without scanning files or reading bytes", async () => {
		const root = await workspace();
		await fs.mkdir(path.join(root, "src"), { recursive: true });
		await Promise.all(
			Array.from({ length: 32 }, (_, index) =>
				fs.writeFile(path.join(root, "src", `value-${index}.ts`), `export const value${index} = ${index}\n`),
			),
		);
		const token = await captureResourceVersion(action("grep", ["src"]), root);
		const result = await validateResourceVersion(token);

		expect(token.captureBytes).toBe(0);
		expect(token.captureFiles).toBe(0);
		expect(result).toMatchObject({ expired: false, mode: "watcher", bytesRead: 0, filesRead: 0 });
	});

	test("expires file content dependencies after a write", async () => {
		const root = await workspace();
		const file = path.join(root, "src", "value.ts");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "export const value = 1\n");
		const token = await captureResourceVersion(action("read", ["src/value.ts"]), root);

		await fs.writeFile(file, "export const value = 2\n");
		await settleWatcher();

		const result = await validateResourceVersion(token);
		expect(result.expired).toBe(true);
		expect(result.mode).toBe("watcher");
		expect(result.bytesRead).toBe(0);
	});

	test("expires file content dependencies after atomic replacement", async () => {
		const root = await workspace();
		const file = path.join(root, "value.ts");
		const replacement = path.join(root, "replacement.ts");
		await fs.writeFile(file, "export const value = 1\n");
		const token = await captureResourceVersion(action("read", ["value.ts"]), root);

		await fs.writeFile(replacement, "export const value = 2\n");
		await fs.rename(replacement, file);
		await settleWatcher();

		expect((await validateResourceVersion(token)).expired).toBe(true);
	});

	test("keeps a file dependency valid after an unrelated sibling changes", async () => {
		const root = await workspace();
		const tracked = path.join(root, "tracked.ts");
		const sibling = path.join(root, "sibling.ts");
		await fs.writeFile(tracked, "tracked\n");
		await fs.writeFile(sibling, "one\n");
		const token = await captureResourceVersion(action("read", ["tracked.ts"]), root);

		await fs.writeFile(sibling, "two\n");
		await settleWatcher();

		expect(await validateResourceVersion(token)).toMatchObject({
			expired: false,
			mode: "watcher",
			bytesRead: 0,
			filesRead: 0,
		});
	});

	test("keeps find results for content-only writes and expires them for entry changes", async () => {
		const root = await workspace();
		const file = path.join(root, "src", "value.ts");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "one\n");
		const token = await captureResourceVersion(action("find", ["src"]), root);

		await fs.writeFile(file, "two\n");
		await settleWatcher();
		expect((await validateResourceVersion(token)).expired).toBe(false);

		await fs.writeFile(path.join(root, "src", "added.ts"), "added\n");
		await settleWatcher();
		expect((await validateResourceVersion(token)).expired).toBe(true);
	});

	test("expires find results when ignore rules change", async () => {
		const root = await workspace();
		await fs.mkdir(path.join(root, "src"), { recursive: true });
		await fs.writeFile(path.join(root, "src", "value.ts"), "one\n");
		await fs.writeFile(path.join(root, ".gitignore"), "generated/\n");
		const token = await captureResourceVersion(action("find", ["src"]), root);

		await fs.writeFile(path.join(root, ".gitignore"), "generated/\nignored/\n");
		await settleWatcher();

		expect((await validateResourceVersion(token)).expired).toBe(true);
	});

	test("tracks grep as a subtree-content dependency", async () => {
		const root = await workspace();
		const file = path.join(root, "src", "value.ts");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "needle\n");
		const token = await captureResourceVersion(action("grep", ["src"]), root);

		await fs.writeFile(file, "changed\n");
		await settleWatcher();

		expect((await validateResourceVersion(token)).expired).toBe(true);
	});

	test("tracks LSP workspace operations across files but keeps document symbols file-scoped", async () => {
		const root = await workspace();
		await fs.mkdir(path.join(root, "src"), { recursive: true });
		await fs.writeFile(path.join(root, "src", "one.ts"), "export const one = 1\n");
		await fs.writeFile(path.join(root, "src", "two.ts"), "export const two = 2\n");
		const workspaceToken = await captureResourceVersion(lspAction("diagnostics", "src/one.ts"), root);
		const documentToken = await captureResourceVersion(lspAction("documentSymbol", "src/one.ts"), root);

		await fs.writeFile(path.join(root, "src", "two.ts"), "export const two = 3\n");
		await settleWatcher();

		expect((await validateResourceVersion(workspaceToken)).expired).toBe(true);
		expect((await validateResourceVersion(documentToken)).expired).toBe(false);
	});

	test("ignores adoption staging files in tree-scoped dependencies", async () => {
		const root = await workspace();
		await fs.writeFile(path.join(root, "value.ts"), "one\n");
		const token = await captureResourceVersion(action("grep", ["."]), root);
		const temporary = path.join(root, ".pi-speculative-test.tmp");

		await fs.writeFile(temporary, "staged\n");
		await fs.rm(temporary);
		await settleWatcher();

		expect((await validateResourceVersion(token)).expired).toBe(false);
	});

	test("fails closed when a token is absent or exact validation detects a change", async () => {
		expect((await validateResourceVersion(undefined)).expired).toBe(true);

		const root = await workspace();
		const file = path.join(root, "value.ts");
		await fs.writeFile(file, "one\n");
		const key = action("read", ["value.ts"]);
		const manager = new ResourceVersionManager(root, { watch: false });
		const token = await manager.capture(resourceDependencies(key, root));

		await fs.writeFile(file, "two\n");
		const result = await manager.validate(token);
		manager.close();

		expect(result.expired).toBe(true);
		expect(result.mode).toBe("exact");
		expect(result.bytesRead).toBeGreaterThan(0);
	});

	test("notifies active cache owners when a dependency becomes stale", async () => {
		const root = await workspace();
		const file = path.join(root, "value.ts");
		await fs.writeFile(file, "one\n");
		const token = await captureResourceVersion(action("read", ["value.ts"]), root);
		const invalidated = new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("resource invalidation timed out")), 3000);
			const release = watchResourceVersion(token, (changedPath) => {
				clearTimeout(timeout);
				release();
				resolve(changedPath);
			});
		});

		await fs.writeFile(file, "two\n");

		expect(path.resolve(await invalidated)).toBe(path.resolve(file));
	});

	test("releases an unwatched sandbox token and retires its workspace manager", async () => {
		const root = await workspace();
		await fs.writeFile(path.join(root, "value.txt"), "one\n");
		const key = buildActionKey({
			tool: "bash",
			execution: "sandbox",
			resources: ["."],
			input: { command: "cat value.txt" },
		});
		const first = await captureResourceVersion(key, root);

		releaseResourceVersion(first);
		const second = await captureResourceVersion(key, root);

		expect(second.manager).not.toBe(first.manager);
		releaseResourceVersion(second);
	});

	test("keeps a shared manager alive until every unwatched sandbox token is released", async () => {
		const root = await workspace();
		const key = buildActionKey({
			tool: "bash",
			execution: "sandbox",
			resources: ["."],
			input: { command: "echo test" },
		});
		const first = await captureResourceVersion(key, root);
		const second = await captureResourceVersion(key, root);

		releaseResourceVersion(first);
		const third = await captureResourceVersion(key, root);

		expect(third.manager).toBe(second.manager);
		releaseResourceVersion(second);
		releaseResourceVersion(third);
	});
});

function action(tool: "read" | "grep" | "find", resources: ReadonlyArray<string>) {
	return buildActionKey({
		tool,
		execution: "resource_cached",
		resources,
		input: tool === "read" ? { path: resources[0] } : { path: resources[0], pattern: "*" },
	});
}

function lspAction(operation: string, filePath: string) {
	return buildActionKey({
		tool: "lsp",
		execution: "resource_cached",
		resources: [filePath],
		input: { operation, filePath, line: 0, character: 0 },
	});
}

async function workspace() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-resource-version-"));
	roots.push(root);
	return root;
}

async function settleWatcher() {
	await new Promise((resolve) => setTimeout(resolve, 80));
}
