# Self-speculation fork-gate ablation — 2026-08-25

This ablation evaluates the default rolling net-benefit gate before enabling it
for the portable sidecar fork. It uses the strict full-`K(a)` tape decoder from
`TAPE-BASELINE-2026-08-25.md`; tool-name-only matches do not count.

## Policy

- model-scoped rolling window: 4 observed forks
- warm-up: 4 observed forks
- minimum expected net benefit: 25 ms
- recovery probe: one fork after 4 suppressed decisions
- failure circuit: 2 consecutive failed forks, with the same bounded probe
- observation: `max(0, Actor action time - fork completion time) - fork latency`

The replay uses the fastest-completing Drafter response with an identical full
message context as a latency-matched D1 fork proxy. A proxy hit must contain the
Actor's complete tool name and parsed arguments. Tape clocks are request-relative,
so the offline proxy computes exact lead as `Actor duration - proxy duration` and
net benefit as `exact lead - proxy duration`. Each recording starts with a fresh
gate, matching a fresh plugin session.

## Results

| Tape | Decisions | Allowed / skipped | Exact proxy hits retained | Fork-cost proxy before / after | Reduction | Net proxy before / after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-mock-deterministic.json` | 4 | 4 / 0 | 2 / 2 | 284.546 / 284.546 ms | 0% | 469.993 / 469.993 ms |
| `deepseek-mock-success.json` | 4 | 4 / 0 | 2 / 2 | 274.064 / 274.064 ms | 0% | 512.353 / 512.353 ms |
| `pattern-learning.json` | 8 | 6 / 2 | 2 / 2 | 694.235 / 466.714 ms | 32.8% | 103.135 / 330.656 ms |
| **Pooled useful tapes** | **16** | **14 / 2** | **6 / 6** | **1,252.845 / 1,025.324 ms** | **18.2%** | **1,085.481 / 1,313.002 ms** |

The gate removes 12.5% of proxy fork requests and 18.2% of their service-time
cost while retaining all six available strict hits. The two suppressed pattern
forks were misses with negative utility, so aggregate net utility rises by
227.521 ms in the proxy model. Existing Drafter and PatternAware candidates are
not gated and remain in the unified candidate bundle.

`deepseek-live.json` is excluded: its four recorded HTTP responses contain the
provider's insufficient-balance error rather than model output. It remains an
error-path integrity fixture, not accuracy or latency evidence.

## Decision and limits

Accept the gate for sidecar forks. Keep periodic probes rather than permanently
disabling a model because workload utility can change. Provider-native SPORK
receives the same `fork_gate` policy as a protocol hint, but enforcement remains
the provider's responsibility.

This is replay evidence, not an end-to-end speedup claim: the tape does not
capture a real target decoder consuming forked KV state. Live validation still
requires a funded provider or a local GPU inference runtime. The policy follows
the cost-aware direction in [Learning to Draft](https://arxiv.org/abs/2603.01639)
and preserves bounded exploration needed for SPORK-style adaptive re-probing
([reference implementation](https://github.com/baihuajun24/spork)).

Reproduce a row with:

```sh
npm run bench:tape -- \
  --tape /private/path/pattern-learning.json \
  --actor-model deepseek-v4-pro \
  --drafter-model deepseek-v4-flash
```
