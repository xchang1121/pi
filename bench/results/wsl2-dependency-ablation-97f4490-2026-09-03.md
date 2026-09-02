# WSL2 Bash dependency/replay ablation

Commit: `97f4490`

Host: Ubuntu 24.04 on WSL2, Linux 6.18.33.2, x86-64, Node 24.20.0,
Sandlock 0.8.6, strace 6.8. The repository was copied to the native WSL
filesystem and dependencies were installed there. Five independent runs used
the Git workspace driver and the exact same Bash command with a child process
that performed approximately one second of work.

All values below are min / median / max across the five runs.

| Measurement | Result |
| --- | ---: |
| Direct Actor Bash | 1008.758 / 1009.852 / 1010.693 ms |
| Actor Bash under production-shaped strace | 1023.379 / 1024.201 / 1024.966 ms |
| strace overhead | 13.400 / 14.621 / 15.114 ms |
| strace slowdown | 1.013 / 1.014 / 1.015 x |
| Qualified speculative cold run | 1777.259 / 1786.917 / 1815.222 ms |
| Direct Actor completed replay | 18.609 / 19.473 / 20.366 ms |
| Direct Actor completed-replay speedup | 49.532 / 51.872 / 54.312 x |
| Direct Actor latency saved | 988.392 / 990.555 / 992.084 ms |
| Full-world whole-command hit | 286.897 / 307.779 / 317.832 ms |
| Full-world whole-command speedup | 5.592 / 5.828 / 6.225 x |
| Different-parent child hit | 682.315 / 696.062 / 699.860 ms |
| Different-parent child speedup | 2.553 / 2.565 / 2.648 x |

Every direct/trace equivalence, direct/replay equivalence, output ordering,
regular-file effect, freshness, whole-command replay, cross-parent child reuse,
and changed-input miss assertion passed in all five runs.

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
replayed directly when its exact initial-state predicate still holds. Avoiding
both the real command and isolated-world setup produced the largest measured
gain. Reusing the same child under a different parent also worked, but retained
the parent-shell and world costs.

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
