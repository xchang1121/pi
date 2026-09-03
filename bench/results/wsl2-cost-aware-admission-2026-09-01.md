# WSL2 cost-aware candidate-adoption qualification — 2026-09-01

This qualification tests whether the Runtime should wait for or adopt a valid speculative Bash
candidate, rather than testing certificate correctness again. It runs the production stock Pi
`createBashTool` on WSL2's native ext4 filesystem with the same 32 MiB typed-directory fixture used by
the topology qualification. Each workload has three direct Actor executions and three completed
process-reuse executions. The latter reports private-world fork time separately from outer validation
and commit time.

The benchmark then feeds those real-machine observations into the production
`SpeculationScheduler`. Direct Actor execution, speculative-world execution, and adoption overhead
are deliberately distinct distributions. The table evaluates an in-flight candidate at zero elapsed
time (the most conservative arrival point) and also a candidate that completed before the Actor
arrived.

| rounds/byte | direct q50 (ms) | speculative fork q50 (ms) | adopt q50 (ms) | synchronous replay q50 (ms) | in-flight net (ms) | in-flight | ready net (ms) | ready |
|---:|---:|---:|---:|---:|---:|---|---:|---|
| 0 | 28.72 | 837.70 | 70.41 | 908.11 | -930.99 | fallback | -46.17 | fallback |
| 40 | 775.05 | 824.07 | 71.16 | 891.17 | -180.02 | fallback | 698.28 | join |
| 43 | 953.08 | 832.24 | 70.67 | 901.70 | -15.35 | fallback | 880.92 | join |
| 48 | 1003.57 | 836.17 | 73.57 | 905.33 | 47.13 | join | 916.07 | join |
| 96 | 2712.79 | 888.09 | 67.35 | 954.86 | 1705.23 | join | 2623.88 | join |

`in-flight net = Actor direct - Actor time already spent - speculative remaining - adoption`; `ready
net = Actor direct - Actor time already spent - adoption`. The unfinished-candidate decision uses a
low Actor quantile, high speculative and adoption quantiles, and the existing 25 ms minimum-benefit
margin. Completed work has no execution wait and falls back only when measured adoption is slower
than direct execution. Upper empirical selection makes q90 speculative and q75 adoption choose the
largest of three samples, while lower empirical q25 Actor chooses the smallest direct observation;
this is why the policy-net columns are more conservative than subtracting the displayed medians.

## What the boundary disproved

The 43-round point first failed an expected-fallback assertion: the initial analyzer used the shared
window's lower-index interpolation, so three samples made its nominal q90/q75 equal the median and
reported `+49.37 ms / join`. Review rejected that statistical interpretation. The retained policy
uses upper empirical selection for costs and now reports `-15.35 ms / fallback`. The earlier decision
is documented here rather than erased.

The fresh 48-round run selected an in-flight join with 47.13 ms estimated benefit. The earlier typed-
topology qualification measured the same nominal 48-round workload at only 20.61 ms faster than
replay and classified it as noise. Both results are retained. Their disagreement is evidence against
a fixed command-duration or transform-round threshold and in favor of bounded rolling distributions
scoped by exact action and execution-world class.

The zero-round workload also distinguishes cache availability from cache value. A completed,
correct certificate exists, but its measured 70.41 ms validation/commit path is slower than the
28.72 ms direct command. After learning both sides, the Runtime therefore executes the Actor action
instead of maximizing raw hit count.

## Runtime behavior and safety boundary

The scheduler makes this decision before candidate reservation and workspace commit. A rejected or
deadline-exceeded candidate does not mutate the Actor workspace; the ordinary authoritative tool
path remains the fallback. A timed-out speculative job is not cancelled solely because the Actor no
longer waits for it, allowing the existing certificate/result pipeline to retain useful learning for
later turns. No freshness, provenance, compatibility, artifact-integrity, transaction, or rollback
gate was weakened.

For an unfinished candidate with a measured Actor counterfactual but no speculative sample, the
Runtime uses the source remaining-time estimate plus a 25 ms uncertainty allowance. Both warm and
calibrated wait deadlines are bounded by the estimated Actor advantage and a slackened remaining-time
estimate. A completed candidate has no execution wait, so only measured adoption overhead can make it
unprofitable. If no measured Actor counterfactual exists at all, established reuse behavior is
preserved until the Runtime obtains one rather than manufacturing a duration threshold from a
potentially stale source hint.

The benchmark measures the three cost components independently, then invokes the exact
production scheduler model. Runtime deadline, fallback, and non-cancellation behavior are covered by
the Runtime integration test; this report does not claim that a synthetic Actor race was timed by the
benchmark harness.

Per-run JSON is intentionally omitted; this reviewed report retains the decisions and
aggregate measurements.
