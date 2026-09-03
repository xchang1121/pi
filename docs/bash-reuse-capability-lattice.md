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
to perform an event. A completed second trace can confirm that two executions happened to use the
same resources, but that is too late to skip any of the second execution. An online reuse decision
instead validates the first execution's certificate before the second `execve`; tracing the second
process is needed only on a miss. Landlock, a correctly configured namespace sandbox, or another
confinement provider belongs only to Fork. Consequently, lack of Landlock must not disable Replay or
Actor-authorized execution, although observation alone does not create an interception boundary.

Mechanisms often grouped under "tracing" have materially different authority:

| Mechanism | Boundary | Can replace the second execution? | Qualification |
| --- | --- | --- | --- |
| completed or streamed `strace` log | syscall events after they have started | No | evidence, conflict detection, and measurement only |
| eager launch followed by kill | after Actor work may have escaped | No | unsafe performance ablation only |
| `PTRACE_O_TRACEEXEC` | successful `execve`, after image replacement but before its first user instruction | Yes, by terminating the stopped image through an exit stub | ptrace itself suppresses set-ID/file-capability transitions and changes observable tracing/signal behavior; it is valid only in an explicitly matched ptraced execution domain |
| seccomp user notification | syscall entry | Not by itself: a successful `execve` has no return continuation to spoof | a hit needs a cooperative stub or a separately safe process-rewrite mechanism; `CONTINUE` also has the kernel-documented TOCTOU race |
| `FAN_OPEN_EXEC_PERM` | executable open permission | No; it can allow or deny the open | permission groups require `CAP_SYS_ADMIN`, expose no general result-substitution operation, and fanotify has documented coverage/overflow gaps |
| eBPF/LSM hooks | kernel policy/audit hooks | No general user-space transaction substitution | privileged deployment and useful mainly as lower-overhead observation or denial |

Incr's streaming executor is the second case: it starts the real child while validating and kills it
on a hit. That overlaps lookup with useful work, but an emitted byte or external side effect cannot be
retracted. It is not an admissible strict Actor route. hS streams trace events for a different purpose:
it detects conflicts early while effects are already contained in an OverlayFS/namespace transaction.

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

Content equality is also not proof of `stat(2)` equality. Certificate v6 records the complete stat
structure actually returned by the traced syscall—device and inode identity, mode/ownership/link and
allocation fields, and nanosecond timestamps—and validates it with bigint precision in the Actor
world. `statx`, filesystem-capacity queries, directory-entry inode streams, deleted objects, and
anonymous descriptors remain fail-closed until equally complete evidence or virtualization exists.
This distinction is necessary for commands such as `stat -c %i`: a Git/FUSE private copy can have the
same bytes and still produce a different result.

## Completed and running conversion

"Turning speculation into the Actor environment" should mean transferring ownership of a sealed
result transaction, not transplanting a live process into the Actor namespace. There are three
distinct horizons: clean sealed results may enter persistent history; volatile sealed or still-running
results may be claimed once inside their exact authority scope; arbitrary instruction-level process
state requires a complete checkpoint of every causally connected process and kernel object. The first
two share one conversion protocol. The third is intentionally not a lightweight fallback.

For a completed result:

1. find candidates with a cheap semantic weak key;
2. validate each distinct dynamic pathset once against the Actor-visible state;
3. load and integrity-check the complete artifact closure before changing the workspace;
4. reserve the certificate for this Actor action;
5. compare every saved before-state again while transaction locks are held, apply the typed
   after-states, then return ordered output and exit status; and
6. roll back or fail the Actor call if commit cannot be completed exactly.

The generic Runtime exclusively owns top-level `running -> completed -> claimed` candidates, including
profitability deadlines. The Linux backend uses the same lifecycle only for nested child units that the
Runtime cannot identify across different parent Bash actions. Both lanes share validation and atomic
commit, but not the same authority lifetime. An exclusive top-level branch belongs to its Runtime
prediction horizon and may intentionally survive a model-turn boundary until that horizon settles; it
still has exactly one Actor claimant. A volatile nested child transfer is narrower and requires the same
session and turn. Thus one-shot clock/random/PID observations may become the exact predicted Actor
execution without entering persistent history. A direct process outlet never second-guesses a rejected
top-level candidate.

Semantic admission and wait admission are independent. A running child is first matched by exact
process identity and authority scope. The shared scheduler then compares learned Actor service time
against an upper estimate of speculative work remaining plus measured adoption cost. The native exec
boundary reports the duration of Actor children that were allowed to continue; Linux therefore learns
from a miss without placing an uncalibrated wait on the Actor critical path. A timeout simply resumes
the Actor child. Once the producer seals, both a joined result and an already-completed result traverse
the same dependency validation, artifact-closure verification, and atomic effect commit.

Different parent Bash commands cannot join their already-running shell states. They can reuse at the
next child `execve`: an Actor-side broker pauses the child before its first user instruction, validates
an earlier child certificate, and either replays it through a close-on-exec-compatible exit stub or
lets the Actor-authorized miss continue exactly once. Observation of that miss is an independent
capability. This requires an active executor, not two
`strace` logs compared afterward. A ptrace implementation must key certificates by the ptraced process
semantics and bypass the route when those semantics are not acceptable; a seccomp-only implementation
cannot synthesize the non-returning success semantics of `execve`.

The implemented x86-64 broker uses `PTRACE_SEIZE` with exec/fork tracing and `PTRACE_LISTEN` for group
stops. On a hit it first loads a verified result closure, duplicates the stopped child's exact output
descriptors, and installs an `exit_group(125)` image without releasing it. Only after the workspace
transaction commits does an authenticated acknowledgement change that stub to the recorded exit code
and release buffered output. Failure before arming continues the original child; failure after arming
never runs it a second time. Completed and still-running producers enter this same conversion path.

Mounting wrapper files over every `PATH` directory is adequate inside a disposable speculative world,
but not a transparent Actor interceptor: shell builtins can observe the substituted inode, link and
directory metadata. Source rewriting and `DEBUG` traps likewise change Bash semantics and cannot cover
every dynamic exec. The Actor tier therefore keeps the native shell filesystem and stops real exec
events; an unavailable native broker removes this tier rather than silently selecting a weaker hook.

## Minimum dependency combinations

These are cumulative capability combinations, not user-facing levels:

| Available mechanisms | Safe useful behavior | Deliberately unavailable |
| --- | --- | --- |
| Certificate store + exact hashing/CAS | Replay compatible completed certificates before shell launch; the Pi host executor remains the miss path | New process execution before Actor authorization |
| Above + `strace -f` | Audit an Actor-authorized execution and measure observation cost | No online child substitution; strict Bash certificates are commonly tainted by shell startup inputs |
| Above + native held-`execve` broker | Reuse completed child units across different Actor Bash strings; misses continue exactly once | Miss execution before Actor authorization; learning additionally needs complete observation |
| Above + exact workspace transaction | Learn and atomically replay typed Actor-authorized workspace effects | Unmodeled effects; early misses |
| Above + qualified confinement and output gating | Execute cache misses ahead of the Actor, then adopt their transactions | Any operation not covered by the confinement proof |
| Above + copy-on-write/journal acceleration | Reduce capture and materialization cost without changing correctness | No additional authority is inferred from faster storage |

The confinement slot is capability-based. Sandlock/Landlock is one provider; a qualified Bubblewrap,
nsjail, container, or future platform driver can satisfy the same contract. Bubblewrap explicitly
describes itself as a low-level toolkit, so binary presence alone is never qualification: the concrete
policy must prove process-tree containment, write confinement, network/IPC denial, nondeterminism
handling, and cleanup.

Actor-visible process identity must be preserved. The current Linux provider therefore uses no user,
PID, or mount namespace: Sandlock maps the private workspace at the syscall boundary and redirects only
proved executable launches. Ordinary opens, metadata queries, directory reads, writes, cwd, UID/GID,
and process identity remain native; a mismatch fails qualification before reuse is considered.

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
| [hS](https://atlas.cs.brown.edu/pdf/hs:osdi:2026.pdf) / [code](https://github.com/binpash/hs) | Sequential commit, streaming conflict restart, layered OverlayFS state, shell-state transfer and a speculation-window ablation | Its implementation needs `strace`, OverlayFS/`try`, mergerfs, namespaces and privileged cgroup/setup access; it reports 217 ms fixed command overhead and excludes mmap I/O, several aliases/resources, time-sensitive scripts and opacity |
| [ProcessCache dissertation](https://repository.upenn.edu/bitstreams/94d981be-86c5-40e9-8d8a-2d4e625c5b9e/download) | `execve` units, ptrace event filtering, pre/postcondition state machines, close-on-exec-compatible skip stubs and result replay | Its prototype does not fully handle stdin, cross-unit pipes or networking; subtree condition composition remains unfinished |
| [Speculator](https://www.microsoft.com/en-us/research/publication/speculative-execution-in-a-distributed-file-system-2/) | Kernel-level causal propagation through processes, files and IPC plus delayed external output | Shows that arbitrary live-state conversion requires kernel-object tracking and rollback, not two matching syscall logs |
| [Scribe](https://www.cs.columbia.edu/~orenl/papers/sigmetrics2010_scribe.pdf) | Consistent process/filesystem checkpoints, syscall rendezvous, shared-memory/signal sync points, and replay that can go live | Replaying only syscall return values is insufficient; in-kernel effects and every causally connected thread/process must cross the boundary |
| [R2](https://www.usenix.org/legacy/events/osdi08/tech/full_papers/guo/guo_html/index.html) | Select a typed high-level record/replay interface and generate side-effect/order handling from annotations | Its 1,300-function Win32 model shows the cost of replacing complete OS semantics with per-API special cases |
| [`try`](https://github.com/binpash/try) | Stackable user/mount-namespace OverlayFS effects and inspection/apply workflow | Explicitly a semisolate, not a security sandbox |
| [TREC](https://www.usenix.org/legacy/publications/library/proceedings/usenix98/full_papers/vahdat/vahdat.pdf) | Transparent result caching from process lineage and syscall dependencies | Predates current namespace, async-I/O and adversarial surfaces |
| [shournal](https://github.com/tycho-kirchner/shournal) / [paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC10901821/) | Low-overhead shell provenance and practical file tracking | Provenance and partial hashes are not complete replay certificates |
| [seccomp user notification](https://docs.kernel.org/userspace-api/seccomp_filter.html) | A future pre-syscall broker can mediate selected operations | vDSO and incomplete syscall policies require explicit treatment |
| [fanotify](https://man7.org/linux/man-pages/man7/fanotify.7.html) | Filesystem notification/permission events can reduce observation cost | Documented event and queue gaps prevent using it alone as completeness proof |
| [CRIU](https://criu.org/Checkpoint/Restore) / [DMTCP](https://arxiv.org/abs/cs/0701037) | Possible checkpoints for very long, fully contained executions; DMTCP virtualizes many user-space resource identities | Files, pipes, sockets, terminals, timers, shared memory and external endpoints must all be recreated or explicitly brokered, so this remains an optional high-dependency profile |

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

The Trace row is also a yield ablation. A real `/bin/bash -c` startup calls `getrandom` and observes
process identity even for trivial commands. Bare strace observes but does not control these inputs, so
strict top-level publication normally yields no reusable certificate. This negative result must remain
visible: deleting those taints would manufacture hits rather than prove equivalence. The useful
no-Landlock tier instead consumes already-sealed certificates at the native exec boundary. It does not
claim that a continued Actor miss was observed, so it learns no new certificate without a separate
complete observer.

The admission ablation sweeps concurrent speculation width rather than selecting a fixed threshold.
It compares expected Actor service time against speculative remaining time plus measured validation
and commit cost. This follows [LATE](https://www.usenix.org/legacy/event/osdi08/tech/full_papers/zaharia/zaharia_html/)
and hS: more speculation can expose parallelism, but wasted work and isolation overhead eventually
dominate.

## Refactoring order

1. Split world routing by operation so Observe has independent requirements from Fork.
2. Split certificate semantic identity from producer guarantees and migrate the store epoch.
3. Expose hit-only completed replay before any process fork; it must work without `strace` or Landlock.
4. Qualify a native Actor exec broker without filesystem substitution: hits replay and misses execute
   exactly once. Make observation an independent add-on so a hit-only broker does not pretend that a
   continued miss produced a certificate.
5. Add Actor-authorized effect capture through the existing generic workspace transaction, without
   claiming speculative authority.
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

Current implementation status matters: whole-command Actor replay, nested replay inside a qualified
Fork, and x86-64 cross-parent child replay in the real Actor process are implemented. The Actor provider
holds native exec events and never substitutes PATH entries; PATH interposition remains confined to the
disposable Fork. Its hit path needs neither Landlock nor `strace`, but it consumes only previously sealed
compatible certificates. Other architectures retain whole-command replay until their register/exit-stub
transition is separately qualified.
