import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/** Host-neutral result consumed by the speculative scheduler. */
export interface ToolSettlement<TDetails = unknown> {
	readonly result: AgentToolResult<TDetails>;
	readonly isError: boolean;
}

/** Exact process invocation required to replay a tool inside an isolated execution world. */
export interface ToolProcessInvocation {
	readonly command: string;
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly shell: string;
	readonly shellArgs: readonly string[];
	readonly commandTransport: "argv" | "stdin";
	readonly timeout?: number;
}

/** Versioned identity of the concrete tool executor. */
export interface ToolInvocation {
	readonly executor: string;
	readonly process?: ToolProcessInvocation;
	/** Concrete isolation route selected while constructing K(a). */
	readonly isolationFingerprint?: string;
}
