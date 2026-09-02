# WSL2 held-exec boundary ablation

Commit: `47b2ce6`

Host: Ubuntu 24.04 on WSL2, Linux 6.18.33.2, x86-64, Node 24.20.0. The source and
temporary executable were on WSL's native filesystem. Each row contains 20 independent process
launches; values are medians measured around the complete launcher.

| Workload | Direct | exec-event-only ptrace | process-filtered strace | strace `--seccomp-bpf` |
| --- | ---: | ---: | ---: | ---: |
| Bash builtin | 4.671 ms | 4.653 ms | 13.305 ms | 4.885 ms |
| One external child | 5.186 ms | 4.997 ms | 15.100 ms | 6.268 ms |
| 100 ms external child | 104.381 ms | 104.310 ms | 119.132 ms | 105.875 ms |
| syscall-heavy external child | 5.027 ms | 4.844 ms | 428.774 ms | 6.989 ms |

The pass-through ptrace loop listens only for fork, clone, vfork, and exec events. Every mode first
had to reproduce the same stdout, stderr, exit code, and signal outcome. On x86-64 the probe then
replaced the second successful exec with an `exit_group(42)` stub: a five-second `sleep` returned 42
in 3.672 ms. This demonstrates that an online decision can avoid the child rather than merely detect
duplication after it has run.

The same probe also records why this is not silently enabled for native Actor fallback:

```text
direct: TracerPid: 0
ptrace: TracerPid: 6966
```

Linux additionally suppresses set-ID and file-capability transitions for ptraced executions. The
held-exec route therefore needs its own process-semantics fingerprint and explicit qualification; it
cannot consume or produce certificates described as untraced native execution.

The seccomp-BPF strace result is useful only when no higher-precedence filter masks it. Adding the
option to the current Sandlock run made the production qualification fail closed with
`target_exec_not_found`: Sandlock's `SECCOMP_RET_USER_NOTIF` action takes precedence over strace's
`SECCOMP_RET_TRACE`, so the target exec and subsequent provenance events did not reach strace. The
ordinary full trace remains required for that provider. This is a dependency-combination constraint,
not a reason to weaken trace completeness.

Reproduce the boundary measurements with:

```sh
npm run bench:exec-boundary -- --rounds 20 --output /tmp/pi-exec-boundary.json
```
