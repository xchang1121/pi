# WSL2 current-head Bash reuse acceptance — 2026-09-01

This acceptance was run from a fresh clone of `origin/speculative-action` at commit
`96b2778` on WSL2's native Linux filesystem. It exercises the production stock Pi
`createBashTool`, generic process outlet, Linux execution world, workspace driver,
provenance validation, effect transaction, and commit path after the runtime ownership
and package-boundary refactors.

Host:

- Ubuntu 24.04 on `Linux 6.18.33.2-microsoft-standard-WSL2 x86_64`
- Node.js `v24.20.0`, Sandlock `0.8.6`, strace `6.8`
- native ext4 checkout under `/home/singm`; no benchmark workspace lived under `/mnt/c`
- the production capability probe passed copy-up, deletion, directory creation, typed
  upper records, and merged-view visibility

## Cross-parent process identity and invalidation

The small qualification wraps one identical compiled child in three different parent
Bash commands. The first invocation publishes a certificate, the second must reuse it,
and the third changes a dynamically observed input and must execute again.

| cold execution | cross-parent hit | changed-input execution | saved by hit | speedup |
|---:|---:|---:|---:|---:|
| 1765.09 ms | 743.57 ms | 1791.47 ms | 1021.52 ms | 2.37x |

All assertions passed: ordered stdout/stderr and the regular-file effect were equal,
adoption-time freshness was valid, the second parent recorded exactly one hit, the
changed input recorded a miss and produced the new value, and no observation was
tainted. The small fixture correctly retained the Git-worktree driver selected by the
production `auto` policy.

Command:

```sh
npm run bench:linux-process -- --workspace-driver auto --output <result.json>
```

## Long typed-topology workload

The workload transforms a 32 MiB input with 96 deterministic rounds per byte and
creates `generated/`, `generated/nested/`, and a 32 MiB artifact. Three independent
pairs were measured; each pair contains three direct stock-Pi Bash executions and
three completed transactional replays under different parent Bash commands. A
300-file source tree makes the production `auto` policy select the qualified
host-visible FUSE OverlayFS route.

| repeat | direct median | replay median | saved | reduction | speedup | replay hits | taints |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2508.80 ms | 961.46 ms | 1547.34 ms | 61.68% | 2.61x | 3/3 | 0 |
| 2 | 2626.06 ms | 985.44 ms | 1640.63 ms | 62.47% | 2.67x | 3/3 | 0 |
| 3 | 2534.66 ms | 929.80 ms | 1604.86 ms | 63.32% | 2.73x | 3/3 | 0 |
| all 9 samples | **2542.10 ms** | **959.72 ms** | **1582.38 ms** | **62.25%** | **2.65x** | **9/9** | **0** |

Every cold run published exactly one certificate. Every replay restored both typed
directories and the exact artifact digest, passed outer-branch freshness validation,
and committed through the effect transaction. The one-time route preparation was
466.03, 464.45, and 465.00 ms; it is reported separately and is not hidden in the
per-action medians. Cold speculative warm-up is also intentionally excluded from the
steady replay comparison.

Commands:

```sh
npm run bench:linux-topology -- \
  --mode direct --rounds 96 --source-files 300 --workspace-driver auto \
  --output <direct-result.json>
npm run bench:linux-topology -- \
  --mode reuse --rounds 96 --source-files 300 --workspace-driver auto \
  --output <reuse-result.json>
```

This qualifies the safety and steady-state substrate benefit on the measured host. It
does not claim a predictor hit rate or end-to-end Agent speedup: admission still has to
compare predicted execution benefit with route preparation, validation, replay, and
commit cost for the current workload.
