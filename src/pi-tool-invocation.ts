import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { ToolInvocation } from "./tool-settlement.ts";

export interface PiToolInvocationOptions {
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly shellPath?: string;
	readonly shellCommandPrefix?: string;
}

/** Exact stock-Pi process identity shared by K(a) construction and isolated replay. */
export function resolvePiToolInvocation(
	tool: string,
	input: unknown,
	options: PiToolInvocationOptions,
): ToolInvocation | undefined {
	if (tool !== "bash" || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.command !== "string") return undefined;
	const shell = getShellConfig(options.shellPath);
	const executor = "pi.bash.local.v2";
	const commandTransport = shell.commandTransport ?? "argv";
	return {
		executor,
		identity: {
			executor,
			cwd: options.cwd,
			environment: options.environment,
			shell: shell.shell,
			shellArgs: [...shell.args],
			commandTransport,
			...(options.shellCommandPrefix ? { commandPrefix: options.shellCommandPrefix } : {}),
		},
		process: {
			command: options.shellCommandPrefix ? `${options.shellCommandPrefix}\n${record.command}` : record.command,
			cwd: options.cwd,
			environment: options.environment,
			shell: shell.shell,
			shellArgs: [...shell.args],
			commandTransport,
			...(typeof record.timeout === "number" ? { timeout: record.timeout } : {}),
		},
	};
}
