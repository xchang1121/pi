# Bash/process reuse research notes

This note records the design evidence used to evolve the process-reuse substrate. A mechanism is
not accepted merely because another system uses it: it must preserve Pi's observable process
semantics, fail closed when evidence is incomplete, and improve a checked-in real-machine
benchmark before it is retained.

## Reuse identity and dynamic dependencies

- [Transparent Result Caching](https://www.usenix.org/legacy/publications/library/proceedings/usenix98/full_papers/vahdat/vahdat.pdf)
  demonstrates process-lineage and system-call-derived dependency caching without requiring a
  build description. It supports treating an exec, rather than its parent shell text, as the reuse
  unit.
- [BuildXL's cache design](https://github.com/microsoft/BuildXL/blob/main/Public/Src/Cache/README.md)
  separates a weak fingerprint, a CAS-held dynamic pathset selector, and a strong fingerprint of
  current inputs. Several historic strong fingerprints can share one pathset.
- [Riker](https://www.usenix.org/system/files/atc22-curtsinger.pdf),
  [LaForge](https://arxiv.org/abs/2108.12469), and
  [Build Scripts with Perfect Dependencies](https://ndmitchell.com/downloads/paper-build_scripts_with_perfect_dependencies-18_nov_2020.pdf)
  show why dynamic reads, writes, directory queries, and negative lookups must be modeled together.
  [Forward Build Systems, Formally](https://arxiv.org/abs/2202.05328) gives the relevant correctness
  target: optimized execution must be observationally equivalent to executing the original command
  sequence.
- [Buck2 dep files](https://buck2.build/docs/rule_authors/dep_files/) independently use the previous
  dynamic input set to avoid invalidation by declared-but-unused inputs.

The immediate implementation consequence is a BuildXL-style lookup:

```text
exact exec prototype -> weak key -> capture each dynamic pathset once
                     -> current strong key -> newest matching result/CAS effects
```

The pathset identity includes observation semantics, not just path strings: dependency kind, file
role, metadata policy, negative-parent policy, and excluded backend entries. Therefore grouping
historic certificates does not weaken a strong-key comparison.

## Isolation and observation backends

- [BuildXL sandboxing](https://github.com/microsoft/BuildXL/blob/main/Documentation/Specs/Sandboxing.md)
  is the most directly reusable cross-platform reference. Its Windows backend uses an extended
  Detours implementation; its Linux backend documents why libc interposition misses static binaries,
  direct syscalls, and `io_uring`, and is moving toward eBPF.
- [ReproZip](https://github.com/VIDA-NYU/reprozip) uses `ptrace` to collect executable, file, library,
  and environment provenance for command-line experiments. It validates the current strace/process-
  tree direction but does not itself provide the transactional effect/adoption boundary needed here.
- [Landlock](https://www.kernel.org/doc/html/latest/userspace-api/landlock.html) supplies unprivileged,
  stackable denial of ambient Linux filesystem and network rights. Observation and restriction remain
  separate capabilities: a trace alone is not a sandbox, and a sandbox denial log is not complete
  read provenance.
- [Microsoft Detours](https://github.com/microsoft/Detours) is a viable Windows interception primitive,
  but raw API hooks are not yet a sufficient backend. A Windows driver must also cover child process
  propagation, file probes/enumerations, registry access, 32/64-bit transitions, containment, and
  transactional effects as BuildXL does.
- [Apple Endpoint Security](https://developer.apple.com/documentation/endpointsecurity) exposes exec
  and filesystem authorization/notification events, but requires a system extension and the
  `com.apple.developer.endpoint-security.client` entitlement. macOS must therefore report this backend
  unavailable unless an entitled helper is installed; it must not silently fall back to incomplete
  FSEvents or library interposition.
- [ProcessCache](https://repository.upenn.edu/bitstreams/94d981be-86c5-40e9-8d8a-2d4e625c5b9e/download)
  demonstrates the missing online boundary directly: it makes the decision at `execve`, substitutes a
  tiny exit image so close-on-exec semantics occur, and then replays effects and output. Plain `strace`
  can discover the same event but cannot perform this substitution.
- [AgentSH](https://github.com/canyonroad/agentsh) and the Linux
  [`ptrace`](https://man7.org/linux/man-pages/man2/ptrace.2.html) contract provide a maintained reference
  for `PTRACE_SEIZE`, automatic child stops, exec events, and `PTRACE_LISTEN` job-control handling. Pi's
  helper uses those kernel semantics but retains its own authenticated two-phase result transaction;
  no AgentSH source is embedded.
- [hS](https://www.usenix.org/conference/osdi26/presentation/liargkovas) uses streamed `strace`
  information to stop conflicting work early, not to turn a completed trace into a cache hit. Its
  source runs each region through `try`/OverlayFS and transfers selected shell state; the published
  setup also requires mergerfs, namespaces, cgroup privileges, and Python preprocessing. This is a
  useful high-capability Fork reference, not a minimum-dependency Actor path.

This leads to a platform-driver boundary with separately probed capabilities: process-tree capture,
complete read/probe/enumeration observation, write containment, nondeterminism denial, and atomic
effect export. Linux/WSL currently satisfies the contract. Windows BuildXL/Detours and entitled macOS
Endpoint Security are implementation tracks, not claims of current support.

## Validation acceleration

- [Watchman clocks](https://facebook.github.io/watchman/docs/file-query) explicitly signal a fresh
  instance after watcher restart or loss of history. The safe pattern is to use a journal only to prove
  that a previously exact digest remains current; a fresh instance, recrawl, overflow, or ownership
  change forces exact hashing.
- [NTFS USN journals](https://learn.microsoft.com/en-us/windows/win32/fileio/change-journal-records)
  provide the Windows equivalent: a persistent ordered volume change stream. Journal identity and the
  oldest retained USN must be part of any validation lease.
- BuildXL's cache pins CAS blobs for the lifetime of a session. Pi should similarly load and verify all
  effect artifacts before changing a target workspace, then replay from that immutable lease. Checking
  `has()` and reopening the blob after effects begin leaves avoidable I/O and a deletion race.

Metadata alone is not a cross-process content proof. `mtime`, size, and inode shortcuts may be used only
inside a live, gap-free change-journal lease whose exact content digest was already established.

## Transaction-delta evidence sealing

The outer private-Git world already computes exact regular-file before/after bytes in order to form
the adoption transaction. Re-reading every regular file before and after the top-level Bash therefore
duplicated work without adding an independent safety property. The retained design separates:

```text
process observer: inode kinds + metadata + directory entries + dynamic read/probe paths
transaction driver: exact regular-file before/after bytes and modes
evidence sealer: structural diff + transaction delta + hashes of observed unchanged inputs
```

The observer and transaction driver meet only through a generic post-capture callback. This avoids a
Bash-specific shortcut and lets a future OverlayFS, Windows USN/Detours, or Endpoint Security driver
provide the same typed delta. The Linux kernel's
[OverlayFS documentation](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html) confirms
that an upper layer explicitly represents copy-up data, metadata-only changes, whiteouts, and opaque
directories. Those distinctions must become typed delta records; merely listing upper filenames is
not sufficient.

The joined observation is deliberately not a second replay bundle. Its write events contain only
paths and write-before evidence; write-after bytes remain owned by the immutable transaction. The
sealer checks the write-after inode shape, mode, link count, and length against the structural
snapshot without hashing the output again. Input and write-before contents still receive exact
SHA-256 evidence. This additional separation reduced the qualified 128 MiB hit by another 4.5%.

Git represents regular bytes, symlinks, and the executable bit, but not empty directories, full
directory metadata, special inodes, or hard-link topology. The transaction qualified at this stage
therefore supported only regular files; directory transitions/metadata and link count other than one
failed closed. This is consistent with Riker's result that correctness requires modeling the full
POSIX namespace rather than treating every path as an independent byte string. Monitor epoch v4
prevents certificates from the older, weaker effect model from crossing this boundary.

On the qualified 128 MiB Pi Bash fixture, content-free structural snapshots plus transaction-delta
sealing reduced complete-hit median latency by 17.5% and cold latency by 11.5%. The raw reports and
method are in `bench/results/wsl2-transaction-delta-2026-09-01.md`.

## Nested workspace-transaction frontier

Nested cache misses formerly took two complete content snapshots even though the private Git world
already supplied an immutable baseline. The retained workspace transaction driver now separates
three notions that must not be conflated:

```text
change selector: dev + inode + ctime + mtime + mode + size + link count
content authority: immutable baseline blob or prior exact mutation frontier
semantic proof: before/after inode structure joined with exact regular-file bytes
```

The change selector is only a read-elision device. A selected file is opened with `O_NOFOLLOW`,
bounded, read exactly, and checked again through the same descriptor; a changed identity or metadata
invalidates the interval. The precise byte state then advances a workspace-wide frontier. This also
handles same-size overwrites and changes made by the parent shell between nested executions without
reading every unchanged input again.

Metadata by itself still is not accepted as a cross-process content proof. Before an operation can
start, a private regular-file sentinel, explicitly verified to be on the same filesystem, must obtain
a ctime strictly later than every inode in the proposed baseline. The structure is then rechecked,
the selected content is captured, and the structure is checked once more. The endpoint uses the same
ordering, so content reads occur inside—not before—the fenced stable region. Linux documents that a
successful [`write(2)` updates ctime](https://pubs.opengroup.org/onlinepubs/9690949599/functions/write.html),
while [`utimensat(2)`](https://man7.org/linux/man-pages/man2/utimensat.2.html) accepts caller values only
for atime/mtime and moves ctime to the current time. This makes kernel-controlled ctime a bounded
mutation-interval selector rather than a content proof. If the filesystem clock cannot advance within
100 ms, either endpoint moves, or the sentinel is not a private same-filesystem regular file, the
driver is permanently non-reusable for that workspace.

The driver is installed on `SandboxWorkspaceContext`, so the Linux process backend consumes one
generic mutation interval rather than implementing a Bash-specific snapshot. Concurrent intervals
contaminate one another and are not published; after they drain, the frontier resynchronizes from
structure. Symlinks, special inodes, directory metadata/type changes, hard links, limits, and any
partially captured frontier continue to fail closed. Directory creation/removal is carried by the
later typed namespace layer rather than by regular-file content capture. Monitor epoch v5 prevents
older certificates from crossing the new observation boundary. Construction is deferred until the
first interval begins, keeping replay-only branches off the observation path and taking the baseline
after parent checkpoints have been materialized.

Git's official [`diff-index` documentation](https://git-scm.com/docs/git-diff-index) distinguishes
tentative working-tree changes from content held in an index, while
[`update-index`](https://git-scm.com/docs/git-update-index.html) documents that refresh is stat-based
and does not calculate new object IDs. An evaluated alternate-index design therefore still needed to
write/read changed objects for exact bytes and regressed cold latency by 8.6%; it was removed. The
retained frontier uses Git only as immutable baseline content, never as the per-command change scan.

On the qualified real Pi Bash fixture, the fenced frontier reduced cold complete latency by 7.4% and
the nested miss backend by 13.5%; lazy initialization also made complete hits 1.0% faster. Raw
measurements and the discarded-experiment result are in
`bench/results/wsl2-workspace-frontier-2026-09-01.md`.

## Typed directory topology and replay profitability

Riker's event model separates namespace operations from file-content versions. The retained Pi
implementation now follows that boundary for directory creation and removal:

```text
structure snapshots -> typed write/delete/mkdir/rmdir effects
certificate journal -> exact mkdir entry digest + mode + uid + gid
workspace commit     -> validate all baselines -> delete/rmdir -> mkdir/write -> verify directories
rollback             -> reverse the same typed sequence and verify every original state
```

This is a workspace transaction feature, not a Bash adapter. The Linux process observer returns
typed directory changes through the existing generic post-capture boundary; checkpoints, nested
process publication, completed replay, outer adoption, locking, and rollback all consume the same
`SandboxWorkspaceChange` union. A directory change also takes the workspace-root commit lock, so it
cannot race a disjoint-looking file commit below the same namespace.

Created directories can be represented even when empty. Removed directories are admitted only when
the actual source directory's entry digest, mode, uid, and gid exactly match the private execution
baseline; this prevents Git's directory-metadata approximation from becoming a proof. Pre-existing
empty source directories remain outside the Git execution world's fidelity because Git cannot place
them in a fresh worktree. Existing-directory metadata edits, symlinks, hard links, special inodes,
renames that require identity preservation, and inode type changes still fail closed. Monitor/policy
epoch v6 prevents certificates without the typed state from being reused.

An unprivileged kernel OverlayFS capability probe first established that a lighter copy-on-write
driver was feasible. It was not promoted on that evidence alone. Linux's
[OverlayFS documentation](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html) requires
correct handling of whiteouts, opaque directories, redirect xattrs, metacopy, and hard-link indexing;
an upper directory is filesystem metadata, not an ordinary tree to copy into the Actor workspace.
That constraint is now enforced by the host-visible driver described below.

Real-machine profitability is workload-dependent. Five interleaved stock Pi Bash pairs on a
deterministic 32 MiB/96-round transform reduced median-of-medians from 2686.65 ms direct to 936.26 ms
replayed (65.1%, 2.87x), with 15/15 hits and zero taints. A shorter 384.56 ms task regressed to
937.24 ms under replay, while a roughly one-second task was within noise. Those negative points are
preserved in `bench/results/wsl2-topology-reuse-2026-09-01.md`; they require a cost-aware admission
policy based on measured execution distributions and estimated validation/artifact/commit cost rather
than unconditional adoption of every valid certificate.

## Cost-aware adoption, not certificate rejection

A certificate answers whether an effect is safe to reuse; it cannot answer whether waiting for or
materializing that effect is faster than authoritative execution. Putting a duration threshold into
the certificate layer would also reject a 900 ms replay that completed during Actor reasoning and now
costs only 70 ms to adopt. The retained design therefore makes profitability a generic Runtime
scheduler decision immediately before reservation and commit:

```text
Actor counterfactual       = q25(direct execution)
speculative remaining      = max(0, q90(speculative-world execution) - elapsed)
adoption overhead          = q75(validation + projection + commit)
estimated critical saving = Actor - remaining - adoption
```

The three sample windows are never mixed. An exact action key is preferred; a wider
`tool + executionFingerprint` class transfers evidence to a new but comparable command. The existing
benefit gate's 25 ms minimum net saving is reused instead of creating a second threshold system. A
candidate with a measured Actor estimate but no speculative sample uses its source remaining-time estimate
plus a 25 ms uncertainty allowance; every wait is limited by both Actor slack and a 1.25x
high-quantile or source remaining-time estimate. A
deadline falls back without cancelling the learning run. Completed candidates skip execution wait
entirely and are rejected only after measured adoption overhead itself exceeds direct execution.
Time already spent on an earlier matching candidate is deducted before evaluating the next one, so
several individually plausible candidates cannot each consume a fresh Actor-sized wait budget.
Source-provided action durations still guide launch order, but cannot trigger a hard fallback: only
an Actor observation from the current Runtime is a counterfactual. This prevents stale cross-session
latency hints from being mistaken for evidence about the current machine and load.

This follows the central result of [LATE](https://www.usenix.org/legacy/event/osdi08/tech/full_papers/zaharia/zaharia_html/):
speculation should rank estimated time remaining, and excessive guesses can degrade the baseline. It
also follows [GRASS](https://www.usenix.org/conference/nsdi14/technical-sessions/presentation/ananthanarayanan),
which balances immediate gains against resource opportunity cost, and Google's
[Tail at Scale](https://research.google/pubs/the-tail-at-scale/) argument for hedging with bounded
additional resources rather than unconditional duplicate work. For retention, the older
[GreedyDual-Size](https://www.usenix.org/legacy/publications/library/proceedings/usits97/cao.html)
result and Google's
[CacheSack](https://www.usenix.org/conference/atc22/presentation/yang-tzu-wei) both reinforce that hit
rate alone is the wrong objective when objects have unequal fetch/materialization costs.

Fresh WSL2 measurements locate a real crossover: zero-, 40-, and 43-round in-flight candidates fall
back, while 48- and 96-round candidates join. A ready 40-round result is still profitable because its
824 ms private execution has already been hidden. The fresh 48-round result disagrees materially with
the earlier noise-boundary run, so both are preserved rather than turning the workload parameter into
a fixed threshold. Full raw evidence and the negative results are in
`bench/results/wsl2-cost-aware-admission-2026-09-01.md`.

The next high-leverage cost reduction is deferred output materialization, not a weaker admission
gate. Bazel's
[Build without the Bytes](https://blog.bazel.build/2023/10/06/bwob-in-bazel-7.html) reports that eager
output downloads can outweigh cache benefits, and its
[Output Service](https://blog.bazel.build/2024/07/23/remote-output-service.html) keeps output metadata
visible while materializing content on first read. Pi can apply the same shape through the generic
transaction/artifact interface: validate a typed manifest, commit namespace visibility, and fetch CAS
bytes only for effects the Actor or a later tool actually reads. That requires filesystem-backed
fault handling and cannot be emulated by returning paths whose bytes are absent.

## Host-visible copy-on-write workspace driver

Two OverlayFS placements were evaluated. A private kernel mount in a helper namespace worked, and the
parent could reach its merged view through `/proc/<pid>/root`. It was rejected because the production
Bash world subsequently creates another PID/mount namespace and remounts `/proc`; correctness would
then depend on a helper PID path remaining visible across namespace boundaries. A host-visible
[`fuse-overlayfs`](https://github.com/containers/fuse-overlayfs) mount is inherited normally by the
existing descendant namespace, needs no root privilege, and leaves no daemon running between
branches. The package setup installs only a hash-pinned official static release.

The selected driver preserves the generic execution-world boundary:

```text
Actor snapshot -> private Git object store -> one immutable lower worktree per content commit
                                      fork -> unique FUSE upper/work + merged workspace
                                      seal -> typed upper frontier + exact merged-view bytes
                                     adopt -> existing validate/lock/apply/verify/rollback transaction
```

The upper and work directories are outside the speculative process's writable private root. The
transaction fence is held as an unnamed Linux `O_TMPFILE` inode in the private upper backing
filesystem rather than as a hidden path in the merged workspace, so directory enumeration by the
speculative process cannot discover a runtime control entry. The probe also proves that this private
clock orders file and directory ctimes projected through the FUSE merged view; the driver is rejected
if lower, upper, and work are not on that tested backing domain. The runtime lifecycle probe must
demonstrate lower-tree immutability, copy-up, creation, 0/0 character-device whiteouts,
`.wh..wh..opq` opaque replacement, anonymous-inode and cross-view clock semantics,
descendant-namespace visibility, and verified unmount. Driver identity includes the implementation
epoch, architecture, kernel, and binary version.
If normal unmount fails, the process is terminated, a second normal unmount is required, and mountinfo
is checked again. A recovered failure demotes that option set to Git for later routes; an unresolved
mount quarantines its pool outside the allocation index and deliberately retains upper/work/lower
references instead of reclaiming live storage. Quarantine is not an active lease, so global disposal
does not wait forever for a mount that requires OS/operator recovery.

Sealing walks only the upper journal. Copy-ups and creations select exact resources; a whiteout or
opaque marker expands only the affected immutable Git/checkpoint subtree. Final file bytes are read
through the merged view and compared with the exact baseline before the already-existing atomic Actor
transaction can be formed. Alternative marker encodings, device nodes, symlinks, hard links, limits,
and unsupported inode/type transitions fail closed. Extended attributes, explicit timestamp updates,
sparse-allocation operations, and mutating file ioctls are visible in the complete strace stream but
are not represented by the transaction, so they taint the branch and make adoption indeterminate.

The upper journal is also the storage driver's structure source. One complete immutable-lower
snapshot is prewarmed and shared per content commit by every branch, outer Bash observer, and nested
transaction; later captures refresh only typed upper entries and their ancestor directories in the
merged view. The Linux process world qualifies this path only after the exact Git baseline reaches
256 entries. This is a conservative boundary because small/100-file outcomes were host-sensitive and
the FUSE path adds one-time route-preparation cost, while retained 500/1,000-file runs showed larger,
repeatable gains. Smaller trees retain the prepared Git-worktree path, and generic mutation fallbacks
do not opt into FUSE because they lack the process world's complete semantic-error trace.

Filesystem isolation is not assumed to imply perfect syscall equivalence. In particular,
`fuse-overlayfs` supports only `redirect_dir=off`, so renaming a lower directory first returns
`EXDEV`; `O_TMPFILE` on the merged mount is another unsupported case. The process may handle such an
error and appear successful, but its result is not evidence of Actor-world equivalence. The observer
therefore marks workspace-local `EXDEV`, `EOPNOTSUPP`, `ENOTSUP`, and `ENOSYS` outcomes incomplete and
tainted. A real WSL test executes coreutils `mv`, observes its cross-device fallback, and proves that
the enclosing branch cannot be adopted. Explicit-driver benchmarks remain useful diagnostics; `auto`
is restricted to this trace-guarded process route.

Mounting alone was a regression: retaining the full-tree Git diff made the 32 MiB hit about 6.4%
slower. Sharing the immutable-lower structure and refreshing only the typed upper frontier reversed
that result. Three independent real Pi Bash processes per driver produced nine hits at each retained
large-tree size: median total hit time improved 9.47% at 500 source files and 13.21% at 1,000, while
publication warm-up improved 24.53% and 31.29%. The small `auto` workload stayed on Git and still
obtained a 2.45x cold-to-hit speedup from Bash reuse. Main, boundary, production-selector, and rejected
measurements are preserved in `bench/results/wsl2-overlayfs-workspace-driver-2026-09-01.md`.

## Partial execution reuse

Completed top-level process invocations and nested `execve` subtrees share the same certificate,
pathset validation, artifact closure, and typed workspace transaction. An exact repeated Actor Bash
can be replayed before its shell starts. On x86-64 Linux, a different real Actor Bash can now reuse a
completed or still-running child: the native helper holds the successful child exec before its first
instruction, and the existing planner either converts it to the sealed result or continues it once.
There is still no second Bash-text cache.

The helper deliberately observes exec/fork events only. Miss observation remains separate because a
process may have only one ptrace tracer and post-run evidence cannot retroactively make an uncontained
execution reusable. Its process key includes an explicit ptraced execution domain. The producer trace
also marks security-context reads, confinement-sensitive syscalls, and policy-denied results; such a
certificate can remain useful inside the identical Sandlock domain but cannot be adopted by the Actor.
Pipelines, redirected or extra descriptors, privileged executables, trace-sensitive programs, and
signal exits remain bypasses until their semantics are represented rather than inferred from command
text.

[CRIU](https://criu.org/Checkpoint/Restore) can restore memory, descriptors, namespaces, and process
trees, but its documentation treats many mounts, files, sockets, and devices as external resources.
Checkpoint adoption is therefore reserved for a later, stricter profile: a stopped, namespace-contained
process with no external descriptors and a filesystem snapshot committed atomically with the checkpoint.
Completed-result/effect replay remains the default because it has a much smaller semantic surface.

## Ordered implementation backlog

The phase/capability split, minimum dependency combinations, completed and in-flight conversion
protocols, and required ablation matrix are maintained in
[`bash-reuse-capability-lattice.md`](./bash-reuse-capability-lattice.md). That document is the current
implementation contract; the list below records the earlier storage/certificate work that led to it.

1. Share one exact dynamic-pathset capture across historic strong keys (implemented and qualified).
2. Load and integrity-check a certificate's complete artifact closure once before replay; replay only
   from the verified in-memory lease (implemented and qualified).
3. Seal top-level input evidence from content-free structure snapshots plus the generic workspace
   transaction delta, leaving write-after replay bytes solely in that transaction and failing closed
   on unsupported inode semantics (implemented and qualified).
4. Add cost-aware running and completed candidate adoption with conservative uncertainty margins; a
   valid cache hit may still execute when estimated remaining work and adoption cost exceed the
   learned Actor distribution (implemented and qualified).
5. Add live exact-digest leases backed by a gap-detecting change journal; fall back to hashing on every
   uncertainty signal.
6. Replace nested-process whole-tree content snapshots with a bounded exact mutation frontier
   selected by content-free inode change tokens (implemented and qualified).
7. Carry typed directory creation/removal through certificates, checkpoints, commit, verification, and
   rollback (implemented and qualified); retain fail-closed boundaries for metadata/link/type semantics.
8. Add a complete kernel write journal or typed copy-on-write upper layer to eliminate the remaining
   structure walks (implemented and qualified with a capability-selected FUSE OverlayFS driver;
   unsupported metadata semantics remain fail closed).
9. Extract the Linux observer/isolation implementation behind the capability driver contract, then add
   a BuildXL-derived Windows driver and an entitled Endpoint Security macOS driver.
10. Evaluate CRIU only for long-running, pre-effect process checkpoints under the stricter external-
   resource profile.

Every item requires correctness tests for negative lookups, directories, symlinks, concurrent mutation,
trace loss, artifact loss, and process-tree escape, plus a real Pi Bash benchmark. A change that improves
latency but weakens any fail-closed condition is reverted rather than feature-flagged into production.
