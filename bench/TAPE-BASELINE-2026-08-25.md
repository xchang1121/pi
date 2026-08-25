# LLM tape strict-action baseline — 2026-08-25

This baseline freezes the private recordings used by the next self-speculation
ablations. The checked-in analyzer pairs Actor and Drafter requests only when
their complete message contexts are identical. A hit requires the tool name and
all parsed arguments to be exactly equal; recordings are read in place and are
not copied into the repository.

## Recordings

| Tape | SHA-256 | Opportunities | Exact hits | Raw / unique candidates | Unique yield | Exact lead |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-mock-deterministic.json` | `e6c150129262b9a4af4d0f3e994498e3404a8077e6e18b5e5e6c761390c204d8` | 3 | 2 (66.7%) | 7 / 5 | 71.4% | 754.539 ms |
| `deepseek-mock-success.json` | `e79552726706cbcbd9b9690975d428e45aeb6efcd2208fea6eeea70daa57eb72` | 3 | 2 (66.7%) | 7 / 5 | 71.4% | 786.417 ms |
| `pattern-learning.json` | `84870722753363eb150a72f4281c75c675450a649e7e07966e1739de83895cd7` | 6 | 2 (33.3%) | 16 / 11 | 68.8% | 797.370 ms |
| `deepseek-live.json` | `7e2efbf0d88a954fc335ffade0c12fe4cae69b0bc2809e80b008621d2a294f8e` | 0 | 0 | 0 / 0 | — | 0 ms |

The live tape contains four completed HTTP error responses caused by
insufficient provider balance, so it is an integrity fixture rather than model
quality evidence. It is excluded from pooled opportunity metrics.

## Findings and acceptance boundary

- Across the three useful tapes there are 12 strict Actor opportunities and 6
  Drafter hits. Raw candidate width is 30, but only 21 complete K(a) values are
  unique: 30% of candidate work is duplicate.
- Every exact hit in these recordings completes before its paired Actor call.
  The timing is sufficient for opportunity analysis but not an end-to-end
  latency claim because each request's tape clock starts at its own dispatch.
- The next ablations must preserve the six exact hits. A gate or ranking policy
  is rejected if it removes a hit, increases unique candidate work without new
  coverage, or treats a tool-only match as exact.
- PatternAware's previously measured extra exact hit is evaluated separately
  from the LLM-only numbers above; this analyzer deliberately reports Drafter
  wire actions and does not reconstruct the learned pattern store.

Reproduce one row with:

```sh
npm run bench:tape -- \
  --tape /private/path/pattern-learning.json \
  --actor-model deepseek-v4-pro \
  --drafter-model deepseek-v4-flash
```
