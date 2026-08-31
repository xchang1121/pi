# WSL2 typed-namespace replay qualification — 2026-09-01

This qualification exercises the production stock Pi `createBashTool` on WSL2's native ext4
filesystem. One compiled child process creates `generated/`, creates `generated/nested/`, performs a
deterministic 96-round-per-byte transform of a 32 MiB input, and writes the transformed artifact.
Three measured invocations use different parent Bash commands. The reuse case must publish the cold
child once, hit it from every different parent, recreate both directories, reproduce the artifact's
SHA-256 digest, validate the outer branch, and commit it transactionally.

The control uses the same stock Pi tool, helper binary, environment, and warm-up, but executes directly
in the workspace. It therefore includes ordinary Bash/process cost without charging the control for a
speculative Git world it does not need.

| pair | direct median (ms) | typed replay median (ms) | replay hits | misses | taints |
|---:|---:|---:|---:|---:|---:|
| 1 | 2665.77 | 936.26 | 3 | 0 | 0 |
| 2 | 2745.85 | 931.23 | 3 | 0 | 0 |
| 3 | 2710.33 | 967.68 | 3 | 0 | 0 |
| 4 | 2661.31 | 884.77 | 3 | 0 | 0 |
| 5 | 2686.65 | 939.78 | 3 | 0 | 0 |

Median of the five process medians:

- direct execution: **2686.65 ms**
- completed typed replay: **936.26 ms**
- reduction: **1750.39 ms / 65.1%**
- speedup: **2.87x**
- all 15 measured replays hit, all five cold executions published exactly one certificate, no run
  was tainted, and every run reproduced the same 32 MiB artifact digest and the two directory states

The retained implementation does not infer directory equivalence from Bash text. Content-free inode
snapshots produce typed `mkdir`/`rmdir` effects; certificates include the final directory entry digest,
mode, uid, and gid. The generic workspace transaction validates the source baseline, applies file
deletes and directory removals deepest-first, creates directories shallowest-first, applies file
writes, verifies final directory states, and reverses the same typed changes on failure. Monitor and
policy epoch v6 keep older certificates outside this semantic boundary.

## Preserved no-benefit results

Replay is not intrinsically profitable. Two exploratory points are intentionally retained:

| workload | direct median (ms) | replay median (ms) | result |
|---|---:|---:|---|
| 32 MiB transform plus 350 ms controlled delay | 384.56 | 937.24 | replay 143.7% slower |
| 48 deterministic transform rounds per byte | 993.67 | 973.06 | 2.1% lower; inside noise margin |
| 96 deterministic transform rounds per byte | 2686.65 | 936.26 | replay 65.1% lower |

The first row is a deliberate counterexample to unconditional cache adoption. It establishes a
follow-up requirement: process certificates need a learned execution-cost distribution and a replay
cost estimate (validation, artifact bytes, branch setup, and commit), with a conservative margin
before a completed result is admitted. Directory support is retained for semantic coverage and the
qualified expensive-task gain; the short-task regression is not treated as a win.

Raw reports:

- `wsl2-topology-direct-run1.json` through `wsl2-topology-direct-run5.json`
- `wsl2-topology-reuse-run1.json` through `wsl2-topology-reuse-run5.json`
- `wsl2-topology-short-direct-run1.json` and `wsl2-topology-short-reuse-run1.json`
- `wsl2-topology-boundary-direct-run1.json` and `wsl2-topology-boundary-reuse-run1.json`
