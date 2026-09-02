# WSL2 Bash dependency/replay ablation

Commit: `2419f16`

Host: Ubuntu 24.04 on WSL2, Linux 6.18.33.2, x86-64, Node 24.20.0,
Sandlock 0.8.6, strace 6.8. The repository and Linux dependencies were on the
native WSL filesystem. Five independent runs used the automatically selected
Git workspace driver and the same Bash workload with a child process that did
approximately one second of deterministic work.

All values below are min / median / max across five runs.

| Measurement | Result |
| --- | ---: |
| Direct Actor Bash | 1008.510 / 1008.774 / 1010.450 ms |
| Actor Bash under production-shaped strace | 1021.936 / 1024.437 / 1025.197 ms |
| strace overhead | 13.162 / 14.320 / 15.928 ms |
| strace slowdown | 1.013 / 1.014 / 1.016 x |
| Qualified speculative cold run | 1749.841 / 1780.759 / 1797.987 ms |
| Native Actor fallback | 1006.640 / 1007.593 / 1014.641 ms |
| Native Actor outlet overhead | -2.767 / -1.903 / 4.191 ms |
| Same-parent deterministic-child hit | 718.944 / 732.085 / 742.019 ms |
| Same-parent speedup | 2.358 / 2.432 / 2.497 x |
| Same-parent latency saved | 1007.822 / 1048.674 / 1077.154 ms |
| Different-parent deterministic-child hit | 691.959 / 711.446 / 730.536 ms |
| Different-parent speedup | 2.457 / 2.503 / 2.563 x |

All direct/trace equivalence, sandbox-to-Actor rejection, same- and
different-parent child reuse, output ordering, regular-file effect, freshness,
and changed-input miss assertions passed in all five runs. Whole-Bash replay
hits were zero; each run produced both child hits and rejected the changed
input.

## Interpretation

Every raw top-level trace observed `network`, `pid_observation`, and `random`.
Those observations now remain on the persistent certificate. Consequently the
sandbox result is neither published as a replayable whole-Bash result nor
accepted by the native Actor outlet. Certificate version 4 invalidates older
records that had erased those observations.

This corrects the earlier `97f4490` report, whose direct-Actor replay numbers
depended on treating Sandlock-controlled inputs as if they proved native-Actor
equivalence. They did not: a fixed random seed, a shifted clock, and isolated
PID/IPC namespaces describe a producer environment, not the consumer's current
values. Those whole-command speedup claims are withdrawn rather than retained
as an unsafe optimization.

The already-running speculative branch can still be selected as the execution
for the matching Actor call after its filesystem dependencies are revalidated;
that is adoption of the completed execution, not execution again. Persistent
replay is stricter. In this workload the deterministic child had no replay
taints, so it remained reusable inside both identical and different parent Bash
commands and saved about one second.

A second Actor-side strace cannot itself create this speedup: its complete log
arrives only after the second process has run. Online cross-Bash reuse needs a
pre-execution boundary, such as a broker stopping at `execve`, which validates a
certificate before either replaying the sealed result or letting the real child
continue.

Reproduce one run with:

```sh
npm run setup:linux
npm run bench:linux-process -- \
  --workspace-driver git \
  --output bench/results/local-dependency-ablation.json
```
