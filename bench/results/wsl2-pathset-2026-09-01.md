# WSL2 dynamic-pathset qualification — 2026-09-01

The production Pi `createBashTool`, process outlet, Linux execution world, Sandlock/namespaces,
private Git branch, freshness validation, and commit path were run on the same WSL2 host at base
`ae68fb0` and with shared dynamic-pathset validation.

The fixture publishes eight completed certificates for one identical child exec. Each certificate
observes a different 32 MiB input content but the same dynamic pathset. It then restores the oldest
input and invokes the child from a different parent Bash command.

| implementation | run | cold median (ms) | oldest-state hit (ms) | hit validation (ms) | cold/hit |
|---|---:|---:|---:|---:|---:|
| `ae68fb0` | 1 | 1855.06 | 1232.97 | 294.11 | 1.50x |
| `ae68fb0` | 2 | 1848.42 | 1341.07 | 299.75 | 1.38x |
| `ae68fb0` | 3 | 1914.27 | 1259.85 | 289.54 | 1.52x |
| shared pathset | 1 | 1741.75 | 1003.94 | 35.03 | 1.74x |
| shared pathset | 2 | 1751.00 | 998.48 | 40.97 | 1.75x |
| shared pathset | 3 | 1764.60 | 1017.82 | 38.14 | 1.73x |

Median comparison:

- hit validation: 294.11 ms -> 38.14 ms (7.71x faster, 87.0% lower)
- complete Bash hit: 1259.85 ms -> 1003.94 ms (255.91 ms / 20.3% lower)
- cold-median/hit speedup: 1.47x -> 1.74x
- the retained implementation considered all eight certificates, captured one pathset, read four
  files totaling 35,716,259 bytes, and selected the oldest matching strong key

All six retained runs prove that every historical execution was a miss/publication, the oldest state
hit across a different parent command, replayed output and the regular-file artifact agree, and branch
freshness validation succeeded. The shared-pathset runs additionally require exactly one pathset
capture and reject reading the 32 MiB input twice.

Per-run JSON is intentionally omitted; this reviewed table is the retained evidence.
