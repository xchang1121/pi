# Changelog

## [Unreleased]

### Added

- Added a single-step speculative tool runtime with Pi Agent integration, conservative action keys, resource validation, lifecycle events, and running or ready result reuse.
- Added canonical sandbox keys, an explicit sandbox host boundary, temporary `write`/`edit` execution, verified adoption, and opt-in bash process execution.
- Added private Git worktree snapshots, multi-file bash change capture, transactional adoption with rollback, and normalized cache/actual telemetry.
- Added a source-built Rust sandbox backend for Linux, macOS, and Windows, plus a versioned TypeScript broker, hash-verified packaged asset discovery, and fail-closed native process execution.
- Added coding-agent host integration support for persistent settings, native health reporting, and runtime event status.
- Added PatternAware online action-pattern learning with late-bound templates, future-gap leases, compact persistence, preparation hints, and utility-based resource scheduling.
- Added gap-weighted and decayed PatternAware inference, suffix backoff, collection mappers, retryable persisted analyzers, multi-step frontiers, and adaptive drafter suppression.
- Added watcher-backed resource versions with exact-validation fallback, eager invalidation, byte-bounded per-session caches, pooled Git workspaces, and phase-level runtime metrics.

### Changed

- Workspace adoption now serializes overlapping targets, uses staged atomic replacement, preserves file modes, and removes newly created directories during rollback.
- Drafter candidates now reuse exact and containing-read cache entries, deduplicate in-flight work, and replace stale resource entries before execution.
- Resource candidates now use a configurable access-ordered LRU, and sandbox failures fall back without mutating the real workspace.
- Renamed read-only execution telemetry and settings to `resource_cached`/`resourceCached`; the Agent installer still accepts legacy `liveReadonly` input.
- Pattern-aware and drafter predictions now deduplicate onto shared jobs, learned actions can be admitted immediately after authoritative results, and in-flight work is preempted by explicit utility and per-session cache budgets.
- Native sandbox protocol v3 now forwards the configured shell and requires an explicit process-isolation attestation; Linux recursively enforces read-only host mounts and readiness probes verify mount isolation.

### Fixed

- Agent uninstall now releases owned workspace sandbox pools immediately instead of retaining Windows file watchers until the idle timeout.
- Native release manifests and smoke requests now use protocol v3 and verify the isolation attestation.
- Shell dispatch recognizes Windows-style executable paths even when protocol tests run on a non-Windows host.
