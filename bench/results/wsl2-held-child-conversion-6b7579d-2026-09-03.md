# WSL2 held-child conversion ablation

Commit: `6b7579d`

Host: Ubuntu 24.04 on WSL2, Linux 6.18.33.2, x86-64, Node 24.20.0. Sources,
dependencies, and temporary executables were on WSL's native filesystem.

## Result

Ten independent end-to-end runs used a 300 ms child. The speculative child and Actor invoked the
same child from different parent Bash strings and separate workspaces with identical initial state.
Before reuse, the broker recomputed SHA-256 for the input and executable script. A hit atomically
materialized the saved file, replayed buffered stdout/stderr, supplied the saved exit code, and
replaced the held child before its first user instruction. Every run compared output, signal/exit
outcome, final file bytes, and the reuse decision with a direct Actor execution.

| Actor path | Median | p95 | Relative to direct | Decisions in 10 runs |
| --- | ---: | ---: | ---: | ---: |
| Direct | 305.742 ms | 306.710 ms | baseline | n/a |
| Completed child | 6.724 ms | 9.656 ms | 45.47x; 299.018 ms shorter | 10 hits |
| Running child, 100 ms speculation lead | 204.752 ms | 218.031 ms | 1.49x; 100.990 ms shorter | 10 joins |
| Changed-input miss | 308.599 ms | 310.411 ms | 2.857 ms slower | 0 hits |

The join waited a median 198.819 ms for the already-running child, then used exactly the same
validation and result-conversion path as the completed hit. The changed-input case invalidated the
certificate and continued the held Actor child exactly once; it did not kill an eagerly started
Actor child after effects could escape.

The same committed runner also repeated the tracing-only measurements for 20 launches. An
exec/fork-event-only ptrace loop remained near launch noise: 4.986 ms versus 4.989 ms direct for one
external child, and 5.339 ms versus 5.774 ms for the syscall-heavy case. Ordinary process-filtered
strace took 15.173 ms and 456.097 ms respectively; strace `--seccomp-bpf` took 6.250 ms and 6.982 ms.
Small negative deltas are measurement noise, not negative overhead.

## What this proves—and what it does not

This closes the timing loop missing from two completed strace logs: the Actor child is stopped at an
online decision boundary, so completed work can be committed and unfinished work can be joined
before the duplicate computation runs. It also demonstrates that a dependency mismatch can retain
the ordinary Actor path at low cost.

It is still a benchmark provider, not a production equivalence claim. The exit stub currently covers
x86-64, and the fixture deliberately has closed stdin, buffered top-level output, a zero exit status,
and one atomic file transition. A production provider must construct the existing full process
prototype, validate the complete dynamic pathset under the transaction lock, preserve ordered output
routes, and bypass pipelines, interactive descriptors, signals, networking, privileged executables,
and concurrent shell children until their semantics are represented. Ptrace remains observable via
`TracerPid` and suppresses set-ID/file-capability transitions, so certificates must carry an explicit
ptraced execution-domain fingerprint.

The design agrees with ProcessCache's exec-unit approach, but its repository at
`a89d13214d8a0a9527ad4400a0a7284158d952a1` has no license file and its documented pipe, signal,
interactive, and network limitations are broader than this project's proof contract. No source was
copied. Incr at `4b8e5ddf8e275d947518c7cc0f5d2713fe992307` instead starts the child and kills it after a streaming
cache decision; that is a useful performance control, but not a safe Actor conversion after output or
external effects may have escaped.

Reproduce one complete run with:

```sh
npm run bench:exec-boundary -- --rounds 20 --output /tmp/pi-held-conversion.json
```
