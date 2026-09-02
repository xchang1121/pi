# Bash reuse capability lattice

This document turns the process-reuse literature into an implementation and ablation contract. The
target is not merely a cache hit: an adopted execution must be observationally equivalent to running
the Actor command once from the Actor-visible initial state. Missing optional Linux facilities should
remove only the operations that require them, rather than disabling every form of process reuse.

## One invariant, four operations

The implementation should expose four operations through the generic tool-execution gateway. They
share certificates and transactions, but carry different authority:

| Operation | What it may do | Minimum evidence | What a miss means |
| --- | --- | --- | --- |
| Predict | Produce an action identity without starting a process | Tool schema and execution identity | Keep predicting |
| Replay | Validate and materialize a completed certificate | Semantic identity, current dependency proof, immutable result closure, accepted producer guarantee | Fall through without executing |
| Observe | Trace an Actor-authorized execution and publish certificates | Complete process-tree observation plus exact workspace transaction | Run the Actor command normally; publication may fail closed |
| Fork | Execute before Actor authorization | All observation requirements plus complete containment and gated effects/output | Do not execute when containment is unavailable |

`strace` belongs to Observe and Fork. It supplies evidence after events occur; it supplies no authority
to perform an event. Landlock, a correctly configured namespace sandbox, or another confinement
provider belongs only to Fork. Consequently, lack of Landlock must not disable Replay or Observe.

The phase is part of route selection. Advertising one undifferentiated capability set for both
authoritative capture and speculative execution is incorrect: it makes a strong Fork dependency a
prerequisite for a weaker, already-authorized Observe operation.

## Reuse unit and certificate

Arbitrary syscall prefixes are not a reusable semantic unit. Equal prefixes do not establish equal
future behavior, and a second process cannot jump into the first process's memory, descriptor, and
shell state without a jointly captured process checkpoint. The portable reuse units are therefore:

1. a complete top-level process-backed tool invocation;
2. a complete `execve` subtree intercepted before the Actor launches that child; or
3. an explicitly sealed shell/transaction checkpoint whose complete interpreter state is modeled.

The second unit allows different parent Bash strings to share expensive children. Shell builtins,
functions, assignments, redirections, and control flow remain part of the parent shell unless a
shell-aware frontend creates an explicit checkpoint.

A certificate has four orthogonal parts:

```text
semantic identity     executable digest, argv, cwd, environment, stdin/FDs,
                      credentials, limits, signals, platform semantics
dynamic dependencies  file contents and metadata, directories, negative lookups,
                      symlink resolution and every other admitted input
result transaction    ordered stdout/stderr/exit plus exact before -> after workspace transitions
producer guarantee    how observation, containment, trace completeness and output gating
                      were established
```

The semantic identity must not include a particular sandbox product. Conversely, the producer
guarantee must not be discarded. A consumer accepts a certificate when its semantic identity and
current dependencies match and its proof covers the requested operation. This permits, for example,
an Actor-observed certificate to be replayed inside a later Landlock fork without pretending the two
producers used the same policy.

Environment variables are conservative inputs unless the runtime can prove which variables a program
read. File metadata is only a digest shortcut inside a continuous, gap-detecting journal lease; an
untrusted `mtime` match is not a content proof. Network, IPC, devices, interactive terminals,
unmodeled `ioctl`, trace loss, escaped children, and nondeterministic inputs taint publication unless a
provider denies, virtualizes, or captures them completely.

## Completed and running conversion

"Turning speculation into the Actor environment" should mean transferring ownership of a sealed
result transaction, not transplanting a live process into the Actor namespace.

For a completed result:

1. find candidates with a cheap semantic weak key;
2. validate each distinct dynamic pathset once against the Actor-visible state;
3. load and integrity-check the complete artifact closure before changing the workspace;
4. reserve the certificate for this Actor action;
5. compare every saved before-state again while transaction locks are held, apply the typed
   after-states, then return ordered output and exit status; and
6. roll back or fail the Actor call if commit cannot be completed exactly.

For an exact in-flight duplicate, the Actor may join the existing future only when both executions
share semantic identity, initial snapshot, containment semantics, output contract, and at-most-once
ownership. Speculative output remains gated. When the future seals, the normal validation and commit
protocol runs. If the Actor's expected direct time is less than remaining execution plus adoption
cost, it starts the authoritative command instead and leaves the speculative run available for
learning.

Different parent Bash commands cannot join their already-running shell states. They can reuse at the
next child `execve`: an Actor-side broker pauses the child before launch, validates an earlier child
certificate, and either replays it or lets the Actor-authorized miss execute under observation.

## Minimum dependency combinations

These are cumulative capability combinations, not user-facing levels:

| Available mechanisms | Safe useful behavior | Deliberately unavailable |
| --- | --- | --- |
| Certificate store + exact hashing/CAS | Replay compatible completed certificates before shell launch; the Pi host executor remains the miss path | New process execution before Actor authorization |
| Above + `strace -f` | Observe an Actor-authorized top-level command and publish strict read-only certificates | Child substitution and speculative misses |
| Above + exact workspace transaction | Learn and replay typed workspace effects | Unmodeled effects; early misses |
| Above + user/mount namespace and pre-`execve` broker | Reuse completed or identical in-flight child subtrees across different Actor Bash strings; Actor misses execute and teach the store | Miss execution before Actor authorization |
| Above + qualified confinement and output gating | Execute cache misses ahead of the Actor, then adopt their transactions | Any operation not covered by the confinement proof |
| Above + copy-on-write/journal acceleration | Reduce capture and materialization cost without changing correctness | No additional authority is inferred from faster storage |

The confinement slot is capability-based. Sandlock/Landlock is one provider; a qualified Bubblewrap,
nsjail, container, or future platform driver can satisfy the same contract. Bubblewrap explicitly
describes itself as a low-level toolkit, so binary presence alone is never qualification: the concrete
policy must prove process-tree containment, write confinement, network/IPC denial, nondeterminism
handling, and cleanup.

Namespace setup must preserve Actor-visible process identity. The Linux provider maps the current UID
and GID to themselves and retains only the namespace capabilities needed for private mounts; mapping
the Actor user to namespace root would make otherwise ordinary commands such as `id -u` observably
different before reuse is even considered.

Windows can participate immediately in certificate replay when semantic/platform fingerprints match.
A native Observe/Fork provider requires BuildXL-grade process propagation and filesystem/registry
coverage; raw Detours hooks or filesystem watchers are not equivalent. WSL is a Linux provider whose
workspace mount and executable/platform identity remain distinct from native Windows.

## Evidence from existing systems

| System | Mechanism worth retaining | Boundary for this project |
| --- | --- | --- |
| [BuildXL two-phase lookup](https://github.com/microsoft/BuildXL/blob/main/Documentation/Wiki/Advanced-Features/Two-Phase-Cache-Lookup.md) | Weak fingerprint -> historic dynamic pathsets -> strong fingerprint; pathset augmentation | Build actions have stronger declarations than arbitrary shell processes |
| [Rattle](https://github.com/ndmitchell/rattle) / [formal model](https://arxiv.org/abs/2202.05328) | Forward execution, dynamic hazards, speculation, observational-equivalence target | Hazards detect dependency errors; they are not an isolation proof by themselves |
| [Riker](https://www.usenix.org/system/files/atc22-curtsinger.pdf) | Process-level incremental reuse and POSIX namespace dependencies | Its tracing assumptions must be requalified for Pi's threat model |
| [LaForge](https://arxiv.org/abs/2108.12469) | System-call-derived dependencies and incremental command reuse | Build workloads do not cover every interactive or external Bash effect |
| [Buck2 dep files](https://buck2.build/docs/rule_authors/dep_files/) | A prior dynamic input set narrows later validation | A previous pathset is a selector, not proof that no new dependency will appear |
| [Bazel remote cache](https://bazel.build/remote/caching) | Separate action result and content-addressed artifacts | Declared hermetic actions make identity easier than general Bash |
| [Build without Bytes](https://blog.bazel.build/2023/10/06/bwob-in-bazel-7.html) | Lazy output materialization can dominate cache economics | Requires a filesystem-backed fault/materialization boundary |
| [Incr](https://github.com/atlas-brown/incr) / [OSDI paper](https://yizhengx.github.io/p/incr:osdi:2026.pdf) | Unmodified Bash, command-level caching, `strace`, OverlayFS, streaming, introspection and compaction; average 34.2x reported on its workloads | `mtime`-only read validation, distribution-specific environment filtering, and killing an eagerly launched child after a hit are too weak for strict speculative proof |
| [hS](https://atlas.cs.brown.edu/pdf/hs:osdi:2026.pdf) | Transactional speculative states, sequential commit, conflict restart, effect layering and a speculation-window ablation | Assumes non-malicious scripts and leaves mmap, several aliases/resources, and opacity outside scope |
| [`try`](https://github.com/binpash/try) | Stackable user/mount-namespace OverlayFS effects and inspection/apply workflow | Explicitly a semisolate, not a security sandbox |
| [TREC](https://www.usenix.org/legacy/publications/library/proceedings/usenix98/full_papers/vahdat/vahdat.pdf) | Transparent result caching from process lineage and syscall dependencies | Predates current namespace, async-I/O and adversarial surfaces |
| [shournal](https://github.com/tycho-kirchner/shournal) / [paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC10901821/) | Low-overhead shell provenance and practical file tracking | Provenance and partial hashes are not complete replay certificates |
| [seccomp user notification](https://docs.kernel.org/userspace-api/seccomp_filter.html) | A future pre-syscall broker can mediate selected operations | vDSO and incomplete syscall policies require explicit treatment |
| [fanotify](https://man7.org/linux/man-pages/man7/fanotify.7.html) | Filesystem notification/permission events can reduce observation cost | Documented event and queue gaps prevent using it alone as completeness proof |
| [CRIU](https://criu.org/Checkpoint/Restore) / [external resources](https://criu.org/External_resources) | Possible checkpoints for very long, fully contained executions | External sockets, files, mounts, devices and kernel state make this a strict optional profile, not the default |

Simple output caches such as [`bash-cache`](https://github.com/dimo414/bash-cache) and
[`bkt`](https://github.com/dimo414/bkt) are useful negative controls: command text, arguments and TTL
can be fast, but do not prove dynamic inputs or replayable effects.

## Required dependency and performance ablation

Every retained provider must be measured on the same WSL-native filesystem and stock Pi Bash outlet.
Each row changes one mechanism while command, initial snapshot, iterations and machine remain fixed:

| Experiment | Mechanisms enabled | Question answered |
| --- | --- | --- |
| Direct | None | Actor counterfactual |
| Trace | Actor `strace` only | Pure observation overhead |
| Publish | Trace + dependency/effect sealing | Cost to create reusable proof |
| Whole hit | Completed top-level replay | Best whole-command saving |
| Child hit | Broker + completed child replay under a different parent string | Cross-Bash partial-reuse saving |
| Child join | Broker + identical in-flight child | Value and wait cost of unfinished work |
| Fork miss | Full confinement + transaction | Cold speculative overhead |
| Fork hit | Full confinement + prior certificate | Interaction between early execution and nested reuse |
| Storage A/B | Git versus qualified copy-on-write driver | Capture/materialization crossover only |

Sweep workloads across no-op, 100 ms, 1 s and 10 s CPU tasks; 32/128 MiB artifacts; small and
10,000-entry trees; read-heavy dependencies; typed directory effects; pipelines with bounded stdin;
and different parent Bash programs sharing one child. Report median and tail latency, setup, trace,
validation, hashing, execution, sealing, artifact loading, commit, bytes read/written, hit/join/miss/
taint counts, avoided process time, critical-path saving, CPU time and peak memory. Cold-cache and
warm-cache results remain separate.

Correctness gates deliberately mutate file contents without a useful timestamp change, directory
entries, negative lookups, symlink targets, environment, stdin, executable bytes and platform
fingerprint. They also exercise trace truncation, killed children, concurrent workspace mutation,
network/IPC attempts, interactive descriptors, unsupported ioctls, artifact corruption, broker loss,
timeouts and commit rollback. A performance result is discarded unless output, exit status and final
workspace match the direct Actor run and every unsafe case fails closed.

The admission ablation sweeps concurrent speculation width rather than selecting a fixed threshold.
It compares expected Actor service time against speculative remaining time plus measured validation
and commit cost. This follows [LATE](https://www.usenix.org/legacy/event/osdi08/tech/full_papers/zaharia/zaharia_html/)
and hS: more speculation can expose parallelism, but wasted work and isolation overhead eventually
dominate.

## Refactoring order

1. Split world routing by operation so Observe has independent requirements from Fork.
2. Split certificate semantic identity from producer guarantees and migrate the store epoch.
3. Expose hit-only completed replay before any process fork; it must work without `strace` or Landlock.
4. Add Actor-authorized top-level observation, first for no-workspace-effect certificates and then via
   the existing generic workspace transaction.
5. Run the existing child broker in Actor mode: hits replay, misses execute normally and publish,
   without claiming speculative authority.
6. Admit alternative Fork providers through the same qualification contract.
7. Implement the ablation rows above and expose only plain-language TUI capabilities derived from
   successful probes.

Each step is independently testable and must leave unsupported operations unavailable. No step adds a
command-name allowlist or claims safety from Bash text similarity.

The hit-only path is attached to Pi's process outlet, not to the speculative-world probe. It validates
the same persistent certificate and exact transition bundle used by the full Linux provider and then
falls through to Pi on a miss. Its producer policy accepts the matching observer epoch under either
Actor authority or the exact qualified confinement policy. Producer details remain outside semantic
process identity, so a certificate made while the full provider was installed remains useful when
only the store and hashing layer is available later. The private certificate directory is part of the
local trust boundary; imports require an authenticated producer, not edited self-describing fields.
