# WSL2 adaptive workspace-driver qualification — 2026-09-01

## Decision

Retain the host-visible FUSE copy-on-write driver, but do not make it the universal workspace
implementation. Production `auto` routing may select it only inside the trace-guarded Linux process
world, after the complete runtime capability probe succeeds, and when the exact Git baseline contains
at least 256 entries. Smaller trees, unsupported hosts, failed probes, recovered lifecycle faults, and
generic mutation routes retain the Git-worktree driver. Explicit `overlayfs` remains available for
qualification and diagnosis.

This is an adaptive choice rather than a claim that FUSE is always faster. The final paired WSL2 runs
show material gains at 500 and 1,000 source files, while the one-time route-preparation cost rises and
small-tree results are sensitive to host state. The conservative threshold captures the repeatable
large-tree gain without imposing a new filesystem on small workloads that already reuse Bash results.

## Structural design

The production isolation and adoption path is:

```text
Actor snapshot -> private Git object store -> immutable lower worktree per content commit
                                      fork -> unique FUSE upper/work + merged workspace
                                      seal -> shared lower structure + typed upper frontier
                                     adopt -> validate/lock/apply/verify/rollback transaction
```

The lower structure snapshot is built once per content commit and shared by the outer observer and
nested transaction. A branch refreshes only typed upper entries and their ancestors, reads final bytes
through the merged view, and compares them with the immutable Git/checkpoint baseline. `clone_fd` is
enabled when supported so repeated FUSE mounts can reuse the kernel connection. No Bash-, write-, or
command-name-specific replay path was introduced; driver selection and structure capture live behind
the generic workspace and execution-world capabilities.

The upper and work directories are outside the speculative process's writable private root. The
transaction fence is an unnamed `O_TMPFILE` inode on that private backing store, held open for the
branch lifetime. The probe proves cross-view timestamp ordering before the driver is eligible. The
existing Sandlock, user/PID/network/IPC/UTS/mount namespace, resource observation, freshness check,
atomic commit, verification, and rollback path remains authoritative.

This follows the requirement that a mounted OverlayFS lower tree remain immutable. The upper layer is
filesystem metadata, not an ordinary directory to merge blindly: whiteouts, opaque directories,
copy-ups, and creations become typed transaction inputs. Unexpected devices, alternate markers,
unsupported inode/link/type transitions, limits, or lifecycle ambiguity fail closed. Primary behavior
references are the [Linux OverlayFS documentation](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html)
and the [official fuse-overlayfs repository](https://github.com/containers/fuse-overlayfs).

## Semantic and lifecycle guard

Filesystem isolation does not imply syscall equivalence. `fuse-overlayfs` 1.18 exposes only
`redirect_dir=off`; renaming a lower directory initially returns `EXDEV`, although coreutils `mv` may
hide that by performing a copy/delete fallback. `O_TMPFILE` on the merged FUSE mount is also
unsupported. A successful exit after either fallback is therefore not proof that the same program
observed Actor-world semantics.

The complete strace stream marks workspace-local `EXDEV`, `EOPNOTSUPP`, `ENOTSUP`, and `ENOSYS`
results incomplete and tainted. Extended attributes, explicit timestamp updates, sparse-allocation
operations, and mutating file ioctls are guarded for the same reason. A real WSL integration test runs
coreutils `mv`, observes its handled cross-device result, and proves the branch cannot be adopted.

Normal unmount failure triggers process termination, a second normal unmount, and a mountinfo check. A
recovered failure demotes later `auto` routes to Git. If disappearance cannot be proven, the allocation
and its backing/lower references are quarantined rather than deleted. Plugin shutdown drains active
backends before closing only pools it owns, so mounts do not outlive their execution world and one
world cannot dispose another world's shared pool.

## Machine and method

- WSL2 Ubuntu 24.04, kernel `6.18.33.2-microsoft-standard-WSL2`, x86-64
- Node `v24.20.0`, Sandlock `0.8.6`, strace `6.8`
- `fuse-overlayfs` `v1.18`, official x86-64 static asset, SHA-256
  `56b0ae0aeb8abb308b068af2f137ed8d1bd239f4f27e21672ff0def861eea1e8`
- Stock Pi `createBashTool` through `linux_process_reuse`, real Linux child processes and filesystem
  effects; no mocked tool outlet
- Topology fixture: 32 MiB deterministic artifact, two created directories, 100–1,000 immutable
  source files, one publication warm-up and three cross-parent cache hits per process
- Main A/B: three fresh processes per explicit driver. Hit/fork medians pool nine calls; preparation
  and warm-up medians use the three process-level samples. Lower is better.

`routePreparationMs` is reported separately because it is a one-time process/route setup cost rather
than a cache-hit latency. Every report records the resolved driver fingerprint instead of trusting the
requested CLI option.

## Main retained A/B

| Baseline | Metric | Git worktree | COW typed frontier | Delta |
| --- | --- | ---: | ---: | ---: |
| 500 files | one-time route preparation | 249.42 ms | 330.11 ms | +32.35% |
| 500 files | publication warm-up | 1434.40 ms | 1082.60 ms | **-24.53%** |
| 500 files | cache-hit total | 1003.11 ms | 908.08 ms | **-9.47%** |
| 500 files | cache-hit fork | 928.75 ms | 841.25 ms | **-9.42%** |
| 1,000 files | one-time route preparation | 288.65 ms | 439.11 ms | +52.12% |
| 1,000 files | publication warm-up | 1715.60 ms | 1178.78 ms | **-31.29%** |
| 1,000 files | cache-hit total | 1105.38 ms | 959.34 ms | **-13.21%** |
| 1,000 files | cache-hit fork | 1035.62 ms | 883.07 ms | **-14.73%** |

All 36 measured cross-parent calls hit; all artifact bytes and typed directory effects matched; every
warm-up published; and no run was tainted. The result is specifically a storage-fork/reconstruction
gain on top of the existing Bash reuse mechanism. It is not an LLM-quality measurement.

The small `auto` fixture correctly retained Git. Across three fresh processes its median cold call was
1725.42 ms, cross-parent hit was 708.21 ms, and hit fork was 694.24 ms: 2.45x cold-to-hit speedup from
the Bash reuse system without paying FUSE cost. Each changed input forced a miss.

## Boundary calibration and final `auto` verification

An additional retained boundary A/B used two fresh processes and six hits per driver. It illustrates
why the threshold is deliberately conservative: COW reduced hit latency at 100 and 250 files on this
pass, but increased one-time preparation by 16.64% and 27.85%, respectively. Earlier small-tree runs
were within noise or negative, so these modest, order-sensitive gains are not treated as sufficient
evidence to route all small workspaces through FUSE.

| Source files | Metric | Git worktree | Explicit COW | Delta |
| --- | --- | ---: | ---: | ---: |
| 100 | route preparation | 211.80 ms | 247.04 ms | +16.64% |
| 100 | cache-hit total | 901.21 ms | 854.21 ms | -5.22% |
| 250 | route preparation | 230.75 ms | 295.01 ms | +27.85% |
| 250 | cache-hit total | 909.26 ms | 851.90 ms | -6.31% |

The final independent `auto` verification exercised the exact production selector:

| Fixture | Resolved driver | Median hit | Hits / misses / taints | Assertions |
| --- | --- | ---: | ---: | --- |
| small tool fixture | Git | 819.05 ms | 1 / 2 / 0 | all true; changed input missed |
| 100 source files | Git | 1023.94 ms | 3 / 1 / 0 | all true |
| 500 source files | COW | 984.11 ms | 3 / 1 / 0 | all true |
| 1,000 source files | COW | 1045.40 ms | 3 / 1 / 0 | all true |

The single miss in each topology report is the intentional publication warm-up. The threshold counts
every recursively listed tracked blob in the exact Git baseline, including the fixture input, rather
than trusting the benchmark's `sourceFiles` argument.

## Negative results retained

The first FUSE implementation mounted a COW view but still ran full-tree Git diff/ls-files during
sealing. The contemporaneous comparison recorded during qualification was slower:

- small hit: 689.996 ms COW versus 685.957 ms Git;
- 32 MiB hit median: 979.703 ms COW versus 920.609 ms Git, about 6.4% slower.

The two unoptimized COW measurements are preserved in this reviewed report. Their contemporaneous
Git measurements were overwritten by later qualification runs before evidence was staged, so the exact percentages above
are retained as a historical observation rather than presented as a fully reproducible paired A/B.
This provenance gap is itself recorded here instead of being hidden. The complete stage15 and stage17
paired reports are the evidence used for admission. The negative run still explains the structural
change: mounting alone is not the optimization; sharing the immutable-lower snapshot and using the
typed upper frontier removes repeated tree reconstruction work.

The private kernel-mount experiment also succeeded technically: the parent could inspect the merged
view through `/proc/<helper-pid>/root`. It remains only as `npm run bench:overlay-view`. The production
Bash world creates a later PID/mount namespace and remounts `/proc`, so relying on that helper path
would couple correctness to namespace layout. Host-visible FUSE avoids that hidden dependency while
remaining unprivileged and leaving no daemon between branches.

Per-run JSON is intentionally omitted after review. Results are host- and fixture-specific. They qualify this WSL2
implementation and selector but do not replace workload-distribution measurements from a long-running
agent deployment.
