# WSL2 workspace-transaction frontier qualification — 2026-09-01

The production Pi `createBashTool` fixture copies one 128 MiB input to a regular-file effect and
then reuses that effect from three different parent Bash commands. This qualification compares base
`3671ec8` with a generic workspace transaction driver that replaces nested-process whole-tree
content snapshots.

The retained driver walks inode structure, but reads bytes only for paths whose kernel-maintained
identity/change fields changed. An immutable Git tree supplies write-before bytes when the path was
previously clean; an exact in-memory frontier supplies them after an earlier mutation. The selector
is never itself a content proof: every selected regular file is opened without following symlinks,
read exactly, and re-statted before its bytes can enter a transaction. At both boundaries, a verified
same-filesystem ctime fence must advance beyond the first snapshot; structure must match both before
and after selected content is captured. Overlap, a coarse/non-advancing clock, limits, unsupported
inode transitions, or unstable reads make the interval non-reusable.

| implementation | process | cold (ms) | miss backend (ms) | three-hit median (ms) | hit fork median (ms) |
|---|---:|---:|---:|---:|---:|
| `3671ec8` | 1 | 2597.33 | 1484.39 | 1549.96 | 1347.46 |
| lazy fenced workspace frontier | 1 | 2463.69 | 1363.85 | 1473.76 | 1276.58 |
| `3671ec8` | 2 | 2625.51 | 1526.72 | 1476.98 | 1274.56 |
| lazy fenced workspace frontier | 2 | 2389.86 | 1290.68 | 1583.09 | 1364.56 |
| `3671ec8` | 3 | 2610.55 | 1508.88 | 1525.76 | 1315.03 |
| lazy fenced workspace frontier | 3 | 2382.46 | 1287.27 | 1541.14 | 1336.08 |
| `3671ec8` | 4 | 2607.54 | 1475.45 | 1506.60 | 1295.22 |
| lazy fenced workspace frontier | 4 | 2459.11 | 1304.76 | 1489.08 | 1269.21 |
| `3671ec8` | 5 | 2681.86 | 1568.88 | 1512.94 | 1297.88 |
| lazy fenced workspace frontier | 5 | 2416.47 | 1313.04 | 1497.45 | 1279.18 |

Median-of-process comparison:

- cold complete Bash execution: 2610.55 ms -> 2416.47 ms (194.08 ms / 7.4% lower)
- cold fork body: 2399.85 ms -> 2204.67 ms (195.19 ms / 8.1% lower)
- nested miss backend: 1508.88 ms -> 1304.76 ms (204.12 ms / 13.5% lower)
- complete Bash hit: 1512.94 ms -> 1497.45 ms (15.49 ms / 1.0% lower)
- hit fork body: 1297.88 ms -> 1279.18 ms (18.70 ms / 1.4% lower)
- all 30 measured hits had zero misses/taints and reproduced the 128 MiB artifact exactly

An earlier alternate-index prototype was rejected before qualification. Writing Git objects and
then reading the changed blob back made its cold median 8.6% slower than its interleaved base. No
part of that object-writing path remains in the retained implementation.

Per-run JSON is intentionally omitted; this reviewed table is the retained evidence.
