# Pi speculative action

This standalone package adds speculative tool execution to Pi without modifying Pi core. It predicts future tool calls with Drafter and PatternAware, executes only actions with a proven isolation route, and lets the Actor adopt a matching result.

The repository is deliberately independent of the Pi monorepo: it has its own Git history, build configuration, tests, and dependency lock. Its only Pi dependencies are the published public extension APIs declared as peers. It does not import a Pi source checkout, use workspace path aliases, or require a matching `main` branch.

The repository retains the legacy URL `xchang1121/pi`, but its reachable history is projected exclusively from speculative-action changes and contains no Pi monorepo parent or source tree.

## Architecture

The runtime has four independent layers:

1. **Sources** — Drafter and PatternAware emit source-neutral `PlanAction` values.
2. **Action identity** — `K(a)` canonicalizes tool semantics, validated schema, arguments, resources, and executor identity. Lossless projection rules may prove that one result covers another action.
3. **Execution routing** — action semantics declare only observable effects; one `ExecutionWorldRouter` selects and prepares an isolation capability. The selected route is deliberately not part of `K(a)`.
4. **Scheduling and settlement** — the Scheduler controls launch timing and resource pressure; `ExecutionWorld` owns isolated execution and adoption; one settlement lifecycle records match, adoption, fallback, and timing.

Execution routes use this fixed priority:

| Priority | Route | Scope |
|---|---|---|
| 1 | `runtime_sandbox` | An injected runtime-wide sandbox; preferred for every enabled tool |
| 2 | `resource_snapshot` | Local fallback for `read`, `grep`, `find`, and `ls` using versioned resource evidence |
| 2 | `workspace_branch` | Local fallback for `write` and `edit` using a private Git worktree and conflict-checked commit |
| 3 | Actor fallback | If no safe route exists, no speculative tool invocation occurs |

The package does **not** bundle a process sandbox. Consequently, the default Pi extension can predict and match `bash`, but it will not execute Bash speculatively. The Actor executes the command through Pi's normal path. An embedding runtime can enable Bash and all other tools by injecting one runtime-scoped `ExecutionWorld`.

This arrangement is intentional: a future OS-level agent runtime can provide one isolation world for the whole tool surface instead of requiring Pi to maintain a separate isolation implementation for each tool.

## Correctness boundaries

- Prediction sources never choose an execution backend.
- `K(a)` never changes because a different isolation backend is available.
- In-flight and cached work is reused only within an identical execution route.
- Actor adoption still requires action equivalence, permission, fresh resource evidence, compatible world evidence, successful projection, and successful commit.
- A tool with neither a runtime sandbox nor a registered local fallback is execution-blocked but remains matchable for learning and counterfactual measurement.
- Same-name custom tools remain authoritative and are excluded unless the host explicitly supplies matching semantics and execution capability.

`read` supports lossless range projection backed by realized output coverage. `grep`, `find`, and `ls` remain exact-key-only.

## Install and use

The repository root is the Pi package root. A local checkout can be loaded or installed directly, without building Pi or editing its source:

```sh
pi -e /absolute/path/to/pi-speculative-action
pi install /absolute/path/to/pi-speculative-action
```

Pi can install the repository directly:

```sh
pi install https://github.com/xchang1121/pi
```

The `pi.extensions` manifest points to `src/extension.ts`, which Pi loads through its public TypeScript extension loader. Git installation therefore does not depend on checked-in build artifacts or dev dependencies. `dist` is only the conventional JavaScript/types entry point for npm consumers and is generated during `npm pack` or `npm publish`.

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
  "drafterMaxDepth": 1,
  "tools": ["read", "grep", "find", "ls", "bash", "write", "edit"],
  "patternAware": {
    "enabled": true,
    "multiStepEnabled": true
  }
}
```

`drafterMaxDepth` is the number of output-informed successor requests allowed after each initial one-action Drafter request. A successor occupies that source's existing slot for the next Actor decision rather than increasing per-decision request width; set it to `0` for single-step Drafter behavior.

`drafterMaxTokens` is an optional hard cap. Omit it—or clear the TUI field—to use the provider's output limit, which avoids truncating long commands and structured tool arguments.

The former `resourceCached` / `sandbox` / `predictionOnly` object is accepted only as a migration input and is normalized to the single `tools` list.

## Runtime sandbox integration

Hosts provide execution worlds through `executionWorlds`. A runtime-scoped world is necessarily a universal `runtime_sandbox`; only fallback worlds expose tool/effect capability filters. The router confirms backend availability before returning a route, so an unavailable runtime sandbox naturally falls through to a compatible local fallback. Every successful backend—including the built-in resource snapshot and the Git worktree fallback—returns the same `WorldBranch`; that branch owns compatibility evidence, freshness checks, adoption, and cleanup. The host automatically supplies the resource-snapshot backend when none is registered.

```ts
createSpeculativeActionHost(sessionID, {
  cwd,
  executionWorlds: [runtimeSandbox, createWorkspaceSandbox()],
  // model, policy, and tool integration omitted
})
```

The first available runtime-wide world wins for every tool. Without one, the router considers fallback worlds compatible with the action's declared effects. Absence of both is represented by an undefined route, which the Runtime turns into `execution:isolation_unavailable` and an Actor fallback. Resolution, preparation, fork, and disposal all pass through the same router; tools cannot retain a direct backend handle.

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
npm install --ignore-scripts
npm run check
npm run build
npm test
npm run bench:check
npm pack --dry-run
```

See [bench/README.md](./bench/README.md) for the single-trajectory ablation methodology.
