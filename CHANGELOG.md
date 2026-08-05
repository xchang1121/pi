# Changelog

## [Unreleased]

### Added

- Added a single-step speculative tool runtime with Pi Agent integration, conservative action keys, resource validation, lifecycle events, and running or ready result reuse.
- Added canonical sandbox keys, an explicit sandbox host boundary, temporary `write`/`edit` execution, verified adoption, and opt-in bash process execution.
- Added private Git worktree snapshots, multi-file bash change capture, transactional adoption with rollback, and normalized cache/actual telemetry.

### Changed

- Drafter candidates now reuse exact and containing-read cache entries, deduplicate in-flight work, and replace stale resource entries before execution.
- Resource candidates now use a configurable access-ordered LRU, and sandbox failures fall back without mutating the real workspace.
- Renamed read-only execution telemetry and settings to `resource_cached`/`resourceCached`; the Agent installer still accepts legacy `liveReadonly` input.
