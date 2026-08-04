# @earendil-works/pi-speculative-action

Single-step speculative tool pre-execution for Pi. The package predicts likely tool calls while the actor model is running, executes explicitly allowed read-only candidates, and adopts matching results through Pi Agent's `settleToolCall` hook.

The feature is disabled by default. Enabling it requires a non-interactive `preflight` callback; without one, candidates are predicted but never executed.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { installSpeculativeAction } from "@earendil-works/pi-speculative-action";

const installed = installSpeculativeAction(agent, {
	cwd: process.cwd(),
	getSettings: () => ({
		enabled: true,
		maxCandidates: 4,
		predictionTimeoutMs: 1_000,
		tools: { liveReadonly: ["read", "grep", "find"] },
	}),
	preflight: ({ action }) => action.execution === "live_readonly",
	onEvent: (event) => console.debug(event),
});

// Before disposing the Agent:
await installed.uninstall();
```

## M1 behavior

- The drafter receives the actor transcript and callable tool schemas, plus a tool-call-only system instruction.
- Drafter and actor requests run concurrently.
- Candidate inputs are schema-validated before preflight and execution.
- Canonical keys cover Pi `read`, `grep`, and `find`, including their effective default arguments.
- Exact ready and in-flight matches reuse the speculative result.
- A caller-provided projector can safely reuse a containing `read` range.
- Read-only results survive provider turns while their resource fingerprint remains unchanged.
- Misses, hits, starts, cancellation, timing, and draft-token usage are observable as typed events.
- Prediction failures, invalid inputs, resource changes, and candidate failures fall back to normal tool execution.

## M2 behavior

- Drafter candidates consult the same session cache used for actor adoption before starting work.
- Exact actions and containing `read` ranges share ready or in-flight jobs; stale resource entries are discarded first.
- Reused candidates do not consume the per-prediction execution limit, so later cache misses can still start work.

If the drafter uses a different provider from the actor, provide `getDraftOptions` so the drafter receives the correct credentials. The generic Pi stream interface does not promise a provider-independent “required tool choice”; the system prompt enforces tool-call-only output and non-tool output is treated as no candidate.
