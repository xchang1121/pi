import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOciSetupService, type OciSetupCommandRunner } from "../src/oci-setup.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("speculative-action OCI setup", () => {
	it("installs Docker with winget, finds its new binary, and builds the bundled worker", async () => {
		const root = await testRoot("pi-oci-windows-");
		const workerRoot = await worker(root);
		const docker = path.join(root, "Docker", "Docker", "resources", "bin", "docker.exe");
		let installed = false;
		const run = vi.fn<OciSetupCommandRunner>(async (command, args) => {
			if (command === "winget" && args[0] === "--version") return ok();
			if (command === "winget" && args[0] === "install") {
				installed = true;
				await mkdir(path.dirname(docker), { recursive: true });
				await writeFile(docker, "");
				return ok();
			}
			if (command === docker && args[0] === "--version") return installed ? ok() : fail();
			if (command === docker && args[0] === "version") return ok();
			if (command === docker && args[0] === "image") return fail("missing image");
			if (command === docker && args[0] === "build") return ok();
			return fail();
		});
		const environment = { ProgramFiles: root, PATH: "C:\\Windows" };
		const service = createOciSetupService({ platform: "win32", environment, run, workerRoot });

		await expect(service.discover("docker")).resolves.toEqual([
			expect.objectContaining({ runtime: "docker", label: "Install Docker Desktop" }),
		]);
		await service.setup({ runtime: "docker", image: "pi-speculative-worker:latest" });

		expect(run).toHaveBeenCalledWith(
			"winget",
			expect.arrayContaining(["install", "--id", "Docker.DockerDesktop", "--exact"]),
			expect.any(Number),
		);
		expect(run).toHaveBeenCalledWith(
			docker,
			[
				"build",
				"--tag",
				"pi-speculative-worker:latest",
				"--file",
				path.join(workerRoot, "Containerfile"),
				workerRoot,
			],
			expect.any(Number),
		);
		expect(environment.PATH).toContain(path.dirname(docker));
	});

	it("initializes a Podman machine before building on macOS", async () => {
		const root = await testRoot("pi-oci-podman-");
		const workerRoot = await worker(root);
		let started = false;
		const run = vi.fn<OciSetupCommandRunner>(async (command, args) => {
			if (command === "podman" && args[0] === "--version") return ok();
			if (command === "podman" && args[0] === "machine" && args[1] === "inspect") return fail();
			if (command === "podman" && args[0] === "machine" && args[1] === "init") return ok();
			if (command === "podman" && args[0] === "machine" && args[1] === "start") {
				started = true;
				return ok();
			}
			if (command === "podman" && args[0] === "version") return started ? ok() : fail();
			if (command === "podman" && args[0] === "image") return fail();
			if (command === "podman" && args[0] === "build") return ok();
			return fail();
		});
		const service = createOciSetupService({ platform: "darwin", run, workerRoot });

		await service.setup({ runtime: "podman", image: "pi-speculative-worker:latest" });

		expect(run.mock.calls.map((call) => call[1].slice(0, 2))).toEqual(
			expect.arrayContaining([
				["machine", "inspect"],
				["machine", "init"],
				["machine", "start"],
				["build", "--tag"],
			]),
		);
	});

	it("uses pkexec with a supported Linux package manager", async () => {
		const root = await testRoot("pi-oci-linux-");
		const workerRoot = await worker(root);
		let installed = false;
		const run = vi.fn<OciSetupCommandRunner>(async (command, args) => {
			if ((command === "pkexec" || command === "apt-get") && args[0] === "--version") return ok();
			if (command === "pkexec" && args.slice(0, 2).join(" ") === "apt-get install") {
				installed = true;
				return ok();
			}
			if (command === "podman" && args[0] === "--version") return installed ? ok() : fail();
			if (command === "podman" && args[0] === "version") return ok();
			if (command === "podman" && args[0] === "image") return fail();
			if (command === "podman" && args[0] === "build") return ok();
			return fail();
		});
		const service = createOciSetupService({ platform: "linux", getuid: () => 1000, run, workerRoot });

		await service.setup({ runtime: "podman", image: "pi-speculative-worker:latest" });

		expect(run).toHaveBeenCalledWith("pkexec", ["apt-get", "install", "-y", "podman"], expect.any(Number));
	});

	it("does not overwrite a missing custom image with the bundled worker", async () => {
		const run = vi.fn<OciSetupCommandRunner>(async (command, args) => {
			if (command === "docker" && (args[0] === "--version" || args[0] === "version")) return ok();
			if (command === "docker" && args[0] === "image") return fail("not found");
			return fail();
		});
		const service = createOciSetupService({ platform: "linux", getuid: () => 0, run });

		await expect(service.setup({ runtime: "docker", image: "private/worker:v2" })).rejects.toThrow(
			"Pull or build that custom image",
		);
		expect(run.mock.calls.some((call) => call[1][0] === "build")).toBe(false);
	});

	it("offers no unsafe fallback when the platform package manager is unavailable", async () => {
		const run = vi.fn<OciSetupCommandRunner>(async () => fail("missing"));
		const service = createOciSetupService({ platform: "win32", run });

		await expect(service.discover("auto")).resolves.toEqual([]);
	});
});

async function testRoot(prefix: string): Promise<string> {
	const root = path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	roots.push(root);
	return root;
}

async function worker(root: string): Promise<string> {
	const workerRoot = path.join(root, "worker");
	await mkdir(workerRoot, { recursive: true });
	await writeFile(path.join(workerRoot, "Containerfile"), "FROM scratch\n");
	return workerRoot;
}

function ok(output = "ok") {
	return { exitCode: 0, output };
}

function fail(output = "missing") {
	return { exitCode: 1, output };
}
