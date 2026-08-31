# WSL2 transaction-delta evidence qualification — 2026-09-01

The production Pi `createBashTool`, process outlet, Linux execution world, Sandlock/namespaces,
private Git branch, adoption-time freshness validation, and transactional commit path were run on
the same WSL2 host at base `5ecfaf2` and with transaction-delta evidence sealing.

One cold execution publishes a child-process certificate whose regular-file effect is 128 MiB.
Each process then removes that output and replays it from three different parent Bash commands.
Every replay hashes the materialized file and requires it to equal the original input. The final
variant includes monitor epoch v4, hard-link-count metadata, and fail-closed directory semantics.

| implementation | process | cold (ms) | three-hit median (ms) | fork median (ms) | planner validation (ms) |
|---|---:|---:|---:|---:|---:|
| `5ecfaf2` | 1 | 3068.00 | 1968.58 | 1761.94 | 245.87 |
| `5ecfaf2` | 2 | 3059.56 | 2017.92 | 1803.32 | 247.45 |
| `5ecfaf2` | 3 | 3008.35 | 1958.68 | 1715.81 | 256.79 |
| transaction delta | 1 | 2764.69 | 1581.00 | 1362.58 | 241.12 |
| transaction delta | 2 | 2700.77 | 1625.00 | 1423.23 | 249.42 |
| transaction delta | 3 | 2706.32 | 1651.55 | 1451.50 | 264.40 |

Median-of-process comparison:

- complete Bash hit: 1968.58 ms -> 1625.00 ms (343.58 ms / 17.5% lower)
- fork body: 1761.94 ms -> 1423.23 ms (338.71 ms / 19.2% lower)
- cold execution: 3059.56 ms -> 2706.32 ms (353.24 ms / 11.5% lower)
- planner validation: 247.45 ms -> 249.42 ms (within 0.8%; the optimization is outside lookup)
- all 18 measured hits had zero misses and reproduced the 128 MiB artifact exactly

The retained path walks inode and directory structure before and after the top-level Bash, but reads
no regular-file contents during those snapshots. After execution, the generic Git transaction
captures exact before/after bytes once. The process backend joins that delta to the structural
snapshots and hashes only observed dependencies that are not already represented by the delta.

Directory creation/deletion, directory metadata changes, hard links, symlinks, special inodes, and
any mismatch between the structural observation and transaction delta make the evidence incomplete.
They are not approximated as ordinary file writes. The process monitor epoch was advanced so
certificates produced before these stronger rules cannot be selected by the new backend.

Raw reports:

- `wsl2-transaction-delta-5ecfaf2-run1.json`
- `wsl2-transaction-delta-5ecfaf2-run2.json`
- `wsl2-transaction-delta-5ecfaf2-run3.json`
- `wsl2-transaction-delta-stage9-run1.json`
- `wsl2-transaction-delta-stage9-run2.json`
- `wsl2-transaction-delta-stage9-run3.json`
