# WSL2 transaction-output hashing qualification — 2026-09-01

This follow-up isolates one remaining duplicate operation after transaction-delta evidence sealing.
The production Pi `createBashTool` fixture writes and replays a 128 MiB regular-file effect from
three different parent Bash commands. Base `43a4518` hashed the transaction's write-after bytes when
forming a top-level observation even though those bytes are not an input dependency and replay is
owned by the generic transaction.

The candidate gives transaction observations a distinct input-evidence-only type. It validates the
write-after inode kind, hard-link count, mode, and byte length against the structural snapshot, but
does not manufacture a second content digest or expose replay bytes through the observation API.

| implementation | process | cold (ms) | three-hit median (ms) | fork median (ms) | planner validation (ms) |
|---|---:|---:|---:|---:|---:|
| `43a4518` | 1 | 2759.79 | 1734.69 | 1514.04 | 282.75 |
| `43a4518` | 2 | 2760.05 | 1590.48 | 1391.53 | 254.73 |
| `43a4518` | 3 | 2731.96 | 1605.18 | 1374.01 | 251.06 |
| input-only observation | 1 | 2681.91 | 1539.18 | 1336.31 | 244.22 |
| input-only observation | 2 | 2680.83 | 1533.14 | 1331.01 | 257.52 |
| input-only observation | 3 | 2640.50 | 1503.33 | 1295.21 | 244.73 |

Median-of-process comparison:

- complete Bash hit: 1605.18 ms -> 1533.14 ms (72.04 ms / 4.5% lower)
- fork body: 1391.53 ms -> 1331.01 ms (60.52 ms / 4.3% lower)
- cold execution: 2759.79 ms -> 2680.83 ms (78.96 ms / 2.9% lower)
- all 18 measured hits had zero misses and reproduced the 128 MiB artifact exactly

Input and write-before bytes are still SHA-256 sealed when required for freshness. Only write-after
hashing was removed; the exact bytes remain in the immutable `SandboxFileChange` transaction used by
commit. Any structural/delta mismatch continues to make evidence incomplete.

Per-run JSON is intentionally omitted; this reviewed table is the retained evidence.
