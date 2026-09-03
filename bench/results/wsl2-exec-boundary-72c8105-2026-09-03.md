# WSL2 producer/consumer dependency and held-child ablation

This report qualifies commit `72c8105` on Ubuntu 24.04, Linux
`6.18.33.2-microsoft-standard-WSL2` x86-64, and Node 24.20.0. Source, dependencies,
fixtures, stores, and temporary executables were on WSL's native filesystem. Three
independent runs used 20 samples per tracing row; the tables below report the median
of each run's median.

The child workload reads one workspace input, performs a fixed CPU loop, writes one
workspace artifact, and emits stdout. A full speculative provider first produced its
certificate. Completed replay then used a fresh backend sharing only the certificate
store, with `sandlock`, `strace`, and `unshare` each configured to a deliberately
nonexistent absolute path. Consequently a hit could not accidentally reuse a cached
successful dependency probe from the producer backend.

Raw results: [run 1](./wsl2-exec-boundary-72c8105-run1.json),
[run 2](./wsl2-exec-boundary-72c8105-run2.json), and
[run 3](./wsl2-exec-boundary-72c8105-run3.json).

## Conversion result

| Actor-visible outcome | Median latency | Relative to direct | Proof result |
| --- | ---: | ---: | --- |
| Direct child execution | 206.24 ms | 1.00x | Counterfactual |
| Adopt completed child | 30.74 ms | **6.71x; 85.1% less waiting** | 3/3 hits with Sandlock, strace, and unshare disabled at replay |
| Join running child after 300 ms lead | 123.45 ms | **1.67x; 40.1% less waiting** | 3/3 joined hits |
| Changed-input request | 210.26 ms | 0.98x | 0 hits; Actor child executed normally |

All three confinement-negative trials observed `PR_GET_NO_NEW_PRIVS=1` in the
speculative producer and `0` in the real Actor. They produced retained but tainted
evidence, made zero hits, and reported `actor_reuse_miss:certificate_tainted`.
Thus an observable sandbox result is not relabelled as an Actor result.

The in-flight row intentionally uses the original backend: unlike a completed CAS
result, a running process has live ownership, completion, and claim state in that
backend. Sharing the store alone must not fabricate transferable liveness.

## Runtime dependency split

| Operation | Minimum mechanisms in the current implementation | Not required for that operation |
| --- | --- | --- |
| Whole-command completed replay | Certificate/CAS store, current input validation, matching platform semantics | Sandlock, strace, namespaces, FUSE, native held-exec helper |
| Completed child adoption under a different Bash parent | Above plus x86-64 Linux held-exec helper and a transferable stdout/stderr descriptor route | Sandlock, strace, unshare, mount, FUSE, Git transaction creation |
| Join a running speculative child | Above plus the same live backend/claim registry and an active producer | No second trace or sandbox launch on the Actor hit path |
| Produce new reusable speculative evidence | Qualified confinement, complete process/dependency observation, output gate, and exact workspace transaction | FUSE is optional; the Git driver remains the fallback |

The completed-hit trial directly proves the second row's three named negative
dependencies. The other cells state the implementation contract and are not broader
claims about every Linux installation: held-child adoption still fails closed when
ptrace, process inspection, or descriptor transfer is unavailable.

## Observation cost

| Workload | Direct | Exec-event ptrace | Filtered strace + seccomp-BPF | Ordinary filtered strace |
| --- | ---: | ---: | ---: | ---: |
| Bash builtin | 4.58 ms | 4.71 ms (+2.8%) | 5.61 ms (+22.3%) | 12.69 ms (2.77x) |
| One child | 4.31 ms | 4.44 ms (+2.9%) | 5.74 ms (+33.2%) | 14.00 ms (3.25x) |
| 100 ms sleep | 104.47 ms | 104.64 ms (+0.2%) | 105.65 ms (+1.1%) | 118.99 ms (1.14x) |
| Syscall-heavy copy | 4.60 ms | 4.68 ms (+1.5%) | 6.45 ms (+40.0%) | 427.97 ms (92.96x) |

This supports the current architectural split: the Actor boundary observes only
process/exec events, while complete syscall evidence is paid on speculative misses.
It also exposes a large producer optimization opportunity, but `strace
--seccomp-bpf` is **not** safe to enable blindly. The
[strace manual](https://man7.org/linux/man-pages/man1/strace.1.html) specifies that a
higher-precedence filter can prevent strace from observing a syscall. Sandlock uses
Landlock together with seccomp filtering/user notification, so such a hidden denial
would erase exactly the confinement-difference evidence needed before Actor adoption.
The fast row is therefore an ablation result, not a production configuration. A
future replacement must obtain complete structured events from the confinement
broker itself or prove that every higher-precedence decision is also reported.

## Reproduction

```sh
npm run bench:exec-boundary -- --rounds 20 --output /tmp/pi-exec-boundary.json
```

The benchmark asserts output/exit equivalence, job-control continuation, detached
child return, completed hit, running join, changed-input miss, and confinement
rejection. It exits nonzero on any failed invariant.
