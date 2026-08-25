# Bounded D2 re-probe ablation — 2026-08-25

This ablation asks whether the Pi sidecar should issue one additional SPORK D2
fork after a D1 miss. No product retry loop is enabled by this report.

## Candidate policy and evidence boundary

The upstream SPORK implementation retries after additional main-model tokens and
uses probe logprob confidence to decide whether to commit. The available tapes
contain neither fork logprobs nor a real fork consuming a later Actor prefix, so
they cannot calibrate that confidence gate directly.

Two separately reported proxies avoid filling in those missing observations:

1. **Prediction diversity:** select the fastest-completing identical-context
   Drafter response as D1. After a D1 miss, use the second-fastest response as
   one bounded retry and ask whether its complete `K(a)` matches the Actor. Also
   check every remaining same-context response as an oracle upper bound.
2. **Snapshot runway:** decode each Actor SSE with timestamps. A sidecar D2 retry
   is eligible only if a second non-empty text/reasoning delta arrives before the
   first tool-call delta (or response end). This follows the current sidecar's
   safe snapshot format; partial tool-call JSON is not treated as ordinary
   generated text.

## Results

| Tape | Decisions / action turns | D1 hits / misses | Bounded retries | Retry hits / any-later oracle hits | Added fork cost | Snapshot-retry turns / action turns | Snapshot runway |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-mock-deterministic.json` | 4 / 3 | 2 / 2 | 1 | 0 / 0 | 75.315 ms | 1 / 0 | 0.322 ms |
| `deepseek-mock-success.json` | 4 / 3 | 2 / 2 | 1 | 0 / 0 | 77.584 ms | 1 / 0 | 0.368 ms |
| `pattern-learning.json` | 8 / 6 | 2 / 6 | 5 | 0 / 0 | 609.482 ms | 2 / 0 | 0.602 ms |
| **Pooled useful tapes** | **16 / 12** | **6 / 10** | **7** | **0 / 0** | **762.381 ms** | **4 / 0** | **1.292 ms** |

One blind retry would add seven requests (43.75% relative to the 16 D1
decisions) and 762.381 ms of request-relative service time, 60.9% of the D1
fork-cost proxy, without recovering one strict action. Searching every recorded
later same-context prediction still finds no additional hit after a D1 miss.

All four streams with a second safe snapshot are final-text responses. No Actor
action turn has a text/reasoning delta before its tool call: the mock action
turns enter `tool_calls` in their first useful SSE block. Their partial argument
JSON cannot be appended to the current forced-boundary fork prompt without a
different, boundary-aware continuation protocol. The final-text streams expose
only 1.292 ms total recorded runway after their second snapshot, far below even
the fastest proxy request.

`deepseek-live.json` is excluded because it records insufficient-balance HTTP
errors and contains no model output.

## Decision

Reject a Pi-side blind D2 retry and do not add its configuration or runtime
state. The measured variant raises request and service cost with zero coverage
gain, and the recordings lack the prefix/logprob evidence needed for the actual
SPORK confidence scheduler. Keep the analyzer so a future funded DeepSeek or
local-GPU tape with streamed reasoning and logprobs can re-open the decision.

A future implementation must first demonstrate all of the following:

- at least one strict post-D1 recovery on a real later-prefix replay;
- enough pre-action runway for the retry to complete;
- logprob/span-confidence calibration rather than tool-name acceptance;
- one in-flight fork at a time and a configurable maximum retry count;
- no loss of the existing six unified-bundle strict hits.

Reference: SPORK's D2 scheduler uses token-cadence re-probing, a bounded retry
count, and span logprob gates in
[`adaptive_scheduler.py`](https://github.com/xchang1121/spork/blob/main/spork_core/adaptive_scheduler.py).
