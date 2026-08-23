import { describe, expect, it } from "vitest";
import {
	actionKeyCovers,
	actionKeyMatch,
	BASH_TAIL_LINES_ACTION_KEY_PROJECTOR,
	bashTailLinesView,
	buildPiActionKey,
	PI_ACTION_SEMANTICS,
} from "../src/action-semantics.ts";
import { PI_BASH_TAIL_LINES_PROJECTION_RULE } from "../src/pi-bash-projection.ts";
import type { ToolSettlement } from "../src/tool-settlement.ts";

const cwd = "/workspace";

function bashKey(command: string, timeout?: number) {
	const action = buildPiActionKey("bash", { command, timeout }, cwd);
	if (!action) throw new Error("Expected a Bash action key");
	return action;
}

function settlement(
	text: string,
	options: { readonly isError?: boolean; readonly details?: unknown } = {},
): ToolSettlement {
	return {
		result: { content: [{ type: "text", text }], details: options.details },
		isError: options.isError ?? false,
	};
}

async function project(
	speculative: ReturnType<typeof bashKey>,
	actor: ReturnType<typeof bashKey>,
	output: ToolSettlement,
) {
	const keyMatch = actionKeyMatch(speculative, actor, [PI_BASH_TAIL_LINES_PROJECTION_RULE]);
	if (keyMatch?.kind !== "projected") throw new Error("Expected a projected Bash-key match");
	const coverage = PI_BASH_TAIL_LINES_PROJECTION_RULE.captureCoverage(speculative, output);
	if (coverage === undefined) return undefined;
	return PI_BASH_TAIL_LINES_PROJECTION_RULE.projectOutput({ speculative, actor, output, coverage, keyMatch });
}

function outputText(output: ToolSettlement | undefined): string | undefined {
	const content = output?.result.content[0];
	return content?.type === "text" ? content.text : undefined;
}

describe("Pi Bash tail-lines projection", () => {
	it.each([
		["pytest -q 2>&1 | tail -60", { core: "pytest -q 2>&1", lines: 60 }],
		["cd /testbed && pytest -q 2>&1 | tail -n 20", { core: "cd /testbed && pytest -q 2>&1", lines: 20 }],
		[
			'cd "/test bed" && grep -E "OK|FAIL" 2>&1 | tail -6',
			{ core: 'cd "/test bed" && grep -E "OK|FAIL" 2>&1', lines: 6 },
		],
	])("extracts one complete suffix view from %s", (command, expected) => {
		expect(bashTailLinesView(bashKey(command))).toEqual(expected);
	});

	it.each([
		"echo 'x | tail -60'",
		"pytest | tail -60",
		"printf before; pytest 2>&1 | tail -60",
		"printf before && pytest 2>&1 | tail -60",
		"cd relative && pytest 2>&1 | tail -60",
		"cd /testbed && pytest 2>&1 | grep fail | tail -20",
		"pytest $(pick-test) 2>&1 | tail -20",
		"pytest 2>&1 | tail -0",
		"pytest 2>&1 | tail --lines=20",
		"pytest 2>&1\n| tail -20",
	])("rejects a shell form without a provable whole-output suffix: %s", (command) => {
		expect(bashTailLinesView(bashKey(command))).toBeUndefined();
	});

	it("relates only a covering view inside the same execution identity", () => {
		const wide = bashKey("cd /testbed && pytest -q 2>&1 | tail -60", 300);
		const narrow = bashKey("cd /testbed && pytest -q 2>&1 | tail -20", 300);
		expect(actionKeyMatch(wide, narrow, [BASH_TAIL_LINES_ACTION_KEY_PROJECTOR])).toMatchObject({
			kind: "projected",
			projector: "bash.tail_lines",
			distance: 40,
		});
		expect(actionKeyCovers(wide, narrow, [BASH_TAIL_LINES_ACTION_KEY_PROJECTOR])).toBe(true);
		expect(actionKeyMatch(narrow, wide, [BASH_TAIL_LINES_ACTION_KEY_PROJECTOR])).toBeUndefined();
		expect(
			actionKeyMatch(wide, bashKey("cd /testbed && other -q 2>&1 | tail -20", 300), [
				BASH_TAIL_LINES_ACTION_KEY_PROJECTOR,
			]),
		).toBeUndefined();
		expect(
			actionKeyMatch(wide, bashKey("cd /testbed && pytest -q 2>&1 | tail -20", 30), [
				BASH_TAIL_LINES_ACTION_KEY_PROJECTOR,
			]),
		).toBeUndefined();
		const otherExecutor = PI_ACTION_SEMANTICS.buildKey(
			"bash",
			{ command: "cd /testbed && pytest -q 2>&1 | tail -20", timeout: 300 },
			cwd,
			"",
			{ fingerprint: "other", context: { process: { command: "cd /testbed && pytest -q 2>&1 | tail -20" } } },
		);
		expect(
			otherExecutor && actionKeyMatch(wide, otherExecutor, [BASH_TAIL_LINES_ACTION_KEY_PROJECTOR]),
		).toBeUndefined();
	});

	it("rejects projection when the concrete executor rewrites the command", () => {
		const action = PI_ACTION_SEMANTICS.buildKey("bash", { command: "pytest -q 2>&1 | tail -60" }, cwd, "schema", {
			fingerprint: "executor",
			context: {
				executor: "pi.bash.local.v2",
				process: { command: "echo prefix-output\npytest -q 2>&1 | tail -60" },
			},
		});
		expect(action && bashTailLinesView(action)).toBeUndefined();
	});

	it("reconstructs exact suffix bytes and fails closed without complete coverage", async () => {
		const wide = bashKey("pytest -q 2>&1 | tail -3");
		const narrow = bashKey("pytest -q 2>&1 | tail -n 2");
		const projected = await project(wide, narrow, settlement("one\ntwo\nthree\n", { details: { source: "mock" } }));
		expect(outputText(projected)).toBe("two\nthree\n");
		expect(projected?.result.details).toEqual({ source: "mock" });
		expect(outputText(await project(wide, narrow, settlement("only-one\n")))).toBe("only-one\n");
		expect(outputText(await project(wide, narrow, settlement("one\n\n")))).toBe("one\n\n");

		for (const output of [
			settlement("one\ntwo\nthree\n", { isError: true }),
			settlement("one\ntwo\nthree\n", { details: { truncation: { truncated: true } } }),
			{ result: { content: [], details: undefined }, isError: false } satisfies ToolSettlement,
		]) {
			expect(PI_BASH_TAIL_LINES_PROJECTION_RULE.captureCoverage(wide, output)).toBeUndefined();
		}
	});
});
