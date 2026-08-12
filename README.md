# Pi Speculative Action

English | [中文](README-CN.md)

Speculative tool-action execution for Pi. While the actor model is thinking, it predicts likely upcoming tool calls and safely executes eligible candidates ahead of time. If the actor later requests the same action, Pi reuses the completed or in-flight result.

This is tool-action speculation, not token-level LLM speculative decoding. It currently supports:

- `read`, `grep`, and `find`: result caching and reuse with resource-version validation.
- `write` and `edit`: pre-execution in a private Git workspace, followed by transactional adoption on a hit.
- `bash`: pre-execution in a private Git workspace and isolated OCI worker, followed by output reuse and change adoption on a hit.
- PatternAware: learns historical tool sequences and predicts immediate or multi-step future actions.
- Drafter: runs alongside the actor to propose candidates for the current turn.

Prediction failures, mismatches, changed resources, and unavailable sandboxes fall back to the actor's normal tool path. A speculative failure does not fail the task.

## Quick start

The feature is integrated into this repository as a built-in Pi extension. No separate extension installation is required. The official Pi release does not yet contain this branch, so run Pi from a repository or release package that includes these changes.

### 1. Run from source

Requirements: Node.js 22.19 or later and Git. Replace the placeholder with the actual GitHub repository URL:

```bash
git clone <your-github-repository> pi-speculative
cd pi-speculative
git switch feature/speculative-action
npm install --ignore-scripts
npm run hydrate:model-data
./pi-test.sh
```

`hydrate:model-data` fetches the model catalog required to build and run Pi. If you use a release source archive that already includes a model snapshot, skip that step and use `npm run build:offline`.

You can keep your existing `pi` command and invoke this checkout directly from any project directory:

```bash
/path/to/pi-speculative/pi-test.sh
```

### 2. Trust the project

The built-in extension only pre-executes candidates in trusted projects. In interactive mode, run:

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
spec: on · container · 3/4 hits · 1.2s saved · 5/512 cached
```

Hit rate may be low on the first run or before PatternAware has learned a workflow. Complete several tasks with repeated `read`, `grep`, `find`, or `bash` sequences, then inspect `Hits`, `Saved`, and `End-to-end speedup` again.

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
| Drafter | On | Predict candidates concurrently with the actor |
| PatternAware | On | Learn and match historical action templates |
| PatternAware multi-step | On | Admit future actions and expand multi-step speculation |
| Pattern beam width | 4 | Retain the highest expected-latency-reduction actions at each learned frontier |
| Pattern prediction depth | 6 | Bound recursive multi-step expansion, including recurring motifs |
| Adaptive drafter | On | Skip redundant drafter requests when a useful template is already available |
| Candidate limit | 8 | Maximum accepted candidates per prediction |
| Concurrent actions | 8 | Maximum concurrent speculative actions |
| Resource cache | 512 entries / 256 MiB | Cache for `read`, `grep`, and `find` results |
| Prediction timeout | 300 seconds | Maximum lifecycle of one prediction round |
| Resource-cached tools | `read`, `grep`, `find` | Reusable after resource validation |
| Sandbox-staged tools | `bash`, `write`, `edit` | Pre-executed in an isolated workspace |
| Isolation backend | `auto` | Prefer an OCI worker; on Linux/macOS only, fall back to the native broker |

`bash` is included in the default candidate tools, but speculative Bash execution only starts after the selected process backend passes its health check. If isolation is unavailable, actor-requested Bash still runs through Pi's normal path.

## Configuration files

Use the interactive panel or edit JSON directly:

| File | Scope |
|---|---|
| `~/.pi/agent/settings.json` | Global |
| `.pi/settings.json` | Current project; overrides global settings |

Complete example:

```json
{
  "speculativeAction": {
    "enabled": true,
    "drafterEnabled": true,
    "draftModel": "provider/model",
    "candidateLimit": 8,
    "maxConcurrentActions": 8,
    "resourceCacheMaxEntries": 512,
    "resourceCacheMaxBytes": 268435456,
    "predictionTimeoutMs": 300000,
    "adaptiveDrafter": true,
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
}
```

Omit `draftModel` to use the active actor model. To use another model, specify a Pi `provider/model` reference and make sure that provider is authenticated.

## Enable speculative Bash

`write` and `edit` rely on private Git snapshot/worktree isolation. `bash` additionally requires process isolation. The preferred cross-platform backend is a persistent Docker or Podman worker pool. Build the bundled Linux worker image once:

```bash
npm run build:worker --workspace @earendil-works/pi-speculative-action
```

Pi never pulls images implicitly. The default image is `pi-speculative-worker:latest`; select a different immutable image through the settings panel, JSON, or `PI_SPECULATIVE_WORKER_IMAGE`. `runtime: "auto"` probes Docker and then Podman, or set `PI_SPECULATIVE_WORKER_RUNTIME=podman`. Use `PI_SPECULATIVE_WORKER_RUNTIME_BIN` for an explicitly trusted runtime binary and `PI_SPECULATIVE_WORKER_SHELL` for a custom guest shell.

Probe it again inside Pi:

```text
/speculative-action refresh
```

The status should contain:

```text
Sandbox: container ready (...)
```

The worker pool keeps empty containers warm, but every speculative branch receives its own private workspace mount and disposable container. After each command, the complete container is removed and replaced before the slot is reused. This prevents an unadopted process tree, root-filesystem change, or temporary file from leaking into another branch. The source workspace is never mounted; only the branch copy is visible, with networking disabled. Linux workers additionally use a read-only root filesystem, dropped capabilities, `no-new-privileges`, a PID limit, and the host UID/GID when available.

The bundled image uses Linux Bash and works through Docker Desktop on Windows as well as native Docker/Podman on Linux and macOS. If exact Git-for-Windows behavior is required, supply a Windows container image and set `guestShell` to `C:\\Program Files\\Git\\bin\\bash.exe`. The configured image ID, OS, architecture, runtime, and guest shell are part of K(a)'s execution-world fingerprint, so changing them invalidates prior speculative results.

Linux and macOS may use the existing native broker as an explicit backend or automatic fallback. Build it with:

```bash
npm run build:native --workspace @earendil-works/pi-speculative-action
```

To use an explicitly trusted broker built elsewhere, set `PI_SPECULATIVE_SANDBOX_NATIVE_BIN=/absolute/path/to/pi-sandbox-native` and select `backend: "native"`. The native sandbox provides:

- Linux: namespaces, a read-only host mount, seccomp, capability removal, and process-tree supervision.
- macOS: a Seatbelt profile, source/home/network restrictions, and process-tree supervision.

Windows does not automatically fall back to the native broker: mandatory AppContainer ASLR is incompatible with the fork model used by MSYS2/Git Bash. Use the OCI worker for speculative Bash on Windows.

`ExecutionWorld` is the isolation boundary used by the Agent adapter. `ActionSemanticsRegistry` selects a world mode (`file_mutation` or `workspace_snapshot`); the world does not maintain a second hard-coded tool list. A completed `WorldBranch` seals the tool output and promotable filesystem delta together. Process-local cwd/environment state and blocked network effects are never promoted. Concurrent consumers join one conflict-checked, transactional adoption, while an unadopted branch cannot change the actor's world.

If no configured backend is ready, Bash speculation fails closed and the actor falls back to normal Bash execution.

## Verify that speculation is active

Run `/speculative-action status` and inspect these fields:

| Field | Meaning |
|---|---|
| Attempts | Derived from started candidates, hits, and misses; shown as the denominator in the hit summary |
| `Hits` | Actor actions that reused speculative results |
| `Misses` | Predictions that were not adopted, became stale, or failed a safety check |
| `Saved` | Estimated tool wait time avoided through early execution |
| `Waited` | Time spent waiting when the actor hit an in-flight candidate |
| `Actual` | Native actor tool time after speculation did not settle the action |
| `End-to-end speedup` | Session metric computed from observed wall time and saved time |
| `Draft tokens` | Total drafter token usage |
| `Cache` | Current entries, capacity, memory, and in-flight jobs |
| `Sandbox` | Whether the configured Bash isolation backend is ready |

To establish real performance impact, compare paired baseline/full wall-clock measurements under the same tasks, model, and environment. Do not infer end-to-end acceleration from `Saved` alone.

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
- The built-in extension only admits known tools in trusted projects.
- `write`, `edit`, and `bash` run in independent Git snapshots/worktrees and do not directly modify the real workspace.
- Adoption validates every base file again. Any resource change rejects the commit.
- Changes are applied as a complete set, and already-written paths are rolled back if a later write fails.
- Workspace escapes and symlink paths fail closed.
- Bash requires an attested process-isolation backend. Copying a directory alone is not considered a security boundary.

## SDK integration

You can install the feature directly on an `Agent` without using the coding-agent built-in extension. The generic SDK is disabled by default and requires a non-interactive `preflight`; without one, it may predict candidates but will not execute them.

```ts
import {
  createContainerSandboxProcessBackend,
  createWorkspaceSandbox,
  installSpeculativeAction,
} from "@earendil-works/pi-speculative-action";

const allowedTools = new Set(["read", "grep", "find", "bash", "write", "edit"]);

const installed = installSpeculativeAction(agent, {
  cwd: process.cwd(),
  getSettings: () => ({
    enabled: true,
    drafterEnabled: true,
    candidateLimit: 4,
    maxConcurrentActions: 4,
    resourceCacheMaxEntries: 256,
    resourceCacheMaxBytes: 256 * 1024 * 1024,
    predictionTimeoutMs: 1_000,
    adaptiveDrafter: true,
    patternAware: {
      enabled: true,
      multiStepEnabled: true,
      beamWidth: 4,
      maxPredictionDepth: 6,
      futureGapCoverage: 0.9,
      decayHalfLifeEvents: 2048,
    },
    tools: {
      resourceCached: ["read", "grep", "find"],
      sandbox: ["bash", "write", "edit"],
    },
  }),
  preflight: ({ toolName }) => allowedTools.has(toolName),
  sandbox: createWorkspaceSandbox({
    processBackend: createContainerSandboxProcessBackend(),
  }),
  onEvent: (event) => console.debug(event),
});

// Call before disposing the Agent.
await installed.uninstall();
```

If the Drafter uses a different provider from the actor, use `getDraftOptions` to provide the correct credentials and request options. Keep speculative failures recoverable, and do not display interactive authorization UI from `preflight`.

## Troubleshooting

- `Enabled: Off`: run `/speculative-action on`.
- `Sandbox: bash unavailable`: build the worker image, confirm Docker or Podman can inspect it, then run `/speculative-action refresh`.
- Enabled but no candidates: verify project trust and Drafter authentication, and make sure the Drafter and PatternAware are not both disabled.
- Candidates but no hits: the predicted tool name and normalized arguments must match the actor call; resource changes also invalidate candidates.
- No early PatternAware benefit: it needs repeated workflows before it can learn useful templates; cold starts rely mainly on the Drafter.
- High Drafter cost: keep `adaptiveDrafter` enabled or select a faster, cheaper `draftModel`.
- Missing model JSON in development: run `npm run hydrate:model-data` from the repository root.

## Implementation overview

The actor and Drafter run concurrently. Candidates pass schema validation, preflight, resource-version capture, and execution-strategy selection. Completed candidates enter either `ResultCache` or an exact-only `ActionStore`; isolated effects are represented by a sealed `WorldBranch`. When the actor emits a tool call, Pi Agent's `settleToolCall` hook tries to reuse an exact match or a conservatively projected result. PatternAware persists its templates and bounded PPM count trie by workspace hash, retains a small expected-benefit beam, and leaves DAG execution, freshness, and resource scheduling to the source-neutral runtime.

Hits, misses, cancellation, actual execution, draft tokens, cache state, and sandbox-stage timings are exposed as typed events for experiment collection and visualization.
