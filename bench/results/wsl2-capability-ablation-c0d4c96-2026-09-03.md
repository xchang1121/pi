# WSL2 Bash reuse capability ablation

Implementation: `c0d4c96`, with the live-child admission row rerun at `945497a`.
Process/exec rows were measured at `4affb64`; the top-level in-flight row was rerun
after the ownership refactor.

Host: Ubuntu 24.04 on WSL2, Linux 6.18.33.2, x86-64, Node 24.20.0,
Sandlock 0.8.6, strace 6.8. Sources, tools and temporary workspaces were on WSL's
native filesystem. Each row is an end-to-end production-path run; the tracing rows
use 20 launches. These measurements qualify mechanisms, not a universal speedup.

## Dependency and yield

| Available mechanism | Safe operation demonstrated | Result on this host |
| --- | --- | ---: |
| Pi process outlet only | Execute the Actor command normally | 1009.65 ms for the 1 s workload |
| Completed store lookup, no matching proof | Fall through to the same outlet | 1014.62 ms; +4.97 ms (noise-scale) |
| Ordinary `strace` observation | Record dependencies after execution, without authority to speculate | 1024.02 ms; +14.36 ms / 1.014x |
| Store + native held-`execve` broker | Adopt a completed matching child before its first instruction | 27.84 versus 226.55 ms direct; **8.14x** |
| Same broker + measured live admission | Join a matching running child only when its remaining work plus adoption is cheaper than Actor execution | 68.83 versus 213.01 ms direct after 400 ms lead; **3.09x**, 144.17 ms saved |
| Full Sandlock + strace + Git transaction | Produce new proof and effects in advance | 2971.63 ms cold; cross-parent child hit 1897.94 ms / **1.57x** versus cold |
| Full stack + FUSE OverlayFS | Same proof with a COW storage driver | 3090.93 ms cold; cross-parent hit 1714.24 ms / **1.80x** versus cold |
| Full stack + Runtime-owned live top-level branch | Adopt one PID-tainted execution in the same turn | 2614.85 versus 4009.66 ms direct after 3 s lead; **1.53x**, 1394.81 ms saved |

The completed-child consumer was rerun with deliberately missing Sandlock and strace
binaries. It still hit, proving those producer dependencies are not accidentally required
on the hit path. A changed input missed and continued the held Actor child exactly once.
The top-level Bash trace observed descriptor, PID and random inputs and therefore produced
zero persistent whole-command hits. Those taints remain visible rather than being relaxed.

A later coverage probe at `709a2ff` made the existing helper save its cwd as a directory FD,
change to `/`, and return with `fchdir` before doing useful work. The production parser, sealing,
cross-parent replay, and changed-input miss all remained valid: direct was 1007.91 ms, cold Fork
was 2773.72 ms, and the cross-parent child hit was 1610.54 ms (**1.72x** versus cold). This proves
the additional hit coverage without adding a command-specific policy or a second benchmark path.

The live-child rerun first forced a changed-input Actor miss on the same execution class. The native
exec boundary reported that child's exact lifetime, so the shared scheduler could compare a lower
Actor quantile with upper speculative-remaining and adoption estimates. Linux uses a zero-wait cold
start: without an Actor counterfactual it resumes the held child and learns, rather than repeating the
old unbounded wait. Duplicate speculative producers still coalesce off the Actor critical path. The
learned lower-quantile estimate reported 134.30 ms saved for the 144.17 ms observed counterfactual;
an earlier completed hit with no Actor sample reported the hit but zero invented time savings.

The Git/OverlayFS pair is a small-tree result and does not establish a storage winner;
setup and host noise dominate. The automatic route correctly keeps Git below the qualified
tree-size crossover. FUSE changes performance only, never proof authority.

## Observation boundary

For the syscall-heavy microbenchmark, direct execution was 5.81 ms, the exec-event-only
Actor broker 5.63 ms, ordinary filtered strace 490.90 ms, and strace `--seccomp-bpf`
8.08 ms. The fast strace mode remains an ablation only: higher-precedence seccomp decisions
can hide the Sandlock denial that the producer proof must observe. Enabling it would improve
numbers by weakening evidence.

## Safe conversion frontier

One equivalence contract covers both lanes: semantic process identity, current dynamic dependencies,
immutable output/artifact closure, exact workspace before-state, producer guarantee and consumer
contract must all match. Ownership is deliberately singular: the generic Runtime owns top-level
running/completed branches and their cost-aware admission; the Linux backend's
`running -> completed -> claimed` transfer state belongs only to matching child `execve` units
inside otherwise different parent Bash calls. A rejected top-level join can no longer be silently
reintroduced by the direct process outlet.

- A clean sealed certificate is reusable across turns and across different parent Bash strings
  when they reach the same child `execve`.
- A volatile top-level branch (time, random, PID or descriptor observation) can represent the Actor's
  exact predicted execution once for its Runtime prediction horizon, even when that horizon crosses a
  model-turn boundary; it is never persisted. Volatile nested child transfer remains restricted to the
  same session and turn.
- A running candidate is not compared with a second running trace. One consumer waits for the
  original execution to seal, then uses the same validation and atomic commit path as a late hit;
  a second Actor call executes normally when the volatile branch has been claimed. Waiting is a
  performance decision made from measured Actor, speculative-service, and adoption distributions;
  it never substitutes for certificate validation.
- Network, IPC, interactive descriptors, unmodeled kernel state, incomplete traces and observable
  confinement differences remain ineligible unless a future resource broker supplies transactional
  semantics for that resource.

Speculator demonstrates why arbitrary mid-process adoption is a different dependency class: it
modified the kernel to checkpoint processes, propagate causal dependencies through files and IPC,
and gate external output. CRIU and DMTCP likewise have to capture or recreate memory, descriptors,
pipes, sockets, terminals, timers and shared state. Adding either as the default would be heavier
without making external effects automatically safe. For this plugin, sealed transaction transfer
is therefore the maximum lightweight frontier; full process checkpointing is only sensible as an
explicit, fully-contained, long-running profile.

## Gates and reproduction

All runs required output, exit status and final file equality. They also passed changed-input,
cross-turn running/completed, inherited-descriptor, exact-metadata and observable-confinement
negative tests. Windows and WSL each passed all 464 unit/integration tests.

```sh
npm run setup:linux
npm run bench:linux-process -- --workspace-driver git --output /tmp/pi-git.json
npm run bench:linux-process -- --workspace-driver overlayfs --output /tmp/pi-overlay.json
npm run bench:linux-inflight -- --output /tmp/pi-inflight.json
npm run bench:exec-boundary -- --rounds 20 --output /tmp/pi-exec.json
```
