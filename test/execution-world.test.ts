import { describe, expect, it } from "vitest";
import type { ExecutionWorld, ExecutionWorldMode } from "../src/execution-world.ts";
import { resolveSpeculativeExecutionRoute, sameSpeculativeExecutionRoute } from "../src/execution-world.ts";

type TestWorld = ExecutionWorld<{ readonly mode: ExecutionWorldMode }, void>;

describe("speculative execution route resolution", () => {
	it("prefers a runtime-wide world and preserves safe shared reuse for resource queries", async () => {
		const local = world("git", ["file_mutation"]);
		const runtime = world("runtime", ["runtime_sandbox"], "runtime:v1");

		expect(await resolveSpeculativeExecutionRoute("resource_snapshot", [local, runtime])).toMatchObject({
			isolation: "runtime_sandbox",
			reuse: "shared_result",
			backend: "runtime",
			fingerprint: "runtime:v1",
			context: runtime,
		});
		expect(await resolveSpeculativeExecutionRoute("file_mutation", [local, runtime])).toMatchObject({
			isolation: "runtime_sandbox",
			reuse: "exclusive_branch",
			backend: "runtime",
		});
	});

	it("uses only the registered local mechanism and blocks actions with none", async () => {
		const resource = world("resource_version", ["resource_snapshot"], "resource-version:v1");
		const local = world("git", ["file_mutation"]);
		expect(await resolveSpeculativeExecutionRoute("resource_snapshot", [local, resource])).toMatchObject({
			isolation: "resource_snapshot",
			reuse: "shared_result",
			backend: "resource_version",
			fingerprint: "resource-version:v1",
			context: resource,
		});
		expect(await resolveSpeculativeExecutionRoute("resource_snapshot", [local])).toBeUndefined();
		expect(await resolveSpeculativeExecutionRoute("file_mutation", [local])).toMatchObject({
			isolation: "file_mutation",
			backend: "git",
		});
		expect(await resolveSpeculativeExecutionRoute("none", [local])).toBeUndefined();
	});

	it("skips a broken capability and keys reuse by stable route identity, not opaque context", async () => {
		const broken = world("broken", ["runtime_sandbox"], new Error("fingerprint unavailable"));
		const healthy = world("healthy", ["runtime_sandbox"], "healthy:v1");
		const route = await resolveSpeculativeExecutionRoute("none", [broken, healthy]);
		expect(route).toMatchObject({ backend: "healthy", fingerprint: "healthy:v1" });
		expect(route && sameSpeculativeExecutionRoute(route, { ...route, context: { different: true } })).toBe(true);
		expect(route && sameSpeculativeExecutionRoute(route, { ...route, fingerprint: "healthy:v2" })).toBe(false);
	});
});

function world(id: string, modes: readonly ExecutionWorldMode[], fingerprint: string | Error = `${id}:v1`): TestWorld {
	return {
		id,
		supports: (mode) => modes.includes(mode),
		fingerprint: () => {
			if (fingerprint instanceof Error) throw fingerprint;
			return fingerprint;
		},
		fork: async () => {
			throw new Error("not used by route resolution");
		},
	};
}
