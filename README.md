# Pi Speculative Action

English | [中文](README-CN.md)

Speculative tool-action execution for Pi. While the actor model is thinking, it predicts likely upcoming tool calls and safely executes eligible candidates ahead of time. If the actor later requests the same action, Pi reuses the completed or in-flight result.

This is tool-action speculation, not token-level LLM speculative decoding. It currently supports:

- `read`, `grep`, and `find`: result caching and reuse with resource-version validation.
- `write` and `edit`: pre-execution in a private Git workspace, followed by a transactional world commit on a hit.
- `bash`: pre-execution in a private Git workspace and isolated process backend, followed by output reuse and a transactional world commit on a hit.
- PatternAware: learns historical tool sequences and predicts immediate or multi-step future actions.
- Drafter: runs alongside the actor to propose candidates for the current turn.

Prediction failures, mismatches, changed resources, and unavailable sandboxes fall back to the actor's normal tool path. A speculative failure does not fail the task.

## Quick start

Speculative Action is a regular Pi package. It uses the public extension API and does not patch `pi-agent-core`, `pi-coding-agent`, or Pi's settings schema.

### 1. Run from source

Requirements: Node.js 22.19 or later and Git. Build the package, then register its directory with any compatible, unmodified Pi installation:

```bash
git clone --branch speculative-action https://github.com/xchang1121/pi.git pi-speculative
cd pi-speculative
npm install --ignore-scripts
npm run hydrate:model-data
npm run build --workspace @earendil-works/pi-coding-agent
npm run build --workspace @earendil-works/pi-speculative-action
pi install ./packages/speculative-action
```

`hydrate:model-data` fetches the model catalog required by the monorepo build. A published package or release tarball already contains `dist` and does not need this source-build step.

To try the package for one session without adding it to Pi settings:

```bash
pi -e /absolute/path/to/pi-speculative/packages/speculative-action
```

### 2. Trust the project

The package only pre-executes candidates in trusted projects. In interactive mode, run:

```text
/trust
```

Restart Pi after saving the trust decision. In an untrusted project you can enable and inspect speculation, but candidates are not pre-executed.

### 3. Enable speculation and inspect status

Inside Pi, run:

```text
/speculative-action on
/speculative-action status
```

Once enabled, the footer shows information similar to:

```text
spec: on · Windows AppContainer · 3/4 hits · 1.2s ahead · 5/512 results
```

Hit rate may be low on the first run or before PatternAware has learned a workflow. Complete several tasks with repeated `read`, `grep`, `find`, or `bash` sequences, then inspect `Hits` and `Execution ahead` again.

## Commands

| Command | Purpose |
|---|---|
| `/speculative-action` | Open the interactive settings panel |
| `/speculative-action on` | Enable speculative execution |
| `/speculative-action off` | Disable speculative execution and use the baseline path |
| `/speculative-action status` | Show configuration, sandbox health, hit counts, and timing metrics |
| `/speculative-action refresh` | Probe the configured Bash isolation backend again and show its status |
| `/speculative-action reset` | Remove settings from the active scope and restore defaults; the default master switch is off |

## Defaults

The master switch is off by default. After `/speculative-action on`, the following defaults apply:

| Setting | Default | Description |
|---|---:|---|
| Drafter | On | Uses the active actor model by default, or an optionally configured model |
| PatternAware | On | Learn and match historical action templates |
| PatternAware multi-step | On | Admit future actions and expand multi-step speculation |
| Pattern beam width | 4 | Retain the highest expected-latency-reduction actions at each learned frontier |
| Pattern prediction depth | 6 | Bound recursive multi-step expansion, including recurring motifs |
| Drafter requests | 8 | Independent, concurrent one-action requests per Drafter round; K(a) deduplicates their results |
| Drafter rollout depth | 2 | Feed completed speculative results back to the Drafter for at most two additional actions; `0` disables rollout |
| Concurrent actions | 8 | Maximum concurrent speculative actions |
| Resource cache | 512 entries / 256 MiB | Cache for `read`, `grep`, and `find` results |
| Prediction timeout | 300 seconds | Maximum lifecycle of one prediction round |
| Resource-cached tools | `read`, `grep`, `find` | Reusable after resource validation |
| Sandbox-staged tools | `bash`, `write`, `edit` | Pre-executed in an isolated workspace |
| Isolation backend | `auto` | Prefer an OCI worker; fall back to the native OS broker |

`bash` is included in the default candidate tools, but speculative Bash execution only starts after the selected process backend passes its health check. If isolation is unavailable, actor-requested Bash still runs through Pi's normal path.

## Configuration files

Use the interactive panel or edit JSON directly:

| File | Scope |
|---|---|
| `~/.pi/agent/speculative-action.json` | Global |
| `.pi/speculative-action.json` | Current project; overrides global settings |

Complete example:

```json
{
  "enabled": true,
  "drafterEnabled": true,
  "draftModel": "provider/model",
  "candidateLimit": 8,
  "drafterMaxDepth": 2,
  "maxConcurrentActions": 8,
  "resourceCacheMaxEntries": 512,
  "resourceCacheMaxBytes": 268435456,
  "predictionTimeoutMs": 300000,
  "isolation": {
    "backend": "auto",
    "runtime": "auto",
    "image": "pi-speculative-worker:latest"
  },
  "patternAware": {
    "enabled": true,
    "multiStepEnabled": true,
    "beamWidth": 4,
    "maxPredictionDepth": 6
  },
  "tools": {
    "resourceCached": ["read", "grep", "find"],
    "sandbox": ["bash", "write", "edit"]
  }
}
```

Omit `draftModel` to use the active actor model. An optional Pi `provider/model` reference may select the same model explicitly or a different authenticated model; invalid or unavailable references fall back to the actor.

## Enable speculative Bash

`write` and `edit` rely on private Git snapshot/worktree isolation. `bash` additionally requires process isolation. The preferred cross-platform backend is a persistent Docker or Podman worker pool.

In the TUI, enabling speculative action probes both backends. `auto` uses OCI when ready and otherwise falls back to the native OS sandbox. The panel reports **Configured backend**, **Active backend**, **OCI worker**, and **Native sandbox** separately, so a missing Docker executable is not presented as a global sandbox failure when AppContainer or another native backend is ready. If neither backend is ready, Pi offers an explicit Docker/Podman setup choice. It never installs a system package without confirmation. OCI setup remains available under **Tools & sandbox → Install or repair OCI dependencies**, even while the native fallback is active.

For manual setup, build the bundled Linux worker image once:

```bash
npm run build:worker --workspace @earendil-works/pi-speculative-action
```

Pi never pulls custom images implicitly. The default image is `pi-speculative-worker:latest`; select a different immutable image through the settings panel, JSON, or `PI_SPECULATIVE_WORKER_IMAGE`. `runtime: "auto"` probes Docker and then Podman, or set `PI_SPECULATIVE_WORKER_RUNTIME=podman`. Use `PI_SPECULATIVE_WORKER_RUNTIME_BIN` for an explicitly trusted runtime binary and `PI_SPECULATIVE_WORKER_SHELL` for a custom guest shell.

Probe it again inside Pi:

```text
/speculative-action refresh
```

Depending on the host, the status can contain:

```text
Configured isolation: auto
Active sandbox: Windows AppContainer ready (...)
OCI worker: unavailable (...)
Native sandbox: Windows AppContainer ready (...)
```

The worker pool keeps execution slots prepared, then creates a disposable container once the branch workspace and its logical actor path are known. After each command, the complete container is removed before the slot is reused. This prevents a discarded process tree, root-filesystem change, or temporary file from leaking into another branch. The source workspace is never mounted; only the branch copy is visible, with networking disabled. On compatible OCI guests, the copy is mounted at the actor's logical workspace path, so absolute paths in the original command keep their meaning without command rewriting. Linux workers additionally use a read-only root filesystem, dropped capabilities, `no-new-privileges`, a PID limit, and the host UID/GID when available.

The bundled image uses Linux Bash and works through Docker Desktop on Windows as well as native Docker/Podman on Linux and macOS. If exact Git-for-Windows behavior is required, supply a Windows container image and set `guestShell` to `C:\\Program Files\\Git\\bin\\bash.exe`. The configured image ID, OS, architecture, runtime, and guest shell are part of K(a)'s execution-world fingerprint, so changing them invalidates prior speculative results.

Linux, macOS, and Windows may use the native broker as an explicit backend or automatic fallback. Build it with:

```bash
npm run build:native --workspace @earendil-works/pi-speculative-action
```

To use an explicitly trusted broker built elsewhere, set `PI_SPECULATIVE_SANDBOX_NATIVE_BIN=/absolute/path/to/pi-sandbox-native` and select `backend: "native"`. The native sandbox provides:

- Linux: namespaces, a read-only host mount, seccomp, capability removal, and process-tree supervision.
- macOS: a Seatbelt profile, source/home/network restrictions, and process-tree supervision.
- Windows: a zero-capability AppContainer, package-SID access only to the staged workspace, a private desktop, and kill-on-close Job supervision.

On Windows, `auto` tries OCI first and then AppContainer. AppContainer runs compatible native shells without a command allowlist, but Git for Windows' MSYS runtime cannot initialize inside this boundary. Use OCI for speculative Git Bash; otherwise the Scheduler rejects the failed candidate and the actor runs it normally. `write`, `edit`, and resource-cached speculation are unaffected.

`ExecutionWorld` is the isolation boundary used by the Agent adapter. `ActionSemanticsRegistry` selects a world mode (`file_mutation` or `workspace_snapshot`); the world does not maintain a second hard-coded tool list. A completed `WorldBranch` seals the tool output, committable filesystem delta, and an immutable checkpoint. The source-neutral scheduler can derive a later sandbox action from that checkpoint before Actor confirmation, while Actor matching still follows confirmed ancestor intent in order. Process-local cwd/environment state and blocked network effects never cross the boundary. World commit is conflict-checked and at most once; an uncommitted branch cannot change the Actor's world. Linux native isolation also projects the private branch onto the Actor's logical workspace path inside its mount namespace.

If no configured backend is ready, Bash speculation fails closed and the actor falls back to normal Bash execution.

## Verify that speculation is active

Run `/speculative-action status` and inspect these fields:

| Field | Meaning |
|---|---|
| Attempts | Derived from started candidates, hits, and misses; shown as the denominator in the hit summary |
| `Hits` | Actor actions that reused speculative results |
| `Misses` | Predictions that were not adopted, became stale, or failed a safety check |
| `Execution ahead` | Adopted tool-execution time that elapsed before Actor interception, capped at each execution's measured duration |
| `Hit latency` | Time from Actor interception until the adopted result finishes validation, remaining execution, projection, world commit if needed, and synchronous hit settlement |
| `Attempt lead` | Diagnostic interval from the request that produced the execution-owning candidate to Actor interception |
| `Actual` | Native actor tool time after speculation did not settle the action |
| `Draft tokens` | Total drafter token usage |
| `Cache` | Current entries, capacity, memory, and in-flight jobs |
| `Configured isolation` | Requested backend policy and OCI runtime/image settings |
| `Active sandbox` | Backend the scheduler can currently use |
| `OCI worker` | Docker/Podman worker health, independent of native health |
| `Native sandbox` | AppContainer/Seatbelt/Linux-native health, independent of OCI health |

`Execution ahead` is directly observed overlap, not counterfactual saved time. A completed cached action contributes at most its measured execution duration; an in-flight action contributes only the execution elapsed before Actor interception. `Attempt lead` may be much larger and is diagnostic only. None of these metrics invents the unexecuted Actor tool path, so use paired baseline/full wall-clock measurements under the same tasks, model, and environment to establish end-to-end benefit.

## Common ablations

The following configurations cover the main components.

### Baseline

```json
{ "speculativeAction": { "enabled": false } }
```

### Disable the Drafter and keep PatternAware

```json
{
  "speculativeAction": {
    "enabled": true,
    "drafterEnabled": false,
    "patternAware": { "enabled": true, "multiStepEnabled": true }
  }
}
```

### Disable multi-step speculation and keep immediate templates

```json
{
  "speculativeAction": {
    "enabled": true,
    "patternAware": { "enabled": true, "multiStepEnabled": false }
  }
}
```

### Disable PatternAware and use only the Drafter

```json
{
  "speculativeAction": {
    "enabled": true,
    "drafterEnabled": true,
    "patternAware": { "enabled": false }
  }
}
```

### Disable sandbox-action speculation

```json
{
  "speculativeAction": {
    "enabled": true,
    "tools": {
      "resourceCached": ["read", "grep", "find"],
      "sandbox": []
    }
  }
}
```

Use an independent Pi state directory or clear PatternAware learning state between experiment groups so one variant does not inherit another variant's history.

## Security model

- Candidate arguments pass the real tool schema and a non-interactive preflight before execution.
- The package only admits known tools in trusted projects.
- `write`, `edit`, and `bash` run in independent Git snapshots/worktrees and do not directly modify the real workspace.
- Adoption validates every base file again. Any resource change rejects the commit.
- Changes are applied as a complete set, and already-written paths are rolled back if a later write fails.
- Workspace escapes and symlink paths fail closed.
- Bash requires an attested process-isolation backend. Copying a directory alone is not considered a security boundary.

## Zero-modification boundary

The package integrates only through stock Pi APIs: lifecycle events provide model context, `registerCommand()` provides the TUI, and same-name `registerTool()` definitions wrap Pi's public `read`, `bash`, `edit`, `write`, `grep`, and `find` factories. A hit returns the cached settlement; a miss delegates to the unchanged stock tool. Package-owned configuration lives outside Pi's settings schema. Removing the package restores baseline behavior without reverting any Pi source file.

The engine remains available through `createSpeculativeActionHost()` for non-Pi adapters, but normal Pi users should install the package rather than mutate an `Agent` instance.

## Troubleshooting

- `Enabled: Off`: run `/speculative-action on`.
- `Active sandbox: unavailable`: inspect the separate OCI/native rows. Use **Tools & sandbox → Install or repair OCI dependencies** for OCI, or build/provide the native broker, then run `/speculative-action refresh`.
- Enabled but no candidates: verify project trust and make sure the Drafter and PatternAware are not both disabled.
- Candidates but no hits: the predicted tool name and normalized arguments must match the actor call; resource changes also invalidate candidates.
- No early PatternAware benefit: it needs repeated workflows before it can learn useful templates; cold starts rely mainly on the Drafter.
- High Drafter cost: select a faster, cheaper `draftModel` or reduce `candidateLimit`.
- Missing model JSON in development: run `npm run hydrate:model-data` from the repository root.

## Implementation overview

The actor and Drafter run concurrently. Each Drafter round launches `candidateLimit` independent requests in parallel. Every request sees the actor conversation and eligible tool schemas, is instructed to act as the assistant with exactly one tool call, disables reasoning, and uses a small output budget; the first request uses temperature 0 for accuracy and the rest use 0.7 for diversity. Only the first tool call from each response is admitted, and the existing K(a) relation deduplicates equivalent work before execution. After a candidate succeeds, its exact assistant call and tool result can extend the same bounded Drafter trajectory. Runtime-owned target-action budgets keep these continuations from duplicating the next turn's request fanout, cancel late branches, and invalidate descendants when the parent was not adopted. Candidates pass schema validation, preflight, resource-version capture, and execution-strategy selection. Completed candidates enter either `ResultCache` or an exact-only `ActionStore`; isolated effects are represented by a sealed `WorldBranch`. PatternAware persists its templates and bounded PPM count trie by workspace hash, while DAG execution, freshness, and scheduling remain source-neutral.

Hits, misses, cancellation, actual execution, draft tokens, cache state, and sandbox-stage timings are exposed as typed events for experiment collection and visualization.
