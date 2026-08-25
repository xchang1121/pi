# Self-speculation integration ablation — 2026-08-25

## Question

Can Drafter and output-informed PatternAware predictions contribute complementary exact tool-call candidates to one target-decoder bundle?

## Replay evidence

- Recording: `pattern-learning.json`
- SHA-256: `84870722753363eb150a72f4281c75c675450a649e7e07966e1739de83895cd7`
- Integrity: 51 complete exchanges, 0 incomplete, 44 request keys, 204 chunks, 43 Flash and 8 Pro responses
- Replay smoke: one exact recorded request returned HTTP 200 as an 833-byte SSE response containing the recorded `read` call

The strict scorer counts an opportunity only when the predicted tool and complete arguments exactly equal the next recorded Actor call under the same context. The six chronological Actor opportunities were evaluated without fuzzy matching.

| Actor opportunity | Independent Drafter exact samples | Drafter hit | Incremental PatternAware hit |
| --- | ---: | ---: | ---: |
| first `read` | 2 / 3 | yes | no |
| first `edit` | 0 / 1 | no | no |
| first `bash` | 1 / 3 | yes | no |
| repeated `read` | 0 / 3 | no | no |
| repeated `edit` | 0 / 3 | no | yes |
| repeated `bash` | 0 / 3 | no | no |

After the recorded first `read → edit → bash` sequence was learned, the PatternAware predictor had no candidate before the repeated `read`. Rebasing on that authoritative `read` output produced the exact following `edit` with conditional probability `0.7491543883211478`; rebasing on the `edit` produced no unsupported `bash` candidate.

## Result and decision

- Drafter-only strict coverage: `2 / 6` opportunities.
- Unified Drafter + PatternAware strict coverage: `3 / 6` opportunities.
- Incremental coverage in this small cohort: one exact opportunity, or 50% relative to the Drafter-only hit count.
- Accepted: merge source-neutral concrete `K(a)` values into one target-decoder bundle and rebase multi-step PatternAware predictions on authoritative Actor or adopted-Drafter results.
- Not established: consensus weighting, production acceptance rate, or end-to-end latency gain. The sample is intentionally small and chronologically adapted; broader recorded and live-model evaluation remains required.

## Regression gates

- Plugin suite: 31 files and 323 tests passed.
- TypeScript library and benchmark type checks passed.
- Package build and `npm pack --dry-run` passed.
- The coordinator specifically verifies future-decision routing, stale-decision rejection, same-decision retry carry, identical-`K(a)` provenance merge, request cleanup ordering, and control-plane failure isolation.
