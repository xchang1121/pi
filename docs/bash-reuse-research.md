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

## Partial execution reuse

[CRIU](https://criu.org/Checkpoint/Restore) can restore memory, descriptors, namespaces, and process
trees, but its documentation treats many mounts, files, sockets, and devices as external resources.
Checkpoint adoption is therefore reserved for a later, stricter profile: a stopped, namespace-contained
process with no external descriptors and a filesystem snapshot committed atomically with the checkpoint.
Completed-result/effect replay remains the default because it has a much smaller semantic surface.

## Ordered implementation backlog

1. Share one exact dynamic-pathset capture across historic strong keys (implemented and qualified).
2. Load and integrity-check a certificate's complete artifact closure once before replay; replay only
   from the verified in-memory lease (implemented and qualified).
3. Add live exact-digest leases backed by a gap-detecting change journal; fall back to hashing on every
   uncertainty signal.
4. Replace whole-workspace before/after hashing with a complete kernel write journal or copy-on-write
   upper layer, while retaining Git as the adoption transaction.
5. Extract the Linux observer/isolation implementation behind the capability driver contract, then add
   a BuildXL-derived Windows driver and an entitled Endpoint Security macOS driver.
6. Evaluate CRIU only for long-running, pre-effect process checkpoints under the stricter external-
   resource profile.

Every item requires correctness tests for negative lookups, directories, symlinks, concurrent mutation,
trace loss, artifact loss, and process-tree escape, plus a real Pi Bash benchmark. A change that improves
latency but weakens any fail-closed condition is reverted rather than feature-flagged into production.
