# Speculative-action ablation benchmark

This runner measures one speculative execution and reconstructs its serialized
counterfactual from the same authoritative timeline. It never compares against
a separately generated Actor trajectory.

The checked-in suites select real GitHub issue-resolution tasks from
[Claw-SWE-Bench Lite](https://huggingface.co/datasets/TokenRhythm/Claw-SWE-Bench).
The runner fetches only the selected base commit into a bare cache, creates a
fresh detached workspace for every run, and never exposes the gold patch to the
agent.

Run one task from `packages/speculative-action`:

```sh
DEEPSEEK_API_KEY=... npm run bench:ablation -- \
  --instance axios__axios-5316 \
  --label baseline \
  --latency remote \
  --candidate-limit 8 \
  --drafter-max-depth 2
```

PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = Read-Host -MaskInput "DeepSeek API key"
npm run bench:ablation -- --instance axios__axios-5316 --label baseline --latency remote
Remove-Item Env:DEEPSEEK_API_KEY
```

Latency profiles add the same deterministic delay to Actor and speculative
executions. `native` adds nothing; `remote`, `sandbox`, and `heavy` model
increasingly remote or isolated tools. The runner uses the package's production
OCI/native backend router and exact stock-Pi Bash invocation descriptor. The
result records backend health, invocation-specific Bash availability, the
profile, and raw tool execution counts. If no compatible isolated process
backend is ready, Bash candidates fail closed and the run must not be used to
draw conclusions about Bash hit rate.

Set `--drafter-max-depth 0` for the one-step Drafter ablation. Positive values
bound output-informed continuation steps after the first action.

Use `--drafter-disabled --pattern-aware --pattern-state <directory>` to isolate
PatternAware. The explicit state directory also selects a stable logical
repository identity, so training and evaluation runs in fresh temporary
checkouts share learned patterns without sharing workspace files. Without
`--pattern-state`, PatternAware state is intentionally isolated to one run.

`actualEndToEndMs` is the single speculative Agent invocation. Its serialized
counterfactual is reconstructed from that same run as:

```text
serializedCounterfactualMs = nonToolMs + authoritativeToolMs
```

`authoritativeToolMs` includes only tool work that produced the results on the
Actor's final path, including the full service time of an adopted speculative
execution. It excludes unused predictions. Agent-boundary overhead is counted
as non-tool time, while teardown after the Agent has completed is excluded.

Required ablation discipline:

1. Keep task, model, candidate count, latency profile, and task timeout fixed.
2. Change one algorithmic factor per commit.
3. Require a clean patch (`git diff --check`) and retain task completion signals.
4. Compare hit rate, `serializedCounterfactualMs / actualEndToEndMs`, hidden
   latency, tool work, and model cost together.
5. Retain an implementation only when repeated runs improve latency without a
   correctness or resource regression.

The API key is read only from `DEEPSEEK_API_KEY`; it is never written to an
artifact or exposed to benchmark shell processes. Workspaces and JSON results
default to the operating-system temporary directory.

Use `--prepare-only` to verify dataset lookup and the fresh checkout without a
model request. Patch cleanliness and changed-file overlap are integrity signals,
not an official SWE-bench correctness score; official grading still requires the
dataset's language toolchain and container harness.
