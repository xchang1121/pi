# Pi speculative action

This package adds speculative tool execution to Pi without modifying Pi core. It predicts future tool calls with Drafter and PatternAware, executes only actions with a proven isolation route, and lets the Actor adopt a matching result.

## Architecture

The runtime has four independent layers:

1. **Sources** — Drafter and PatternAware emit source-neutral `PlanAction` values.
2. **Action identity** — `K(a)` canonicalizes tool semantics, validated schema, arguments, resources, and executor identity. Lossless projection rules may prove that one result covers another action.
3. **Execution routing** — one resolver selects an isolation capability. The selected route is deliberately not part of `K(a)`.
4. **Scheduling and settlement** — the Scheduler controls launch timing and resource pressure; `ExecutionWorld` owns isolated execution and adoption; one settlement lifecycle records match, adoption, fallback, and timing.

Execution routes use this fixed priority:

| Priority | Route | Scope |
|---|---|---|
| 1 | `runtime_sandbox` | An injected runtime-wide sandbox; preferred for every enabled tool |
| 2 | `resource_snapshot` | Local fallback for `read`, `grep`, and `find` using versioned resource evidence |
| 2 | `file_mutation` | Local fallback for `write` and `edit` using a private Git worktree and conflict-checked commit |
| 3 | Actor fallback | If no safe route exists, no speculative tool invocation occurs |

The package does **not** bundle a process sandbox. Consequently, the default Pi extension can predict and match `bash`, but it will not execute Bash speculatively. The Actor executes the command through Pi's normal path. An embedding runtime can enable Bash and all other tools by injecting an `ExecutionWorld` that supports `runtime_sandbox`.

This arrangement is intentional: a future OS-level agent runtime can provide one isolation world for the whole tool surface instead of requiring Pi to maintain a separate isolation implementation for each tool.

## Correctness boundaries

- Prediction sources never choose an execution backend.
- `K(a)` never changes because a different isolation backend is available.
- In-flight and cached work is reused only within an identical execution route.
- Actor adoption still requires action equivalence, permission, fresh resource evidence, compatible world evidence, successful projection, and successful commit.
- A tool with neither a runtime sandbox nor a registered local fallback is execution-blocked but remains matchable for learning and counterfactual measurement.
- Same-name custom tools remain authoritative and are excluded unless the host explicitly supplies matching semantics and execution capability.

`read` supports lossless range projection backed by realized output coverage. `grep` and `find` remain exact-key-only.

## Pi package use

Build the package from the repository root:

```sh
npm install
npm run build -w @earendil-works/pi-speculative-action
```

Run Pi with the package directory:

```sh
pi -e ./packages/speculative-action
```

Open `/speculative-action` in the TUI. The menu is grouped into prediction sources, scheduling/cache, and tools/execution. Tool labels describe the available local fallback; an unavailable isolation route always falls back to Actor execution.

Settings are owned by the package:

- global: `<agent-dir>/speculative-action.json`
- project: `<workspace>/.pi/speculative-action.json`

Example:

```json
{
  "enabled": true,
  "draftModel": "deepseek/deepseek-chat",
  "candidateLimit": 8,
  "maxConcurrentActions": 8,
  "drafterMaxTokens": 128,
  "tools": ["read", "grep", "find", "bash", "write", "edit"],
  "patternAware": {
    "enabled": true,
    "multiStepEnabled": true
  }
}
```

The former `resourceCached` / `sandbox` / `predictionOnly` object is accepted only as a migration input and is normalized to the single `tools` list.

## Runtime sandbox integration

Hosts provide ordered execution worlds through `executionWorlds`. A runtime-wide world advertises `supports("runtime_sandbox")` and forks an isolated branch for any tool. Every successful backend—including the built-in resource snapshot and the Git worktree fallback—returns the same `WorldBranch`; that branch owns compatibility evidence, freshness checks, adoption, and cleanup. The host automatically supplies the resource-snapshot backend when none is registered.

```ts
createSpeculativeActionHost(sessionID, {
  cwd,
  executionWorlds: [runtimeSandbox, createWorkspaceSandbox()],
  // model, policy, and tool integration omitted
})
```

The first runtime-wide world wins for every tool. Without one, the resolver considers the tool's registered local fallback. Absence of both is represented by an undefined route, which the Runtime turns into `execution:isolation_unavailable` and an Actor fallback.

## Timing

For an adopted result:

- `attemptLeadMs`: speculative intent to Actor interception.
- `executionAheadMs`: speculative execution completed before interception, capped by measured tool duration.
- `hitLatencyMs`: interception to authoritative settlement.

For an isolation-blocked match, the Actor execution is authoritative. The same decomposition is reported as counterfactual potential:

```text
executionBlockedPotentialHiddenLatencyMs = min(actorDuration, predictionLead)
executionBlockedPotentialHitLatencyMs    = actorDuration - potentialHidden
```

These values never inflate actual speculative hits or actual hidden latency.

## Validation

```sh
npm run build -w @earendil-works/pi-speculative-action
npm test -w @earendil-works/pi-speculative-action
npm run bench:check -w @earendil-works/pi-speculative-action
```

See [bench/README.md](./bench/README.md) for the single-trajectory ablation methodology.
