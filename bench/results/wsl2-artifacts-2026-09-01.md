# WSL2 verified-artifact-closure qualification — 2026-09-01

The production Pi `createBashTool`, process outlet, Linux execution world, Sandlock/namespaces,
private Git branch, freshness validation, and commit path were run on the same WSL2 host at base
`8019994` and with a verified artifact closure.

One cold execution publishes a child-process certificate whose regular-file effect is 128 MiB.
Each benchmark then removes that output and replays it from three different parent Bash commands.
Every replay hashes the materialized file and requires it to equal the original input.

| implementation | run | cold (ms) | three-hit median (ms) | planner validation (ms) |
|---|---:|---:|---:|---:|
| `8019994` | 1 | 3038.18 | 2084.65 | 245.45 |
| `8019994` | 2 | 2932.41 | 2017.85 | 241.07 |
| `8019994` | 3 | 3009.82 | 2107.08 | 243.45 |
| verified closure | 1 | 3022.41 | 1961.43 | 259.41 |
| verified closure | 2 | 2991.54 | 1842.64 | 242.99 |
| verified closure | 3 | 2993.41 | 1928.33 | 254.40 |

Median comparison:

- complete Bash hit: 2084.65 ms -> 1928.33 ms (156.32 ms / 7.5% lower)
- each hit loads two unique artifacts totaling 134,217,735 bytes before replay
- the base integrity-checks that closure and then reopens the same artifacts during replay; the
  retained path borrows the already verified bytes, halving CAS reads for this fixture
- all 18 retained hit executions reproduced the 128 MiB artifact exactly

The closure is loaded and SHA-256 verified before any workspace effect. Replay no longer depends on
reopening the backing CAS file, so deletion after planning cannot turn a partially applied replay into
a fallback execution. Output wire materialization and every file-effect buffer are also prepared
before the transactional workspace commit begins.

Per-run JSON is intentionally omitted; this reviewed table is the retained evidence.
