import { describe, expect, it, vi } from "vitest";
import {
	createSandboxBackendRouter,
	type SandboxProcessBackend,
	type SandboxProcessBackendStatus,
} from "../src/workspace-sandbox.ts";

describe("SandboxBackendRouter", () => {
	it("routes health, fingerprint, preparation, and execution through one selected backend", async () => {
		const container = backend(unavailable("container missing"), "container");
		const native = backend(ready("native", "native:v1"), "native");
		const router = createSandboxBackendRouter("auto", [
			{ id: "container", backend: container.value },
			{ id: "native", backend: native.value },
		]);

		await expect(router.inspect()).resolves.toMatchObject({
			configured: "auto",
			active: { backend: "native", fingerprint: "native:v1" },
			candidates: { container: { state: "unavailable" }, native: { state: "ready" } },
		});
		await expect(router.fingerprint()).resolves.toBe("native:v1");
		await router.prepare({});
		await expect(router.open({ parent: "root", signal: new AbortController().signal })).resolves.toMatchObject({
			processRoot: "native",
		});
		expect(native.calls).toEqual(expect.arrayContaining(["fingerprint", "prepare", "open"]));
		expect(container.calls).not.toEqual(expect.arrayContaining(["fingerprint", "prepare", "open"]));
	});

	it("does not silently use another backend when a specific route is configured", async () => {
		const container = backend(unavailable("container missing"), "container");
		const native = backend(ready("native", "native:v1"), "native");
		const router = createSandboxBackendRouter("container", [
			{ id: "container", backend: container.value },
			{ id: "native", backend: native.value },
		]);

		await expect(router.check()).resolves.toMatchObject({ state: "unavailable", detail: "container missing" });
		await expect(router.fingerprint()).rejects.toThrow("container missing");
		expect(native.calls).not.toContain("fingerprint");
	});

	it("changes active health and K(a) fingerprint together after an explicit refresh", async () => {
		let containerStatus = unavailable("starting");
		const container = backend(() => containerStatus, "container");
		const native = backend(ready("native", "native:v1"), "native");
		const router = createSandboxBackendRouter("auto", [
			{ id: "container", backend: container.value },
			{ id: "native", backend: native.value },
		]);

		await expect(router.fingerprint()).resolves.toBe("native:v1");
		containerStatus = ready("container", "container:v2");
		await expect(router.inspect()).resolves.toMatchObject({ active: { backend: "native" } });
		await expect(router.inspect({ refresh: true })).resolves.toMatchObject({ active: { backend: "container" } });
		await expect(router.fingerprint()).resolves.toBe("container:v2");
	});
});

function backend(
	status: SandboxProcessBackendStatus | (() => SandboxProcessBackendStatus),
	name: string,
): { readonly value: SandboxProcessBackend; readonly calls: string[] } {
	const calls: string[] = [];
	const current = () => (typeof status === "function" ? status() : status);
	return {
		calls,
		value: {
			check: vi.fn(async () => {
				calls.push("check");
				return current();
			}),
			fingerprint: vi.fn(async () => {
				calls.push("fingerprint");
				return current().fingerprint ?? `${name}:unavailable`;
			}),
			prepare: vi.fn(async () => {
				calls.push("prepare");
			}),
			open: vi.fn(async () => {
				calls.push("open");
				return { processRoot: name, execute: vi.fn(), close: vi.fn() };
			}),
			dispose: vi.fn(),
		},
	};
}

function ready(name: string, fingerprint: string): SandboxProcessBackendStatus {
	return { backend: name, state: "ready", source: "test", detail: `${name} ready`, fingerprint };
}

function unavailable(detail: string): SandboxProcessBackendStatus {
	return { backend: "workspace", state: "unavailable", source: "none", detail };
}
