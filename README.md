# @earendil-works/pi-speculative-action

Single-step speculative tool pre-execution for Pi. The package predicts likely tool calls while the actor model is running, executes explicitly allowed read-only candidates, and adopts matching results through Pi Agent's `settleToolCall` hook.

The feature is disabled by default. Enabling it requires a non-interactive `preflight` callback; without one, candidates are predicted but never executed.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import {
	createNativeSandboxProcessRunner,
	createWorkspaceSandbox,
	installSpeculativeAction,
} from "@earendil-works/pi-speculative-action";

const installed = installSpeculativeAction(agent, {
	cwd: process.cwd(),
	getSettings: () => ({
		enabled: true,
		maxCandidates: 4,
		resourceCacheMaxEntries: 256,
		resourceCacheMaxBytes: 256 * 1024 * 1024,
		predictionTimeoutMs: 1_000,
		adaptiveDrafter: true,
		patternAware: { futureGapCoverage: 0.9, decayHalfLifeEvents: 2048 },
		tools: { resourceCached: ["read", "grep", "find"], sandbox: ["bash", "write", "edit"] },
	}),
	preflight: () => true,
	sandbox: createWorkspaceSandbox({ processRunner: createNativeSandboxProcessRunner() }),
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

## M5 behavior

- `bash` can use the package's versioned native broker through `createNativeSandboxProcessRunner()`.
- Linux uses namespaces, a read-only host mount, seccomp, dropped capabilities, and process-tree supervision; macOS uses Seatbelt; Windows uses a zero-capability AppContainer, restricted token, private desktop, ACL cleanup, and Jobs.
- Packaged assets are selected by platform, architecture, and Linux libc, verified against `native/sandbox/prebuilds/manifest.json`, and materialized as a private executable.
- Set `PI_SPECULATIVE_SANDBOX_NATIVE_BIN` only for an explicitly trusted development build. Missing, corrupt, incompatible, aborted, or failed brokers reject speculative execution so the actor follows Pi's normal tool path; there is no implicit direct-execution fallback.
- Build a host asset from the included Rust source with `npm run build:native --workspace @earendil-works/pi-speculative-action`.

## M8 behavior

- PatternAware learns weighted future gaps with event-age decay, suffix backoff, collection-aware mappings, persisted analyzer results, and bounded retry scheduling.
- Completed PatternAware candidates can open a multi-step speculative frontier; terminal cancellation stops the entire frontier.
- Resource candidates use watcher-backed version tokens with exact-validation fallback, eager invalidation, and per-session entry and byte limits.
- Sandbox worktrees reuse a pooled private Git repository while keeping each action isolated; setup, change collection, validation, commit, and cache-memory costs are emitted as runtime diagnostics.
- The adaptive drafter skips redundant model calls after immediate pattern deployment and applies bounded deterministic backoff after empty drafts. Disable `adaptiveDrafter` for ablation runs.
- Native protocol v3 forwards Pi's configured shell and rejects results that do not explicitly attest native process isolation.

If the drafter uses a different provider from the actor, provide `getDraftOptions` so the drafter receives the correct credentials. The generic Pi stream interface does not promise a provider-independent “required tool choice”; the system prompt enforces tool-call-only output and non-tool output is treated as no candidate.
