# @earendil-works/pi-speculative-action

Single-step speculative tool pre-execution for Pi. The package predicts likely tool calls while the actor model is running, executes explicitly allowed read-only candidates, and adopts matching results through Pi Agent's `settleToolCall` hook.

The feature is disabled by default. Enabling it requires a non-interactive `preflight` callback; without one, candidates are predicted but never executed.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import {
	createWorkspaceSandbox,
	installSpeculativeAction,
} from "@earendil-works/pi-speculative-action";

const installed = installSpeculativeAction(agent, {
	cwd: process.cwd(),
	getSettings: () => ({
		enabled: true,
		maxCandidates: 4,
		resourceCacheMaxEntries: 256,
		predictionTimeoutMs: 1_000,
		tools: { resourceCached: ["read", "grep", "find"], sandbox: ["write", "edit"] },
	}),
	preflight: () => true,
	sandbox: createWorkspaceSandbox(),
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

## M3 behavior

- Canonical keys cover Pi `bash`, `write`, and multi-replacement `edit`; bash keys include the installation cwd.
- Resource-scoped candidates use a configurable access-ordered LRU.
- Sandbox candidates require an explicit host capability. Missing capabilities, invalid schemas, and denied preflight checks fail closed.
- `write` and `edit` run against temporary files and change the real workspace only after byte-for-byte base validation at adoption time.
- `bash` additionally requires an explicit process isolation provider. A copied temporary cwd is not by itself a security boundary.
- Candidate execution and adoption failures emit misses and fall back to the actor's normal tool path.

## M4 behavior

- Every sandbox candidate starts from an independent private Git snapshot and detached worktree without modifying the user's repository metadata.
- `write`, `edit`, and explicitly isolated `bash` candidates collect staged file creation, modification, and deletion while the real workspace remains unchanged.
- Adoption validates every base before writing, applies the complete change set, and rolls back already applied paths if a later write fails.
- Workspace escapes and symlink paths fail closed, and private repositories and worktrees are removed after success, failure, or cancellation.
- Every lifecycle event carries a cache snapshot. Candidate completion emits a cache refresh even without an actor hit, while real fallback execution emits an `actual` event with its duration.

Native process isolation remains a later migration milestone. Until then, `bash` requires an explicit process provider that enforces the host security boundary; the Git worktree alone is filesystem staging, not process isolation.

If the drafter uses a different provider from the actor, provide `getDraftOptions` so the drafter receives the correct credentials. The generic Pi stream interface does not promise a provider-independent “required tool choice”; the system prompt enforces tool-call-only output and non-tool output is treated as no candidate.
