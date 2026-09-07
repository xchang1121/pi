# Bash 复用的依赖降级设计

## 目的

本文回答的不是“沙箱是否可用”这一道二元问题，而是：当某项 Linux 依赖缺失时，哪些 Bash
复用操作仍然有充分证明，可以继续启用；哪些操作必须降级为 Actor 正常执行。

必须区分三件经常被混为一谈的事：

- **消费已有结果**：验证一份已经封存的证书，并把结果事务接管给 Actor。
- **生产新证书**：观测一次已获 Actor 授权的执行，封存其依赖、输出和工作区副作用。
- **提前执行未命中**：在 Actor 尚未授权时启动 Bash；这一步额外需要完整隔离与输出控制。

缺少某项依赖时，只删除依赖它的操作。所有路由仍共享同一套证书验证和原子提交协议，不通过
命令名称、Bash 文本相似度或逐工具特判补回能力。

## 先给结论：没有 Landlock 时现在能做什么

当前实现中，缺少 Landlock（更准确地说，Sandlock 的 Landlock/seccomp 资格探测失败）时，
Bash 会进入**只消费、不生产**的安全降级层：

| 当时具备的条件 | 当前能够安全完成 | 当前不能完成 |
| --- | --- | --- |
| 存储中已有兼容的整条 Bash 证书 | 在启动 shell 前验证依赖并重放输出、退出状态和工作区事务 | 不能从一次新未命中中学习证书 |
| 上述条件 + x86-64 Linux 原生 held-`execve` 代理可用 | 在真实 Actor 子进程执行第一条用户态指令前暂停它；可跨不同父 Bash 重放相同子进程证书 | 不能凭空产生可供重放的子进程证书 |
| 没有兼容证书 | 查询未命中后让 Actor 命令恰好执行一次；正确性不受影响 | 没有加速收益 |
| 有 `strace`，但没有 Landlock | 仍可消费已有证书 | 当前尚不能独立观测 Actor 未命中并发布新证书 |
| FUSE OverlayFS 不可用，但 Landlock、`strace`、Git 等完整生产依赖可用 | 改用 Git 工作区事务，保留完整安全能力 | 只失去特定目录规模下的性能优化 |

因此，已有的 **8.14x** 无 Landlock/无 `strace` 命中结果证明的是“消费路径不依赖生产者设施”，
不是“一台空存储、从未具备 Landlock 的机器可以自行预热”。在空存储机器上，当前行为是安全
回退到 Actor，实际加速为零。

运行中子进程接管也不改变这个结论：它可以消费一个已经由合格生产者启动的候选，但一台从启动
起就没有 Landlock 的机器不会拥有这样的 Bash 投机生产者，因此通常没有运行中候选可加入。

## 每项依赖实际负责什么

这些依赖不是一个必须整体满足的“沙箱等级”，而是分别支持不同操作：

| 依赖或机制 | 唯一职责 | 缺失后的正确降级 |
| --- | --- | --- |
| 证书存储、内容哈希与 CAS | 保存、校验依赖证据和不可变产物闭包 | 无法复用历史结果；直接执行 Actor |
| 精确工作区事务 | 校验 before-state，并原子应用 after-state | 有文件副作用的证书不得接管 |
| 原生 held-`execve` 代理（当前仅 x86-64 Linux） | 在真实子进程尚未执行用户代码时形成替换边界 | 失去跨父 Bash 子进程命中/加入；整条命令重放仍可保留 |
| `strace -f` | 完整观测一次已经发生的进程树，生成动态依赖证据 | 不能生产新的严格进程证书；已有证书仍可消费 |
| 合格的隔离与输出控制（当前为 Sandlock：Landlock + seccomp） | 授权在 Actor 之前执行一次未命中，并阻止副作用逸出 | 不得冷启动 Bash 投机分支；Actor 执行和已有证书重放不受影响 |
| Git 工作区驱动 | 为当前完整生产路径提供精确的私有 before/after 事务 | 当前不能启动完整生产路径；已有证书消费仍可保留 |
| FUSE OverlayFS | 降低某些目录树的分支与物化成本 | 回退到 Git；证明权限完全不变 |

`strace` 只提供证据，不提供提前执行权限。Landlock 只提供隔离能力，也不会自动证明动态输入。
两者必须分别消融：把“没有 Landlock”和“没有 `strace`”都归为“没有沙箱”，会隐藏仍然可用
的消费路径，也会错误地把观测能力当成执行授权。

## 当前代码的实际降级矩阵

下表描述当前实现，而不是未来目标：

| 被移除的依赖 | 仍保留的 Bash 能力 | 被移除的 Bash 能力 | Actor 路径 |
| --- | --- | --- | --- |
| 无（完整 Linux 路径） | 整条命令重放、跨父 Bash 子进程重放、成本感知的运行中接管、冷投机生产 | 无 | 未命中时由隔离分支提前执行，匹配后接管 |
| Landlock/Sandlock | 已有整条命令证书重放；held-exec 可用时已有子进程证书重放 | 新证书生产、冷投机执行、从空存储自预热 | 查询/子进程未命中后正常执行一次 |
| `strace` | 与上一行相同的已有证书消费 | 新的动态依赖证明与证书生产；完整 Fork 路径 | 正常执行一次，但当前不发布证书 |
| held-exec helper、ptrace 权限或 x86-64 | 已有整条命令证书重放 | 跨父 Bash 子进程重放/加入；当前完整生产路径也因共用透明 exec 边界而不可用 | shell 原样运行 |
| Git | 已有证书消费 | 当前完整生产路径 | 正常执行一次 |
| FUSE OverlayFS | 全部安全能力，工作区驱动改用 Git | 仅丢失 COW 性能路线 | 不变 |
| 兼容证书 | 依赖探测和精确未命中 | 本次没有可复用工作 | 正常执行一次 |
| 原生 Windows | 其他工具仍按各自执行世界投机；可选择 WSL 运行 Linux Bash 路径 | 当前原生 Windows Bash 进程证书消费与生产均未实现 | 原生 Windows shell 正常执行 |

这里的“兼容证书”要求平台指纹、可执行文件、argv、cwd、环境、stdin/FD、当前动态依赖和
before-state 全部匹配，并且生产者保证可以被当前消费者接受。把证书文件复制到另一台“看起来
差不多”的机器并不自动形成命中。

## 为什么当前无 Landlock 只能消费，不能自预热

消费路径已经从完整 Linux 投机世界中拆出：

- [`completedReplayExecutor`](../src/linux-process-backend.ts) 只依赖存储、平台指纹、验证与提交，
  明确不解析 Sandlock 或 `strace` 二进制。
- [`heldExecActorReplay`](../src/linux-process-backend.ts) 独立打开原生 exec 边界；未命中会继续真实
  Actor 子进程，不需要 Fork 依赖。

但是，新证书生产仍由同一个 `open()`/`resolveReady()` 入口承载。该入口把 Sandlock、
`strace` 和透明 exec helper 一次性探测为完整生产者。因此现在即使 Landlock 缺失而 `strace`
存在，也没有单独的 Actor-authorized Observe 路由。这是当前剩余的结构性缺口。

目标结构只按授权阶段拆成四个部件：

| 部件 | 使用时机 | 允许依赖 |
| --- | --- | --- |
| Replay consumer | Actor 调用到达后，进程启动前 | 存储、哈希、事务提交 |
| Exec boundary | Actor 子进程到达 `execve` 时 | 原生 helper/ptrace |
| Actor observer | 已确定未命中，且 Actor 已授权执行时 | `strace`、精确工作区事务；不需要隔离权限 |
| Fork producer | Actor 授权前 | Actor observer 的全部依赖 + 合格隔离和输出控制 |

完成这项拆分后，无 Landlock 但有 `strace` 与精确事务的机器应当形成一个**可自预热、不可提前
执行**的层级：第一次由 Actor 正常执行并生成证书，后续调用可以重放；它仍绝不会在 Actor
授权前启动缓存未命中。这个目标不能在文档中冒充已经实现。

## 所有降级层共同遵守的等价性契约

无论完整还是降级路径，接管必须同时验证：

```text
语义身份        executable digest、argv、cwd、环境、stdin/FD、凭据、限制、信号、平台语义
动态依赖        文件内容与完整元数据、目录、负查询、符号链接解析及其他被准入输入
结果事务        有序 stdout/stderr/退出状态，以及精确工作区 before -> after 转换
生产者保证      观测完整性、执行授权、隔离与输出控制是如何建立的
消费者契约      当前接管路径能够接受哪些生产者保证和副作用类型
```

网络、IPC、设备、交互式描述符、未建模 `ioctl`、跟踪丢失、逸出子进程、时间/随机数/PID 等
输入必须由提供者完整拒绝、虚拟化或捕获，否则证书只能在其严格的一次性范围内使用，或者直接
失败时拒绝。依赖减少绝不意味着验证条件变宽。

## 路由顺序

每次 Actor Bash 调用按以下顺序降级：

1. 若消费路径可用，先查询并验证整条命令证书；命中则原子接管。
2. 若原生 exec 边界可用，真实 shell 到达子进程 `execve` 时查询子进程证书；命中则接管，
   未命中则让该子进程恰好继续一次。
3. 若 Actor observer 可用，观测这个已获授权的未命中并尝试封存；观测不完整只影响发布，
   不影响 Actor 已经合法执行的结果。当前实现尚缺这一独立路线。
4. 只有 Fork producer 资格验证通过时，才允许在 Actor 到达前执行未命中。
5. 任一层不可用或验证失败，都继续向下一层降级，最终落到 Pi 的原始 Actor 执行出口。

## 依赖消融要求

消融必须分别移除单项依赖，并区分“空存储”和“预置兼容证书”：

| 消融项 | 初始条件 | 应验证的结果 |
| --- | --- | --- |
| 完整路径 | 空存储 | 可安全产生证书；后续整体/子进程命中 |
| 去掉 FUSE | 空存储 | Git 路径保持正确性，仅性能变化 |
| 去掉 Landlock，保留已有证书 | 预置兼容证书 | 整体命中和 held-exec 子进程命中仍成立 |
| 去掉 Landlock | 空存储 | 当前直接执行且不产生证书；未来 Actor observer 拆分后应能自预热 |
| 去掉 `strace`，保留已有证书 | 预置兼容证书 | 仍可消费，但不能发布新证书 |
| 去掉 held-exec helper | 预置整条命令证书 | 整体重放仍成立；子进程复用消失 |
| 去掉 Git/FUSE，保留已有证书 | 预置无副作用或可直接提交的证书 | 消费路径不得意外依赖分支创建工具 |
| 改变任一动态输入 | 预置证书 | 必须未命中并只执行一次 Actor 命令 |

每行都必须比较输出、退出状态、最终工作区、进程执行次数，并分别报告查询、验证、等待、执行、
封存、接管耗时以及命中/未命中/污染计数。只有预置证书的行可以声称“无 Landlock 命中”；
不得把生产阶段的完整依赖藏在测量之外。

实测结果维护在
[`wsl2-capability-ablation-c0d4c96-2026-09-03.md`](../bench/results/wsl2-capability-ablation-c0d4c96-2026-09-03.md)，
研究依据和更完整的论文比较见 [`bash-reuse-research.md`](./bash-reuse-research.md)。

## 跨平台重构计划（2026-09-07，以下为目标而非已实现能力）

基线为 `65c8bfe`：Windows 506 passed / 16 skipped，生产源码 33,096 行、测试 15,330 行。
本轮不得用“统一进程化”换取 Windows 能力退化，也不恢复未经证明的 host-function 提前执行。
目标是在这一基线上净精简；之前的 30,411 行绝对预算仍未达到，不重定义为已经完成。

追加边界：从 `ee97f0d` 起保留 PR #1 的思程实现，不改 SDK、控制协议、profile 安装和持久化
恢复逻辑。下面第一步中的公共工厂归一已经完成，不据此继续改动思程文件；公共出口仍做接入回归。

### 统一什么、不统一什么

保留 ExecutionWorldRouter、EffectTransaction、WorkspaceSandboxService、
ProcessExecutionCoordinator 和现有 candidate / certificate / CAS 存储；不增加第三套缓存。
统一的是执行身份、资源证据、候选所有权和事务采纳，不是所有工具的实现语言或进程模型。

两种执行形式进入同一出口：

1. **受控文件操作**：可信的原版 Pi 工具只得到封存的文件内容、目录条目、类型及已证明的负查询，
   不得到任意 host filesystem / process 权限。读取范围由实际操作决定，未知资源不是 ENOENT。
   变更形成现有工作区事务的 delta，不能直接写 Actor 工作区。这条路线不依赖 Linux 内核。
2. **原生进程**：执行描述包括 executable、argv、stdin、cwd、环境和运行时身份；只有具备隔离、
   完整观测及事务能力的 provider 才能提前启动。Bash 与完整搜索工具进程复用这一出口，而不是
   根据 shell 文本猜测命令之间的包含关系。已有 Linux 子进程证书与收益准入继续保留。

资源视图由现有 token / branch 拥有、计费和释放，不建立常驻的另一套资源缓存。先封存输入，再
执行可信文件操作；再验证输入才能采纳。Actor 的观察结果仍必须证明整个执行窗口稳定。
watcher 仅提供失效提示，不能把“没有事件”等同于“内容没有变化”。描述符身份、符号链接、
特殊文件、目录负查询、访问权限及路径大小写都是证据的一部分。

复用输入和复用结果明确区分：同一内容可供另一个查询重新计算，不表示不同查询输出等价。
已有 read-range / Bash-tail 投影在替代路径通过等价性测试前保留，不继续扩充语法规则库。

### 目标能力矩阵与资格边界

| 路线 | Windows | macOS | Linux / WSL |
| --- | --- | --- | --- |
| 封存资源上的原版文件操作 | 必须保留并扩大 | 同一实现，另需实机资格测试 | 同一实现，不要求 Landlock |
| 工作区 write/edit 事务 | 保留现有能力 | 保留现有能力 | 保留 Git / Overlay 驱动 |
| 原生 grep/find 完整执行 | 需要合格进程 provider 或语义一致的受控操作入口 | 同左 | 接入现有完整进程证据路径，不能只跟踪 rg 而漏掉 Pi 回读 |
| 任意原生 Bash | 未具备原生证明时不假装可用；WSL 是独立 Linux 环境 | 需要合格 provider | 保留整体、子进程和运行中复用 |
| 可移植虚拟执行器 | 仅在明确的共同 Actor/投机 profile 下准入 | 同左 | 同左，不替代更快的已有原生路径 |
| 思程 | 不虚构不存在的 Runtime | 同左 | 保留 SDK opt-in；当前公开 ARM64 Runtime 无本机实测条件 |

“所有系统都是一等目标”不等于“所有系统都有同一种内核能力”。不把 WSL 测试记作原生 Windows
测试，不把纯 TypeScript 测试记作 macOS 或思程 Runtime 实测。无法证明时只放弃相应复用，不
影响 Actor 恰好执行一次；poisoned commit 仍必须终止，不能 fallback 重复执行。

grep/find 的资格测试必须覆盖原版 Pi 的忽略文件、环境配置、编码、符号链接、负查询、输出排序、
截断及 grep 上下文回读。尤其不能仅在投机侧添加 `--no-config`，然后与使用用户配置的 Actor
混用缓存。必要的封闭搜索 profile 必须同时用于 Actor 和投机，并进入执行身份。

### 研究取舍

| 一手实现 / 论文 | 采用的结论及不采用的部分 |
| --- | --- |
| [BuildXL 文件系统证据](https://github.com/microsoft/BuildXL/blob/main/Documentation/Wiki/Advanced-Features/Filesystem-modes-and-Enumerations.md) | 除文件内容外还要证明目录枚举、存在性和负查询；不复制其面向已知构建图的乐观假设。 |
| [Riker / ATC 2022](https://www.usenix.org/system/files/atc22-curtsinger.pdf)、[Rattle](https://github.com/ndmitchell/rattle)、[Firebuild](https://github.com/firebuild/firebuild) | 输入证据、执行记录、产物复用分离；跟踪和缓存不是安全隔离，不另造一套 TraceIR 或构建系统。 |
| [VS Code 的 rg 参数](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts)、[ripgrep 指南](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md)、[fd](https://github.com/sharkdp/fd) | 搜索配置是执行契约，不是可忽略的实现细节；保留原版语义，或显式共同切换 profile。 |
| [cap-std](https://github.com/bytecodealliance/cap-std)、[Watchman cookies](https://facebook.github.io/watchman/docs/cookies) | 能力受限的文件接口值得借鉴；路径检查或 watcher 同步不能冒充不可变快照。 |
| [bubblewrap](https://github.com/containers/bubblewrap)、[Bazel sandbox](https://bazel.build/docs/sandboxing) | 隔离 provider 可替换；只读挂载仍可能被外部写入，不能省掉输入验证。 |
| [sandbox-runtime](https://github.com/anthropics/sandbox-runtime)、[Landstrip](https://github.com/landstrip/landstrip) | 存在 Windows/macOS 原生路线，但要验证完整权限、身份与环境；不自动修改用户账户、ACL 或系统策略来凑资格。 |
| [just-bash](https://github.com/vercel-labs/just-bash)、[agentOS](https://github.com/rivet-dev/agent-os) | 虚拟文件系统可覆盖多系统，但不透明等价于用户的原生 Bash；不为统一外观引入整套代理平台。 |
| [ripgrep-node](https://github.com/pithings/ripgrep-node)、[Node WASI 安全边界](https://nodejs.org/api/wasi.html)、[Wasmtime 安全模型](https://docs.wasmtime.dev/security.html) | WASM 值得做受限搜索资格实验；“编译成 WASM”本身不保证 host imports 安全，不直接采用拥有任意 host fs 权限的 shim。 |

### 分提交实施顺序

每一步先针对性测试、再完整测试，独立 commit 并立即 push 到 `xchang1121/pi` 的
`speculative-action`。不 squash、不新增 CI、不为了测试增加生产接口。顺序允许依据资格实验
收缩不成立的后端，但不得悄悄改变默认 Actor 语义。

1. **工具绑定归一**：将 Pi 工厂、操作注入和执行身份收敛到已有绑定模块，删掉 extension 与
   思程 runner 的重复工厂；保留独立使用原版 Pi 的对照测试，防止自我比较。
2. **封存资源所有权**：扩展现有资源 token 持有不可变数据和证据；受控操作不能回读 host。
   合并重复捕获/哈希/目录逻辑，并用表驱动的独立故障模型替换重复测试。
3. **跨平台文件工具**：原版工具在受控操作上执行，恢复 read/ls 提前执行；write/edit 继续
   使用现有事务。先证明输出、权限、取消和文件效果，再删除被替代的投影或工具名分支。
4. **完整进程调用**：将 shell 专用描述收敛为通用进程身份，使完整工具 runner 与 Bash 共用
   进程出口。grep/find 必须证明其全部环境和输入后才能恢复能力；不依赖只跟踪 rg 的局部证据。
5. **可移植增强资格实验**：比较受控搜索/WASM 与 Windows/macOS 原生 provider；只合入通过
   隔离、语义和性能门槛的路线。不合格的运行时给出具体原因，不增加无调用方的“未来接口”。
6. **配置与指标归一**：TUI 展示统一环境优先、受控/原生 fallback、Actor 的实际能力；prediction
   独立于 replay/observe。不同执行语义的 profile 明确选择，不能与同名工具的其他缓存混用。
7. **清理及真机验收**：合并重复测试，核对生产/测试净行数；Windows、WSL 执行原版 Pi 对照，
   保留思程真实 SDK 安装资格测试及 Runtime 缺失说明，不新建大篇幅报告。

每个可执行工具都测试 completed 命中、running join、输入改变 miss、取消和失败后 Actor 单次
fallback。平台相关路径显式 skip。真实 Bash 继续覆盖同父/跨父复用、并发 barrier 和发布竞态。
收益分别报告 `cold / reuse` 与 `Actor baseline / Actor 到达后的 hit latency`；保留历史 1.83×
口径，不把新执行器启动开销抬高的基线算成优化收益。首次未校准命中不声称因果加速。

### 本轮落地与资格结果（2026-09-07）

已实现工具工厂归一、token 持有封存输入、原版 read/ls 的跨平台受控操作、本地能力绑定清单和
TUI 层级配置。write/edit 沿用 Git 事务，Linux Bash 沿用现有证书/CAS、子进程和运行中接管。
进程 world 改为单 session 所有权，删除输出字符串的盲目路径替换；资源分支也只以 token
所有权决定是否仍可验证/提交。没有新增常驻缓存、虚拟机依赖或 CI。

后续文件出口收敛为显式 `ToolInvocation.filesystem`：read/ls 使用封存资源，write/edit 使用
私有工作区操作；二者执行同一组原版 Pi 工厂。工作区 world 不再调用任意传入的 host function，
也不再改写工具参数、diff 或返回结果中的路径文本。Git/Overlay 分支与现有事务提交仍保留，
这一步没有宣称消除了 write/edit 的 Git 准备成本；进一步取消这项依赖仍需证明权限、链接和
文件身份语义。`resources` 操作绑定字段已由 `filesystem` 替换，嵌入宿主应同步更新。

后续事务修正为记录实际 `write_contents` 操作，包括内容未变化的写入，不再仅由 Git diff 推断。
采纳原位写入时检查真实文件权限、描述符身份和链接数，保留已有文件句柄语义；硬链接无法表示时
交回 Actor。写入已开始或关闭描述符失败则 poisoned，不重放 Actor。目录创建逐项进入事务记录，
中途失败也能回滚；存在外来内容时保留现场并终止。`afterCapture` 若返回变更，现在表示完整封存
delta，Linux process 调用方显式合并文件和目录证据；思程不使用此接口，源码保持不动。

`PI_OPERATION_TOOLS` 是已接通的操作绑定，不是所有具有类似 effect 的工具集合。
自定义宿主创建 Linux world 时必须显式传入 `tools`；受控资源 world 未传绑定时仍只观察。
目录范围区分即时 `entries`、递归 `tree_entries` 与 `tree_content`，删除了自动猜测忽略文件
名称的 `tree_query`。TUI 的 Local safe fallback 包括这些受控操作，并不意味着只能在 Linux
上运行原生进程。关闭预测仍不连带关闭 Actor 观察/历史重放。

完整 Node/Pi runner 实验**没有通过准入**，因此阶段四没有继续扩大 shell 专用接口：

| 工具 | 直接 runner | 隔离 runner | 结果 |
| --- | --- | --- | --- |
| grep（含上下文） | 614 ms | 33,626 ms | 输出一致；可变宿主模块、statx 证据和内部管道端点使验证 indeterminate |
| find | 568 ms | 34,168 ms | 输出一致；同类证据缺口，禁止提交 |

这是 WSL x86-64、Node 24.20.0、Pi 0.84.1 上完整 runner 的实验，不是原版 Actor 搜索的
性能基线，也不代表所有进程封装都必然如此。没有放宽 mutable-host、metadata 或 broker
验证来凑命中；尚无合格的新调用方时不提交“未来通用进程接口”。

可移植增强仍有明确边界：just-bash/虚拟文件系统需要 Actor 与投机共同选择同一 profile；
不能只替换投机一侧。ripgrep-node 的 WASI 适配直接使用 host fs，不能直接当安全沙箱。
Windows 原生 sandbox 候选还须验证身份、文件效果和完整观察，不能仅凭隔离成功发布复用证书。
本轮未合入未通过这些条件的后端，也未宣称恢复原生 Windows 的任意 Bash 或 grep/find 投机。

进一步实测 `just-bash@3.4.2/browser` 的 InMemoryFs：约 1.2 MiB、105 个文件的输入封存约
29.5 ms，每次精确验证约 19–27 ms；原版 Pi grep 为 42–46 ms，虚拟 rg 内核为 70–105 ms。
原版 find 为 23–26 ms，虚拟文件枚举为 5–9 ms，但忽略规则和输出顺序并不等价，且尚未包括
完整 Pi 输出格式化。这不是已通过的工具加速比，未将该包加入生产依赖。虚拟运行时仍只适合
显式共同 profile；其[威胁模型](https://github.com/vercel-labs/just-bash/blob/main/THREAT_MODEL.md)
也把宿主 hooks 视为可信边界，不能用直接 host fs 适配器冒充不可变输入或原子采纳。

本机验证（源码 `8e858b7`；下列时间为单个资格任务，不是普遍加速保证）：

- Windows：check、500 passed / 16 skipped、build、bench:check、npm pack --dry-run 通过。
- WSL：check、515 passed / 1 skipped、build、bench:check 通过。公共事务修改后重跑了
  linux-process、linux-inflight，清理后又跑了 linux-artifacts、linux-topology；并发 barrier
  仍在完整测试中执行。exec-boundary 保留 `5691393` 的通过记录，不写成此提交上重新测量。
- 最新 Bash 冷执行/复用：同父 1.92×、跨父 1.75×；输出、退出码、文件效果及输入变化 miss 一致。
  128 MiB 产物的三次跨父命中均通过完整产物检查，不只测试小文件。
- 最近一次 Actor 运行中接管：基线 4,011 ms，Actor 到达后 2,882 ms，约 1.39×；提前量 3 秒。
  保留历史 1.83× 的冷/复用定义，不把它当作每次运行的最低保证。
- 原位写入对照：Windows/WSL 的硬链接均安全回退且 Actor 只调用一次，打开中的描述符均看到
  正确新内容；Linux 只读文件（含等内容写入）仍报 EACCES。部分写入/close 失败无第二次 Actor。
  目录中途失败的新测试在旧实现上实际失败，新实现通过，非空回滚保留外来内容。
- Capsule 源码 SDK 的 check、12 个测试、真实 tgz 构建和独立安装/import 通过，协议 2、
  fingerprint 与接入一致，这是前一阶段的 SDK 资格记录。此阶段只重跑接入回归，未修改思程
  源码。Installer 的 `tt binary is unavailable` 仍未解决，不能记作 Runtime 安装通过。

跨平台原版 Pi read 的真实图片任务：4096×3072 PNG（263,458 字节），由原版 Photon worker
缩放到 2000×1500；mock 只提供预测工具调用，不替代图片计算。基线为三次原版调用的中位数。

| 平台 | Actor 基线 | 已完成候选采纳 | 运行中采纳（提前 100 ms） |
| --- | --- | --- | --- |
| Windows | 1,532 ms | 6.16 ms | 1,404 ms |
| WSL | 1,554 ms | 4.17 ms | 1,369 ms |

两端均验证输出完全一致、生产者一次、命中时 Actor 零次、关闭新预测后的跨轮次命中，以及随后
输入变化触发单次 Actor。已完成命中的计算成本已提前支付，不是“免费计算”或任意 read 的收益。
小文件 read/ls 仍可能倒挂，已有校准收益门控决定采纳。macOS 和思程 ARM64 Runtime 没有真机结果。

后续封存输入复用（源码 `67768d6`）：分支在已有候选缓存中按执行身份和资源召回，由原版工具
重新计算不同查询，采纳前后沿用事务验证；未证明的访问只使当前查询失败，不破坏其他已封存输入。
read 的不同起点、ls 的不同 limit 共用这一机制，不新增工具专属输出投影。新的输入关系仅用于
已完成分支；运行中复用仍要求原有的覆盖证明，producer 不把另一个查询的完成当成自己的结果。
旧输出兼容路径也修复了正文伪装续读提示的错误证据，保留合法范围复用；思程模块、SDK、协议、
profile 和安装脚本相对保护边界 `ee97f0d` 无变更，不把共享入口回归当成 ARM64 Runtime 验收。

最新 Windows：510 passed / 15 skipped；WSL：524 passed / 1 skipped；两端 check、build、
bench:check 通过，Windows pack dry-run 通过。`a588904` 的真机图片任务仍通过已完成、运行中、
跨轮次和输入变化检查；同次 Bash in-flight 基线 4,009 ms、到达后采纳 2,734 ms，约 1.47×。
相对本轮 `65c8bfe`：生产源码 33,096 行，无净增长；测试 15,219 行，净减少 111 行。
较早的 30,411 行绝对目标仍未达到。完整搜索、可移植共同 profile、原生 Windows/macOS 进程
提供者仍需后续实现与资格验证，当前 goal 保持未完成；没有新增缓存层、配置开关或 CI。
