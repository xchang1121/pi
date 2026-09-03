# Bash 复用能力阶梯

本文将进程复用领域的研究成果整理成一套实现与消融实验契约。目标不只是“缓存命中”：
被接管的执行必须与 Actor 从其可见初始状态完整执行一次命令保持观测等价。缺少可选的
Linux 设施时，只应移除依赖这些设施的操作，而不应禁用所有形式的进程复用。

## 一个不变量，四种操作

实现应通过通用工具执行网关暴露四种操作。它们共享证书与事务，但拥有不同的授权能力：

| 操作 | 可以做什么 | 最低证据要求 | 未命中意味着什么 |
| --- | --- | --- | --- |
| Predict（预测） | 在不启动进程的情况下生成动作身份 | 工具 schema 与执行身份 | 继续预测 |
| Replay（重放） | 验证并物化一份已完成的证书 | 语义身份、当前依赖证明、不可变结果闭包、可接受的生产者保证 | 不执行，直接回退 |
| Observe（观测） | 跟踪由 Actor 授权的执行并发布证书 | 完整的进程树观测与精确的工作区事务 | 正常运行 Actor 命令；发布可以失败时拒绝（fail closed） |
| Fork（提前执行） | 在 Actor 授权前执行 | Observe 的全部要求，再加完整隔离与受控的副作用/输出 | 隔离不可用时不得执行 |

`strace` 属于 Observe 和 Fork。它只能在事件发生后提供证据，不能授予执行事件的权限。
对第二次执行完成后的跟踪可以确认两次执行碰巧使用了相同资源，但这时已经来不及跳过第二次
执行。在线复用必须在第二个 `execve` 之前验证第一次执行的证书；只有未命中时才需要跟踪
第二个进程。Landlock、正确配置的 namespace 沙箱或其他隔离提供者只属于 Fork。因此，
缺少 Landlock 不应禁用 Replay 或由 Actor 授权的执行，但单纯观测也不能形成拦截边界。

通常被统称为“跟踪”的机制，实际拥有显著不同的能力边界：

| 机制 | 拦截边界 | 能否替代第二次执行 | 适用条件 |
| --- | --- | --- | --- |
| 已完成或流式的 `strace` 日志 | syscall 事件开始之后 | 否 | 只能用于证据、冲突检测与测量 |
| 提前启动后再终止 | Actor 工作可能已经逸出之后 | 否 | 只能作为不安全的性能消融项 |
| `PTRACE_O_TRACEEXEC` | `execve` 成功、进程映像已替换但尚未执行第一条用户态指令时 | 可以，通过退出桩终止已暂停的映像 | ptrace 本身会抑制 set-ID/文件 capability 转换，并改变可观测的跟踪与信号语义；仅能用于明确匹配的 ptrace 执行域 |
| seccomp user notification | syscall 入口 | 单独使用不行：成功的 `execve` 没有可伪造的返回续点 | 命中需要协作式桩或另一种安全的进程重写机制；`CONTINUE` 还存在内核文档说明的 TOCTOU 竞态 |
| `FAN_OPEN_EXEC_PERM` | 可执行文件打开权限检查 | 否；只能允许或拒绝打开 | permission group 需要 `CAP_SYS_ADMIN`，没有通用的结果替换操作，并且 fanotify 存在已知覆盖缺口与队列溢出问题 |
| eBPF/LSM hook | 内核策略/审计 hook | 没有通用的用户态事务替换能力 | 需要特权部署，主要适合低开销观测或拒绝 |

Incr 的流式执行器属于第二种情况：它在验证时先启动真实子进程，命中后再将其终止。这可以让
查询与有效工作重叠，但已经输出的字节或外部副作用无法撤回，因此不能作为严格 Actor 路由。
hS 也会流式处理跟踪事件，但目的不同：副作用已被 OverlayFS/namespace 事务隔离，它据此
尽早检测冲突。

执行阶段本身必须参与路由选择。若对权威捕获和投机执行公布同一组不加区分的 capability，
就会错误地把 Fork 的强依赖变成较弱且已获授权的 Observe 操作的前置条件。

## 复用单元与证书

任意 syscall 前缀不是可复用的语义单元。前缀相同不能证明后续行为相同；如果没有共同捕获
进程 checkpoint，第二个进程也无法跳入第一个进程的内存、描述符和 shell 状态。因此，
可移植的复用单元只有：

1. 一次完整的、由进程承载的顶层工具调用；
2. 在 Actor 启动子进程之前拦截到的一棵完整 `execve` 子树；或
3. 一个显式封存、且完整解释器状态已建模的 shell/事务 checkpoint。

第二种单元允许不同的父 Bash 字符串共享昂贵的子进程。除非 shell-aware 前端建立了显式
checkpoint，否则 shell builtin、函数、赋值、重定向和控制流仍属于父 shell。

一份证书包含四个相互正交的部分：

```text
语义身份        可执行文件摘要、argv、cwd、环境、stdin/FD、
                凭据、资源限制、信号、平台语义
动态依赖        文件内容与元数据、目录、负查询、符号链接解析，
                以及所有其他被准入的输入
结果事务        有序的 stdout/stderr/退出状态，以及精确的工作区 before -> after 转换
生产者保证      观测、隔离、跟踪完整性与输出控制是如何建立的
```

语义身份不得包含某一种特定沙箱产品；反过来，生产者保证也不得被丢弃。当证书的语义身份与
当前依赖匹配，而且其证明覆盖所请求的操作时，消费者才接受它。例如，这允许在后续 Landlock
Fork 中重放一份由 Actor 观测生成的证书，而不需要假装两种生产者使用了同一套策略。

除非 runtime 能证明程序实际读取了哪些环境变量，否则环境变量都作为保守输入。只有在持续、
无缺口的 journal lease 中，文件元数据才可作为摘要快捷方式；不可信的 `mtime` 相同并不是
内容证明。网络、IPC、设备、交互式终端、未建模的 `ioctl`、跟踪丢失、逸出子进程和非确定性
输入都会污染证书，使其不得发布，除非某个提供者能完整地拒绝、虚拟化或捕获它们。

内容相同也不能证明 `stat(2)` 结果相同。证书 v6 会记录被跟踪 syscall 实际返回的完整 stat
结构——设备与 inode 身份、mode/owner/link/分配字段以及纳秒时间戳——并在 Actor 执行世界中
用 bigint 精度验证。`statx`、文件系统容量查询、带 inode 的目录项流、已删除对象和匿名描述符，
在有同等完整的证据或虚拟化之前都必须失败时拒绝。这一区分对 `stat -c %i` 等命令是必要的：
Git/FUSE 私有副本即使字节完全相同，也可能产生不同结果。

## 已完成结果与运行中结果的转换

“把投机执行转换进 Actor 环境”应当指转移已封存结果事务的所有权，而不是把活进程移植进
Actor namespace。这里有三种不同的有效期：干净的封存结果可以进入持久历史；易变的封存结果
或运行中结果只能在其精确授权范围内被认领一次；任意指令级进程状态则要求完整 checkpoint
所有存在因果联系的进程和内核对象。前两种共用同一套转换协议，第三种刻意不作为轻量回退。

对一份已完成结果：

1. 用廉价的语义弱键寻找候选；
2. 根据 Actor 可见状态，对每组不同的动态路径集只验证一次；
3. 在改变工作区之前，加载完整产物闭包并完成完整性检查；
4. 为当前 Actor 动作预留该证书；
5. 持有事务锁时再次比较所有保存的 before-state，应用带类型的 after-state，然后返回有序输出和退出状态；
6. 如果无法精确完成提交，则回滚或让 Actor 调用失败。

通用 Runtime 独占管理顶层 `running -> completed -> claimed` 候选及其收益截止时间。Linux
后端只对 Runtime 无法跨不同父 Bash 动作识别的嵌套子进程单元使用同一生命周期。两条通道
共享验证和原子提交，但不共享授权有效期。独占的顶层分支属于其 Runtime 预测周期，可以有意
跨越模型轮次边界存活到该周期结束，但仍然只有一个 Actor 可以认领它。易变的嵌套子进程转移
范围更窄，要求同一 session、同一轮次。因此，一次性的时钟/随机数/PID 观测可以成为 Actor
所预测执行的精确结果，但不能进入持久历史。直接进程出口绝不会绕过 Runtime 的决定，重新
考虑一个已被拒绝的顶层候选。

语义准入与等待准入彼此独立。运行中的子进程先按精确进程身份和授权范围匹配；共享调度器再将
学到的 Actor 服务时间，与“投机剩余工作上界 + 实测接管成本”比较。原生 exec 边界会上报
获准继续执行的 Actor 子进程耗时，因此 Linux 可以从一次未命中中学习，而不必在 Actor 关键
路径上增加未经校准的等待。超时只会恢复 Actor 子进程。生产者封存完成后，无论是等待加入的
结果还是此前已经完成的结果，都会经过同一套依赖验证、产物闭包校验和原子副作用提交。

不同父 Bash 命令无法加入彼此已经运行的 shell 状态，但可以在下一个子进程 `execve` 处复用：
Actor 侧代理在子进程执行第一条用户态指令之前暂停它，验证早先的子进程证书，然后通过一个
兼容 close-on-exec 的退出桩重放结果，或者让 Actor 授权的未命中恰好继续执行一次。观测这次
未命中是独立的 capability。这里需要主动执行器，而不是事后比较两份 `strace` 日志。ptrace
实现必须按 ptrace 后的进程语义为证书建立键；这些语义不可接受时必须绕过该路由。仅有 seccomp
的实现无法合成 `execve` 成功后不返回的语义。

当前 x86-64 代理使用 `PTRACE_SEIZE` 配合 exec/fork 跟踪，并用 `PTRACE_LISTEN` 处理进程组
停止。命中时，它先加载并验证结果闭包，复制暂停子进程的精确输出描述符，再安装一个不会立即
释放的 `exit_group(125)` 映像。只有工作区事务提交后，经过认证的确认消息才会把该退出桩改为
记录的退出码并释放缓冲输出。启用退出桩之前发生故障会继续原始进程；启用之后发生故障也绝不
会把它再次执行。已完成和仍在运行的生产者都进入同一条转换路径。

在一次性投机执行世界中，把 wrapper 文件挂载到每一个 `PATH` 目录之上是可行的，但它不是
透明的 Actor 拦截器：shell builtin 可以观察到被替换文件的 inode、link 和目录元数据。
源码重写与 `DEBUG` trap 同样会改变 Bash 语义，而且无法覆盖每一种动态 exec。Actor 层因此
保留原生 shell 文件系统并拦停真实 exec 事件；原生代理不可用时应移除这一层，而不是悄悄选择
更弱的 hook。

## 最低依赖组合

下面是逐项累积的 capability 组合，不是面向用户的等级：

| 可用机制 | 安全且有用的行为 | 明确不可用的能力 |
| --- | --- | --- |
| 证书存储 + 精确哈希/CAS | 在 shell 启动前重放兼容的已完成证书；未命中时仍使用 Pi 主机执行器 | Actor 授权前启动新进程 |
| 上述能力 + `strace -f` | 审计 Actor 授权的执行并测量观测成本 | 无法在线替换子进程；严格 Bash 证书通常会被 shell 启动输入污染 |
| 上述能力 + 原生 held-`execve` 代理 | 在不同 Actor Bash 字符串之间复用已完成的子进程单元；未命中恰好继续一次 | Actor 授权前执行未命中；学习还需要完整观测 |
| 上述能力 + 精确工作区事务 | 学习并原子重放由 Actor 授权的、带类型的工作区副作用 | 未建模副作用；提前执行未命中 |
| 上述能力 + 合格的隔离与输出控制 | 在 Actor 之前执行缓存未命中，然后接管其事务 | 隔离证明没有覆盖的任何操作 |
| 上述能力 + 写时复制/journal 加速 | 在不改变正确性的前提下降低捕获和物化成本 | 不会因为存储更快而推导出额外授权能力 |

隔离插槽按 capability 而不是产品名称定义。Sandlock/Landlock 是一种提供者；通过资格验证的
Bubblewrap、nsjail、容器或未来平台驱动都可以满足同一契约。Bubblewrap 明确称自己是底层
工具集，因此仅检测到二进制绝不代表资格验证通过：具体策略必须证明进程树隔离、写入限制、
网络/IPC 拒绝、非确定性处理和清理都完整有效。

Actor 可见的进程身份必须保持不变。因此，当前 Linux 提供者不使用 user、PID 或 mount
namespace：Sandlock 在 syscall 边界映射私有工作区，并且只重定向已经证明的可执行文件启动。
普通的 open、元数据查询、目录读取、写入、cwd、UID/GID 和进程身份都保持原生语义；只要不
匹配，就会在考虑复用之前判定资格验证失败。

当语义/平台指纹匹配时，Windows 可以直接参与证书重放。原生 Observe/Fork 提供者需要达到
BuildXL 级别的进程传播与文件系统/注册表覆盖；原始 Detours hook 或文件系统 watcher 并不
等价。WSL 是一种 Linux 提供者，其工作区挂载和可执行文件/平台身份仍与原生 Windows 不同。

## 现有系统提供的证据

| 系统 | 值得保留的机制 | 对本项目的边界 |
| --- | --- | --- |
| [BuildXL 两阶段查询](https://github.com/microsoft/BuildXL/blob/main/Documentation/Wiki/Advanced-Features/Two-Phase-Cache-Lookup.md) | 弱指纹 -> 历史动态路径集 -> 强指纹；路径集扩充 | 构建动作的声明性强于任意 shell 进程 |
| [Rattle](https://github.com/ndmitchell/rattle) / [形式化模型](https://arxiv.org/abs/2202.05328) | 前向执行、动态 hazard、投机执行、观测等价目标 | hazard 能检测依赖错误，但本身不是隔离证明 |
| [Riker](https://www.usenix.org/system/files/atc22-curtsinger.pdf) | 进程级增量复用与 POSIX namespace 依赖 | 其跟踪假设必须针对 Pi 的威胁模型重新验证 |
| [LaForge](https://arxiv.org/abs/2108.12469) | 从 syscall 推导依赖并增量复用命令 | 构建工作负载不能覆盖 Bash 的每一种交互式或外部副作用 |
| [Buck2 dep files](https://buck2.build/docs/rule_authors/dep_files/) | 以前的动态输入集合可缩小后续验证范围 | 过去的路径集只是候选选择器，不能证明不会出现新依赖 |
| [Bazel 远程缓存](https://bazel.build/remote/caching) | 分离动作结果与内容寻址产物 | 声明为 hermetic 的动作比通用 Bash 更容易确定身份 |
| [Build without Bytes](https://blog.bazel.build/2023/10/06/bwob-in-bazel-7.html) | 惰性输出物化可能主导缓存经济性 | 需要文件系统支持的 fault/物化边界 |
| [Incr](https://github.com/atlas-brown/incr) / [OSDI 论文](https://yizhengx.github.io/p/incr:osdi:2026.pdf) | 未修改 Bash、命令级缓存、`strace`、OverlayFS、流式执行、内省与压缩；在其工作负载中报告平均 34.2x | 仅按 `mtime` 验证读取、与发行版绑定的环境过滤，以及命中后终止已经提前启动的子进程，都不足以构成严格投机证明 |
| [hS](https://atlas.cs.brown.edu/pdf/hs:osdi:2026.pdf) / [代码](https://github.com/binpash/hs) | 顺序提交、流式冲突重启、分层 OverlayFS 状态、shell 状态转移与投机窗口消融 | 其实现依赖 `strace`、OverlayFS/`try`、mergerfs、namespace 和有特权的 cgroup/setup；报告每条命令固定开销 217 ms，并排除 mmap I/O、多种 alias/资源、时间敏感脚本与不透明操作 |
| [ProcessCache 论文](https://repository.upenn.edu/bitstreams/94d981be-86c5-40e9-8d8a-2d4e625c5b9e/download) | `execve` 单元、ptrace 事件过滤、前/后置条件状态机、兼容 close-on-exec 的跳过桩与结果重放 | 其原型没有完整处理 stdin、跨单元 pipe 或网络；子树条件合成仍未完成 |
| [Speculator](https://www.microsoft.com/en-us/research/publication/speculative-execution-in-a-distributed-file-system-2/) | 通过进程、文件和 IPC 在内核层传播因果关系，并延迟外部输出 | 说明任意活状态转换需要内核对象跟踪与回滚，而不是两份相同的 syscall 日志 |
| [Scribe](https://www.cs.columbia.edu/~orenl/papers/sigmetrics2010_scribe.pdf) | 一致的进程/文件系统 checkpoint、syscall rendezvous、共享内存/信号同步点，以及可以转入实时状态的重放 | 只重放 syscall 返回值并不充分；内核内副作用和所有存在因果联系的线程/进程都必须跨越边界 |
| [R2](https://www.usenix.org/legacy/events/osdi08/tech/full_papers/guo/guo_html/index.html) | 选择带类型的高层 record/replay 接口，并从 annotation 生成副作用/顺序处理 | 其包含 1,300 个函数的 Win32 模型表明：用逐 API 特判替代完整 OS 语义代价高昂 |
| [`try`](https://github.com/binpash/try) | 可叠加的 user/mount-namespace OverlayFS 副作用，以及检查/应用工作流 | 明确属于半隔离（semisolate），不是安全沙箱 |
| [TREC](https://www.usenix.org/legacy/publications/library/proceedings/usenix98/full_papers/vahdat/vahdat.pdf) | 从进程谱系和 syscall 依赖进行透明结果缓存 | 早于当前 namespace、异步 I/O 和对抗性攻击面 |
| [shournal](https://github.com/tycho-kirchner/shournal) / [论文](https://pmc.ncbi.nlm.nih.gov/articles/PMC10901821/) | 低开销 shell provenance 和实用文件跟踪 | provenance 与部分哈希并不是完整重放证书 |
| [seccomp user notification](https://docs.kernel.org/userspace-api/seccomp_filter.html) | 未来的 pre-syscall 代理可以介入选定操作 | vDSO 和不完整的 syscall 策略必须被显式处理 |
| [fanotify](https://man7.org/linux/man-pages/man7/fanotify.7.html) | 文件系统通知/权限事件可以降低观测成本 | 已知事件与队列缺口使其不能单独充当完整性证明 |
| [CRIU](https://criu.org/Checkpoint/Restore) / [DMTCP](https://arxiv.org/abs/cs/0701037) | 可为耗时很长且完全隔离的执行提供 checkpoint；DMTCP 可虚拟化多种用户态资源身份 | 文件、pipe、socket、终端、timer、共享内存和外部 endpoint 都必须重新创建或显式代理，因此它仍是可选的高依赖配置 |

[`bash-cache`](https://github.com/dimo414/bash-cache) 和
[`bkt`](https://github.com/dimo414/bkt) 等简单输出缓存适合作为反例：命令文本、参数和 TTL
可以很快，但不能证明动态输入或可重放副作用。

## 必需的依赖与性能消融

每个保留的提供者都必须在同一个 WSL 原生文件系统和原版 Pi Bash 出口上测量。每一行只改变
一个机制，命令、初始快照、迭代次数和机器保持不变：

| 实验 | 启用的机制 | 回答的问题 |
| --- | --- | --- |
| Direct（直接执行） | 无 | Actor 反事实基线 |
| Trace（跟踪） | 仅 Actor `strace` | 纯观测开销 |
| Publish（发布） | 跟踪 + 依赖/副作用封存 | 创建可复用证明的成本 |
| Whole hit（整体命中） | 重放已完成的顶层结果 | 整条命令的最佳节省 |
| Child hit（子进程命中） | 代理 + 在不同父命令字符串下重放已完成子进程 | 跨 Bash 部分复用的节省 |
| Child join（加入子进程） | 代理 + 相同的运行中子进程 | 未完成工作的价值与等待成本 |
| Fork miss（提前执行未命中） | 完整隔离 + 事务 | 冷投机执行开销 |
| Fork hit（提前执行命中） | 完整隔离 + 既有证书 | 提前执行与嵌套复用之间的交互 |
| Storage A/B（存储对照） | Git 对比通过资格验证的写时复制驱动 | 只测量捕获/物化的交叉点 |

工作负载需覆盖 no-op、100 ms、1 s 和 10 s CPU 任务；32/128 MiB 产物；小目录与包含
10,000 个条目的目录树；读密集型依赖；带类型的目录副作用；stdin 有界的 pipeline；以及共享
同一个子进程的不同父 Bash 程序。应报告中位数与尾延迟、setup、跟踪、验证、哈希、执行、
封存、产物加载、提交、读写字节数、命中/加入/未命中/污染次数、避免的进程时间、关键路径节省、
CPU 时间和峰值内存。冷缓存与热缓存结果必须分开。

正确性 gate 会有意改变文件内容但保持无用的时间戳不变，并改变目录项、负查询、符号链接目标、
环境、stdin、可执行文件字节和平台指纹。它还会覆盖跟踪截断、子进程被终止、并发工作区修改、
网络/IPC 尝试、交互式描述符、不支持的 ioctl、产物损坏、代理丢失、超时和提交回滚。除非输出、
退出状态和最终工作区都与 Actor 直接执行相同，而且每种不安全情况都失败时拒绝，否则性能结果
一律作废。

Trace 行同时也是可复用产出消融。真实的 `/bin/bash -c` 即使执行平凡命令，启动时也会调用
`getrandom` 并观察进程身份。裸 `strace` 只能观测而不能控制这些输入，因此严格的顶层发布
通常不会生成可复用证书。这个负结果必须保留可见：删除这些污染标记是在制造命中，而不是证明
等价。不依赖 Landlock 的有用层级，是在原生 exec 边界消费已经封存的证书。它不会声称某次
继续执行的 Actor 未命中已被观测，因此如果没有独立、完整的观测器，就不会学习新证书。

准入消融会扫描并发投机宽度，而不是选择固定阈值。它将预期 Actor 服务时间，与投机剩余时间、
实测验证成本和提交成本之和比较。这遵循 [LATE](https://www.usenix.org/legacy/event/osdi08/tech/full_papers/zaharia/zaharia_html/)
与 hS 的结论：增加投机可以暴露并行性，但浪费的工作和隔离开销最终会占据主导。

## 重构顺序

1. 按操作拆分执行世界路由，使 Observe 的依赖要求与 Fork 相互独立。
2. 将证书的语义身份与生产者保证分离，并迁移存储 epoch。
3. 在启动任何进程之前暴露仅命中的已完成结果重放；它必须在没有 `strace` 或 Landlock 时工作。
4. 在不替换文件系统的前提下验证原生 Actor exec 代理：命中时重放，未命中时恰好执行一次。
   将观测作为独立附加能力，使仅命中的代理不会假装一次继续执行的未命中生成了证书。
5. 通过现有的通用工作区事务捕获由 Actor 授权的副作用，但不宣称拥有投机执行权限。
6. 允许其他 Fork 提供者通过同一资格验证契约接入。
7. 实现上述消融项，并在 TUI 中只暴露根据成功探测推导出的直白能力描述。

每一步都可独立测试，并且必须让不受支持的操作保持不可用。任何步骤都不得添加命令名称白名单，
也不得根据 Bash 文本相似度宣称安全。

仅命中路径挂接在 Pi 的进程出口，而不是投机执行世界的探测器上。它验证完整 Linux 提供者所用的
同一份持久证书和精确转换 bundle，未命中时再回退到 Pi。其生产者策略接受对应 observer epoch
中由 Actor 授权或精确合格隔离策略生成的证书。生产者细节仍位于语义进程身份之外，所以安装完整
提供者时生成的证书，在以后只剩存储与哈希层时仍然可用。私有证书目录属于本地信任边界；导入时
需要经过认证的生产者，不能相信经过编辑的自描述字段。

当前实现状态必须明确：真实 Actor 进程中的整条命令 Actor 重放、合格 Fork 内部的嵌套重放，
以及 x86-64 跨父 Bash 子进程重放都已经实现。Actor 提供者会暂停原生 exec 事件，绝不替换
`PATH` 条目；`PATH` 插桩仍只存在于一次性 Fork 中。它的命中路径既不需要 Landlock，也不需要
`strace`，但只能消费此前已封存且兼容的证书。在其他架构各自完成 register/退出桩转换的资格
验证之前，它们仍只支持整条命令重放。
