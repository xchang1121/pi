# Drafter Hedge Cancellation Ablation — 2026-08-26

## Question

The retained static-width ablation reduced the default Drafter width from eight
to two. Can both width-two requests still launch concurrently for latency
hedging, while canceling the slower request after the first response containing
a decodable tool call completes?

This follows the standard hedged-request lifecycle: accept the first successful
response and cancel outstanding attempts. The important difference is that
Drafter requests are stochastic candidates rather than exact replicas, so a
later candidate could improve action coverage. The replay therefore treats
zero later-recovered exact hits as a required safety gate rather than assuming
replica equivalence.

Primary references:

- Dean and Barroso, *The Tail at Scale*:
  https://research.google/pubs/the-tail-at-scale/
- gRPC Request Hedging guide:
  https://grpc.io/docs/guides/request-hedging/
- gRPC Cancellation guide:
  https://grpc.io/docs/guides/cancellation/

## Method

The checked-in `analyzeTapeDrafterRace` replay:

1. Uses only completed, strictly parsed Actor and Drafter exchanges sharing the
   same canonically serialized full message context.
2. Selects the first two Drafter requests by dispatch `sequence`, matching the
   retained product default, before considering completion time.
3. Declares the earliest completed response with a decodable `K(a)` the winner.
   Empty or malformed responses do not cancel peers. Each response contributes
   only its first tool call, matching the production Drafter source.
4. Compares full width-two coverage with winner-only coverage against every
   normalized Actor tool name and arguments. Request/candidate cost is charged
   once per Actor turn; exact coverage remains action-scoped.
5. Assumes both requests launch together. For a request lasting `d` and a valid
   winner completing at `w`, counterfactual service is `min(d, w)`. Thus the
   replay credits only the residual `max(0, d - w)`, never the whole duration of
   a concurrently running loser.

The insufficient-balance `deepseek-live.json` responses are excluded because
they contain no model output.

## Results

| Tape | Opportunities | Requests / abortable | Full → raced service | Saved | Full → raced hits | Later recovered | Full → raced K(a) | Exact lead |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-mock-deterministic.json` | 3 | 5 / 2 | 366.661 → 351.036 ms | 15.625 ms (4.26%) | 2 → 2 | 0 | 5 → 3 | 754.539 → 754.539 ms |
| `deepseek-mock-success.json` | 3 | 5 / 2 | 334.642 → 312.739 ms | 21.903 ms (6.55%) | 2 → 2 | 0 | 5 → 3 | 786.417 → 786.417 ms |
| `pattern-learning.json` | 6 | 11 / 5 | 1004.311 → 909.189 ms | 95.122 ms (9.47%) | 2 → 2 | 0 | 11 → 6 | 797.370 → 797.370 ms |
| **Pooled** | **12** | **21 / 9** | **1705.614 → 1572.964 ms** | **132.650 ms (7.78%)** | **6 → 6** | **0** | **21 → 12** | **2338.326 → 2338.326 ms** |

All six available strict full-`K(a)` hits remain early and retain exactly the
same lead time. The loser adds no exact hit in this cohort. Nine of 21 selected
requests are still in flight when the valid winner completes and account for
132.650 ms of removable residual service. Winner-only admission also removes
nine candidate bodies and six turn-local unique misses/duplicates.

## Decision

Accept the analyzer and product integration after the companion target-token
replay in `xchang1121/self-speculation` commit `6d2a3de`. Reducing 18 width-two
candidates to the 12 first-valid candidates leaves all 12 proposals, 198/144/54
proposed/accepted/rejected tokens, 278 target steps, and 138 saved steps
unchanged. The pinned real Transformers verifier likewise keeps 296 forwards
and identical output.

Pi implements the treatment as a generic Runtime policy over concurrent initial
proposal slots. The first produced update atomically expires only same-source,
same-decision proposal siblings with cause `proposal_race_lost`; continuation
slots are excluded. The Drafter declares this policy only at width two. Before
returning a produced update it verifies that the tool is enabled and its
arguments satisfy the current schema, so error, empty, disabled, and invalid
responses cannot cancel a valid peer. Widths above two retain all responses.

## Limitations

- There are only 12 strict action opportunities, and two mock tapes are related.
  This is a conservative local workload result, not a universal claim about
  stochastic multi-sampling.
- Summed response duration is a provider-work proxy. It is not token billing,
  server-side confirmation that cancellation halted generation, or end-to-end
  wall latency.
- Completed recordings cannot contain the actual canceled response. The service
  calculation is explicitly counterfactual and assumes prompt cancellation is
  honored by the provider.
- The replay deliberately waits for a valid tool call. Provider errors, empty
  responses, and malformed tool JSON do not win the race.
