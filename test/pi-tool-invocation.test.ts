import { describe, expect, it } from "vitest";
import { resolvePiToolInvocation } from "../src/pi-tool-invocation.ts";

describe("stock Pi invocation identity", () => {
	it("uses one exact Bash descriptor for K(a) and isolated replay", () => {
		const environment = { PATH: "tools", BENCHMARK: "true" };
		const invocation = resolvePiToolInvocation(
			"bash",
			{ command: "printf ok", timeout: 2.5 },
			{
				cwd: process.cwd(),
				environment,
				shellPath: process.execPath,
				shellCommandPrefix: "set -e",
			},
		);

		expect(invocation).toEqual({
			executor: "pi.bash.local.v2",
			process: {
				command: "set -e\nprintf ok",
				cwd: process.cwd(),
				environment,
				shell: process.execPath,
				shellArgs: ["-c"],
				commandTransport: "argv",
				timeout: 2.5,
			},
		});
		expect(resolvePiToolInvocation("read", { path: "a.ts" }, { cwd: process.cwd(), environment })).toBeUndefined();
		expect(resolvePiToolInvocation("bash", { command: 1 }, { cwd: process.cwd(), environment })).toBeUndefined();
	});
});
