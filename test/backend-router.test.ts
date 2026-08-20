import { describe, expect, it, vi } from "vitest";
import type { ToolProcessInvocation } from "../src/tool-settlement.ts";
import {
	createSandboxBackendRouter,
	type SandboxProcessBackend,
	type SandboxProcessBackendStatus,
} from "../src/workspace-sandbox.ts";

describe("SandboxBackendRouter", () => {
	it("routes health, fingerprint, preparation, and execution through a ready backend", async () => {
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

	it("does not retain a stale global route when backend readiness changes", async () => {
		let containerStatus = unavailable("starting");
		const container = backend(() => containerStatus, "container");
		const native = backend(ready("native", "native:v1"), "native");
		const router = createSandboxBackendRouter("auto", [
			{ id: "container", backend: container.value },
			{ id: "native", backend: native.value },
		]);

		await expect(router.fingerprint()).resolves.toBe("native:v1");
		containerStatus = ready("container", "container:v2");
		await expect(router.inspect()).resolves.toMatchObject({ active: { backend: "container" } });
		await expect(router.fingerprint()).resolves.toBe("container:v2");
	});

	it("rejects a route switch between K(a) fingerprinting and process open", async () => {
		let containerStatus = unavailable("starting");
		const container = backend(() => containerStatus, "container");
		const native = backend(ready("native", "native:v1"), "native");
		const router = createSandboxBackendRouter("auto", [
			{ id: "container", backend: container.value },
			{ id: "native", backend: native.value },
		]);
		const expectedFingerprint = await router.fingerprint();
		containerStatus = ready("container", "container:v2");

		await expect(
			router.open({ parent: "root", signal: new AbortController().signal, expectedFingerprint }),
		).rejects.toThrow("changed after K(a) construction");
		expect(container.calls).not.toContain("open");
	});

	it("selects a backend for each concrete process invocation", async () => {
		const native = backend(ready("native", "native:v1"), "native", (invocation) =>
			invocation.shell.toLowerCase().endsWith("cmd.exe"),
		);
		const container = backend(ready("container", "container:v2"), "container");
		const router = createSandboxBackendRouter("auto", [
			{ id: "native", backend: native.value },
			{ id: "container", backend: container.value },
		]);
		const cmd = invocation("C:\\Windows\\System32\\cmd.exe");
		const gitBash = invocation("C:\\Program Files\\Git\\bin\\bash.exe");

		await expect(router.fingerprint(cmd)).resolves.toBe("native:v1");
		await expect(router.fingerprint(gitBash)).resolves.toBe("container:v2");
		await router.prepare({ invocation: gitBash });
		await router.open({ parent: "root", signal: new AbortController().signal, invocation: cmd });
		expect(native.calls.filter((call) => call === "open")).toHaveLength(1);
		expect(container.calls.filter((call) => call === "prepare")).toHaveLength(1);
	});
});

function backend(
	status: SandboxProcessBackendStatus | (() => SandboxProcessBackendStatus),
	name: string,
	supports?: (invocation: ToolProcessInvocation) => boolean,
): { readonly value: SandboxProcessBackend; readonly calls: string[] } {
	const calls: string[] = [];
	const current = () => (typeof status === "function" ? status() : status);
	return {
		calls,
		value: {
			...(supports ? { supports } : {}),
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

function invocation(shell: string): ToolProcessInvocation {
	return {
		command: "echo ok",
		cwd: "C:\\workspace",
		environment: {},
		shell,
		shellArgs: ["-c"],
		commandTransport: "argv",
	};
}

function ready(name: string, fingerprint: string): SandboxProcessBackendStatus {
	return { backend: name, state: "ready", source: "test", detail: `${name} ready`, fingerprint };
}

function unavailable(detail: string): SandboxProcessBackendStatus {
	return { backend: "workspace", state: "unavailable", source: "none", detail };
}
