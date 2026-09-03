# Exact metadata equivalence, WSL2

The stage-18 run uses the stock Pi Bash outlet on WSL2 (Linux 6.18.33.2, x86-64) and the production
Sandlock/strace/held-exec route. Raw measurements are in
`wsl2-exact-metadata-stage18-run1.json`.

| Case | Direct / Actor time | Result |
| --- | ---: | --- |
| completed 240M-iteration child | 229.18 / 24.49 ms | one hit; 9.36x lower Actor latency |
| same child already running with 300 ms lead | 181.77 ms Actor latency | one in-flight join |
| completed volatile child, same turn | — | one one-shot handoff |
| changed input | 226.74 ms | zero hits; Actor execution |
| private-workspace inode observation | — | private inode differed; zero hits; Actor saw source inode |
| anonymous inherited-descriptor metadata | — | zero hits; exact-proof fallback |

The positive child cases show that exact metadata evidence does not disable the high-value
cross-parent exec boundary. The two negative cases are intentional: identical bytes do not imply an
identical inode, and a future Actor output pipe has no proven identity equal to the speculative pipe.
`statx`, `statfs`/`fstatfs`, and `getdents*` also fail closed until their complete results are modeled or
normalized. No command-name allowlist is involved.
