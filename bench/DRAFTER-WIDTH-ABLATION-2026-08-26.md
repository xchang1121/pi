# Static Drafter Request Width Ablation — 2026-08-26

## Question

How many independent one-action Drafter requests are useful per Actor decision?
The package default was eight, while the private mock/SWE-style tapes contain
one to three completed same-context requests. This experiment asks whether a
smaller static width preserves strict full-`K(a)` coverage and candidate
readiness while reducing provider work.

Adaptive-Consistency stops repeated sampling once outputs agree, and
multi-candidate speculative-decoding work similarly treats candidate count as a
cost/coverage trade-off. Those results motivate measuring marginal samples, but
they do not justify importing a confidence rule here: the plugin has complete
tool calls and dispatch order, not calibrated per-sample answer confidence or a
parallel token-tree verifier.

Primary references:

- Adaptive-Consistency (EMNLP 2023): https://aclanthology.org/2023.emnlp-main.761/
- Multi-Candidate Speculative Decoding: https://arxiv.org/abs/2401.06706
- Improving Multi-candidate Speculative Decoding: https://arxiv.org/abs/2409.10644

## Method

The checked-in `analyzeTapeDrafterWidth` replay:

1. Keeps only completed Actor and Drafter exchanges with the same canonically
   serialized full message context.
2. Sorts same-context Drafter responses by request `sequence`, which represents
   dispatch/proposal order. It deliberately does not sort by completion time.
3. Selects the first `w` requests for `w ∈ {1, 2, 3, 8}` and compares complete
   normalized tool name plus arguments against every Actor action.
4. Charges requests, summed service duration, raw candidates, and unique
   candidates once per Actor turn. Exact hits and lead time remain action-scoped.
5. Treats all recorded requests as the local full-width baseline. Width 8 cannot
   invent unrecorded requests, so it equals width 3 for these recordings.

The malformed/incomplete/error paths remain excluded by the strict parser.
`deepseek-live.json` is also excluded because its responses are
insufficient-balance errors rather than model outputs.

## Results

| Tape | Opportunities | Width | Exact hits | Requests | Service proxy | Exact lead | Raw / unique K(a) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-mock-deterministic.json` | 3 | 1 | 1 | 3 | 224.944 ms | 378.299 ms | 3 / 3 |
|  |  | **2** | **2** | **5** | **366.661 ms** | **754.539 ms** | **5 / 4** |
|  |  | 3/all | 2 | 7 | 541.552 ms | 754.539 ms | 7 / 5 |
| `deepseek-mock-success.json` | 3 | 1 | 1 | 3 | 217.790 ms | 398.248 ms | 3 / 3 |
|  |  | **2** | **2** | **5** | **334.642 ms** | **786.417 ms** | **5 / 4** |
|  |  | 3/all | 2 | 7 | 499.395 ms | 786.417 ms | 7 / 5 |
| `pattern-learning.json` | 6 | 1 | 1 | 6 | 520.518 ms | 395.781 ms | 6 / 6 |
|  |  | **2** | **2** | **11** | **1004.311 ms** | **797.370 ms** | **11 / 10** |
|  |  | 3/all | 2 | 16 | 1589.498 ms | 797.370 ms | 16 / 11 |
| **Pooled** | **12** | 1 | 3 | 12 | 963.252 ms | 1172.328 ms | 12 / 12 |
|  |  | **2** | **6** | **21** | **1705.614 ms** | **2338.326 ms** | **21 / 18** |
|  |  | 3/all | 6 | 30 | 2630.445 ms | 2338.326 ms | 30 / 21 |

Width two preserves all `6/6` available strict hits, all of their early-ready
status, and the complete `2338.326 ms` exact-lead proxy. Relative to all recorded
requests, it removes `9/30` requests (30%), `924.831/2630.445 ms` summed Drafter
service (35.2%), and six duplicate candidate bodies. Width one removes more work
but loses three of six hits and is rejected.

The third dispatch slot is strictly dominated in this cohort: it adds no hit and
no exact lead on any tape. It does add nine requests, three new unique misses,
six duplicates, and a longer all-responses completion span.

## Decision

Accept the analyzer and use width two as the evidence-backed default for new
configurations. Keep `candidateLimit` user-configurable so deployments with
broader, genuinely diverse Drafter models can raise it. Do not add an online
agreement/confidence controller yet: these tapes are too small to calibrate one,
and concurrent early stopping would require a cancellation contract that the
current portable provider interface does not expose.

The product default change is intentionally a separate commit from this
measurement commit.

## Limitations

- There are only 12 strict action opportunities, and two mock tapes are related
  recordings. This supports a conservative default, not a universal optimum.
- The recordings contain at most three same-context requests. Slots four through
  eight are unobserved in this replay. Earlier retained experiments found broad
  five/eight-way samples collapsing to identical actions, but new provider/model
  combinations may differ.
- Summed response duration is a provider-work proxy, not token billing, target
  verifier time, or end-to-end wall latency under concurrency.
- Exact full K(a) is deliberately stricter than tool-name accuracy. This avoids
  claiming useful target-decoder drafts from wrong arguments.
