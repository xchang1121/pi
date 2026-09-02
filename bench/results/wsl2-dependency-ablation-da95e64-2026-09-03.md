# WSL2 Bash dependency/replay ablation

Commit: `da95e64`

Host: Ubuntu 24.04 on WSL2, Linux 6.18.33.2, x86-64, Node 24.20.0,
Sandlock 0.8.6, strace 6.8. The repository was copied to the native WSL
filesystem and dependencies were installed there. Five independent runs used
the Git workspace driver and a child process with approximately one second of
work.

All values below are min / median / max across the five runs.

| Measurement | Result |
| --- | ---: |
| Direct Bash | 1008.893 / 1009.492 / 1010.773 ms |
| Bash under production-shaped strace | 1023.594 / 1024.154 / 1031.637 ms |
| strace overhead | 14.430 / 14.701 / 20.863 ms |
| strace slowdown | 1.014 / 1.015 / 1.021 x |
| Qualified speculative cold run | 1735.083 / 1750.549 / 1806.340 ms |
| Direct Actor completed replay | 19.902 / 20.915 / 22.439 ms |
| Direct Actor completed-replay speedup | 77.974 / 83.700 / 87.181 x |
| Full-world whole-command hit | 283.046 / 302.866 / 314.425 ms |
| Full-world whole-command speedup | 5.731 / 5.777 / 6.130 x |
| Different-parent child hit | 668.605 / 717.660 / 726.600 ms |
| Different-parent child speedup | 2.388 / 2.497 / 2.617 x |

Every direct/trace equivalence, output ordering, regular-file effect,
freshness, whole-command replay, cross-parent child reuse, and changed-input
miss assertion passed in all five runs.

## Interpretation

Raw observation was cheap for this workload, but it produced zero strict
certificates in five runs. Every trace observed `network`, `pid_observation`,
and `random` taints. Removing those observations from a certificate would be
unsound: the unconfined process was free to consume them. Running the Actor's
whole Bash under strace a second time could compare two histories only after
both had executed; it could not turn an already executed prefix into a safe
online hit.

The useful boundary is therefore not a pair of post-hoc strace logs. It is a
pre-execution validation point. A completed speculative certificate can be
replayed directly when its exact initial-state predicate still holds, which is
why the direct Actor path avoided the Linux world startup and achieved the
largest speedup. Reusing the same child under a different parent also worked,
but retained parent-shell and world costs.

This result rejects raw top-level Actor tracing as a reuse tier. strace remains
useful for learning dependencies and auditing misses. Cross-Bash online reuse
requires a transparent native `exec` boundary that pauses before the child's
first user instruction, validates an already sealed certificate, and either
replays its effects and result or lets that one real execution continue.

Reproduce one run with:

```sh
npm run setup:linux
npm run bench:linux-process -- \
  --workspace-driver git \
  --output bench/results/local-dependency-ablation.json
```
