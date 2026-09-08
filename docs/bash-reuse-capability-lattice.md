# Bash 复用的依赖降级设计

## 当前阅读入口（2026-09-09）

本文后半部保留按阶段排列的设计、撤销方案和资格记录；历史段落中的“尚未接入”不能作为当前
功能状态。当前安装和 TUI 开关以 [README](../README-CN.md) 为准，搜索资格命令见
[有界生产资格](../bench/README.md#captured-search-production-qualification)。无新增依赖的
Captured search 已接通 find/grep 与 TUI，但 grep 仅验收 Windows x64 rg 15.2.0 和 Linux x64
rg 14.1.0 的显式 profile；它不是 Native Pi 默认语义，也不保证每次采纳有收益。
下文各结构修复阶段的 Windows/WSL 完整回归不替代既有原生成本测量，更不构成 macOS、
ARM64 或真实 ThinkThread Runtime 验收。下列无 Landlock 消费层仍是当前代码的实际限制：
Actor 未命中尚未接入独立的进程证书生产者，不能把通用的 Observe 接口当作该能力已实现。

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
- [`prepareActorReplay`](../src/linux-process-backend.ts) 独立打开原生 exec 边界；未命中会继续真实
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

2026-09-08 新增约束：不为投机增加安装包、运行时或下载步骤。仅复用 Pi 已安装组件和系统已有
能力；既有 Linux Bash 与思程 opt-in 接入不动。旧搜索设置直接恢复原生默认值，不保留安装报错。

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

**采样边界（2026-09-08 实测）**：Windows 与 WSL 的文件读取、目录枚举均可能更新 atime，
即使内容验证仍为 exact/valid。上述封存保证不是宿主 metadata/审计事件的零副作用保证，TUI
路线详情也明确提示。共享文件捕获将准入 lstat、两次 fstat 和最终 lstat 约束为同一 regular-file
身份；已知特殊文件不再打开，准入期间或末次 fstat 后的变更均拒绝。并发恶意替换成设备的
open 副作用仍不是 Node 路径检查能隔离的。不能通过事后恢复 atime 掩盖这种边界，也不能
把它写成已完成的全系统等价性。[Linux O_NOATIME](https://man7.org/linux/man-pages/man2/open.2.html)
受权限和文件系统约束；[Windows SetFileTime](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfiletime)
的逐句柄抑制需要额外访问权限，不能直接作为当前 Node 文件接口的跨平台保证。没有降低 Bash
metadata 证书校验，也没有增加不合格 provider。

复用输入和复用结果明确区分：同一内容可供另一个查询重新计算，不表示不同查询输出等价。
read-range 投影仍保留；Bash-tail 文本投影因下述真实反例已撤回，不继续扩充语法规则库。

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

进一步完成了完整工具对照，而非只比较搜索内核。实验保留 Pi 0.84.1 的参数处理、格式化和
grep 上下文回读，只在独立 worker 中替换搜索能力；默认 Actor 和生产依赖没有改变：

- `just-bash@3.4.2/browser` 不支持原版 argv 中的 `--color=never` 和 `--`，参数错误还会返回
  退出码 1，被原版 Pi 当成“无匹配”。诊断性调整 argv 后，完整搜索约 31–93 ms，原生约
  14–25 ms；二进制文件、错误文本和输出顺序仍不一致。这些调整未进入插件。
- `ripgrep@0.3.1` 的 WASM（rg 15.1.0）配合 `@bjorn3/browser_wasi_shim@0.4.2`，直接编译
  包内字节，只交付已封存的内存文件；不使用默认 wrapper 的 host fs、自动扩大 preopen 和
  未验证的共享临时缓存。Windows 原生 rg 15.2.0、WSL rg 14.1.0 的完整工具对照中，上下文、
  长行和正则错误样例一致，但多文件顺序/限额仍不同；Windows 的 NUL 文件内容及行号也不同。
- 原版 find 的公开 glob 入口可以接通同一内存 WASM，但 `rg --files` 不等价于 `fd`：目录
  结果、忽略规则优先级、大小写、完整路径 glob 和限额提示都有反例，不能透明恢复原生 find。

约 1.2 MB、109 个文件的 WASM 完整 grep 实验：Windows 热执行约 2–29 ms，但输入封存
另需约 22 ms、验证约 13–30 ms；WSL 热执行约 6–12 ms、验证约 30–38 ms。原型 worker
启动另需约 0.66 / 1.20 秒，不把这些成本藏到测量外，也不认定为 WASM 的不可消除成本。
这证明了受控入口的可行性，尚未证明可采纳性和稳定净收益；下一步需要共同执行身份和准确的
访问集合，而不是继续补参数/输出转换。[原包实现](https://github.com/pithings/ripgrep-node)
和 [WASI shim 的实现状态](https://github.com/bjorn3/browser_wasi_shim)也不能当作通用沙箱的安全承诺。

共享内核实验进一步收缩了可移植路线：[`wasi-sh`](https://github.com/alganet/wasi-sh) 的同一
文件系统/shim 可以同时运行 BusyBox ash 和真实 rg WASM，shell 写入的私有产物能直接交给 rg。
这避免了为不同工具各建文件系统，但 ash 不是原生 Bash，`rg --files` 也不是 fd。
仓库的 `bench/portable-kernel.mjs` 保留这一可复现边界，不进入生产依赖或默认工具出口。
它还确定性证明：相同输入字节在不同创建时刻会得到不同的 `stat` 时间戳，普通管道也读取时钟，
rg 使用时钟和随机数。因此，不能只对字节取哈希就认为整个虚拟执行结果可重放。
共同 profile 必须明确这些输入的语义并纳入证据；没有这项证明时不发布可采纳候选。

两端均验证实际模块的 64 MiB WASM 内存增长上限；这只是在独立 Node 子进程中的资格检查，
不是生产沙箱承诺。[Node 的 worker 限制](https://nodejs.org/api/worker_threads.html)不覆盖
全部外部内存，[V8 参数](https://nodejs.org/api/cli.html#useful-v8-options)也无稳定性保证。
完整 host imports 配额、取消、原版 Pi 完整调用和事务采纳仍是后端准入条件，不能用内核微基准
代替。可移植方案继续复用现有 token、candidate store 和事务，不增加第三套缓存；思程保护边界不变。

本机验证（源码 `1cf5ee1`；下列时间为单个资格任务，不是普遍加速保证）：

- Windows：check、508 passed / 16 skipped、build、bench:check、npm pack --dry-run 通过。
- WSL：check、523 passed / 1 skipped、build、bench:check 通过；linux-process、linux-inflight、
  exec-boundary、linux-artifacts、linux-topology 全部重跑通过，并发 barrier 仍在完整测试中执行。
- Bash 冷执行/复用：同父 1.84×、跨父 1.65×；输出、退出码、文件效果及输入变化 miss 一致。
  128 MiB 产物的三次命中均通过完整检查，冷/复用中位数约 1.22×。
- Actor 运行中接管：基线 4,012 ms，Actor 到达后 2,885 ms，约 1.39×；提前量 3 秒。
  保留历史 1.83× 的冷/复用定义，不把它当作每次运行的最低保证。
- 原位写入对照：Windows/WSL 的硬链接均安全回退且 Actor 只调用一次，打开中的描述符均看到
  正确新内容；Linux 只读文件（含等内容写入）仍报 EACCES。部分写入/close 失败无第二次 Actor。
  目录中途失败的新测试在旧实现上实际失败，新实现通过，非空回滚保留外来内容。
- Capsule 源码 SDK 的 check、12 个测试、真实 tgz 构建和独立安装/import 通过，协议 2、
  fingerprint 与接入一致，这是前一阶段的 SDK 资格记录。此阶段只重跑接入回归，未修改思程
  源码。Installer 的 `tt binary is unavailable` 仍未解决，不能记作 Runtime 安装通过。

同版原版 Pi read 的真实图片任务：4096×3072 PNG（263,458 字节），由原版 Photon worker
缩放到 2000×1500；mock 只提供预测工具调用，不替代图片计算。基线为三次原版调用的中位数。

| 平台 | Actor 基线 | 已完成候选采纳 | 运行中采纳（提前 100 ms） |
| --- | --- | --- | --- |
| Windows | 1,551 ms | 6.23 ms | 1,481 ms |
| WSL | 1,525 ms | 4.33 ms | 1,447 ms |

两端均验证输出完全一致、生产者一次、命中时 Actor 零次、关闭新预测后的跨轮次命中，以及随后
输入变化触发单次 Actor。已完成命中的计算成本已提前支付，不是“免费计算”或任意 read 的收益。
小文件 read/ls 仍可能倒挂，已有校准收益门控决定采纳。macOS 和思程 ARM64 Runtime 没有真机结果。

后续封存输入复用（源码 `67768d6`）：分支在已有候选缓存中按执行身份和资源召回，由原版工具
重新计算不同查询，采纳前后沿用事务验证；未证明的访问只使当前查询失败，不破坏其他已封存输入。
read 的不同起点、ls 的不同 limit 共用这一机制，不新增工具专属输出投影。新的输入关系仅用于
已完成分支；运行中复用仍要求原有的覆盖证明，producer 不把另一个查询的完成当成自己的结果。
Actor 正常执行的已绑定文件操作现在也由同次资源采集保留输入；只有稳定执行窗口得到证明后才
晋升为跨轮次候选。保留预算不足会丢弃整个输入视图，但保留完整指纹/身份校验和精确结果复用，
不再采集一次，也不允许用不完整视图提前执行。输入内存继续计入现有候选缓存预算。
旧输出兼容路径也修复了正文伪装续读提示的错误证据，保留合法范围复用；思程模块、SDK、协议、
profile 和安装脚本相对保护边界 `ee97f0d` 无变更，不把共享入口回归当成 ARM64 Runtime 验收。

`b9f3ac7` 将重叠采集收敛到同一个输入视图：较弱的元数据不再清掉已捕获的文件内容或目录条目。
`1cf5ee1` 由同一描述符直接拥有读取、哈希和保留缓冲区，删除 stream 生命周期及最终拼接副本；
仍验证 EOF、文件大小和前后身份，短读继续读取，增长/缩短/替换则拒绝，不返回未填充的内存。
相应测试合并了重复的“执行窗口”和“未来复用”场景，覆盖空文件、短读、多块内容及并发变化。

同机组件微基准（各 10 次测量的中位数，比较 `b9f3ac7` 与 `1cf5ee1`）如下；不是 Actor 加速比：

| 文件验证任务 | Windows 修改前 → 后 | WSL 修改前 → 后 |
| --- | --- | --- |
| 单个 16 MiB 文件 | 16.1 → 11.9 ms | 17.7 → 10.9 ms |
| 100 个约 12 KiB 文件 | 16.2 → 12.2 ms | 30.0 → 26.3 ms |

`3446907` 把 trace 收敛为一次解析的系统调用名、参数和返回值，元数据只从返回结构体捕获。
旧实现中路径文本能干扰 inode、符号链接标志和失败返回值，`<unfinished ...>` 文件名也会误触发
重组；五个定向反例有四个在修改前实际失败。字节转义现在严格解码为 UTF-8，不能无损表示的
路径拒绝进入证据。Linux observer epoch 升为 v16，旧解析器生成的证书不能沿用。

这一步生产源码净减少 2 行，相关测试净减少 182 行。Windows 503 passed / 16 skipped、
WSL 518 passed / 1 skipped，以及两端 check、build、bench:check 和 Windows pack dry-run 通过。
WSL 原生 `strace + cat` 的九类文件名均与实际文件的完整元数据指纹一致，包含中文和转义字符。
Linux artifacts/topology 真路径亦通过，128 MiB 产物及跨父命令创建目录后的文件效果均一致。
Bash 同父/跨父冷执行复用为 1.80× / 1.82×；运行中接管两次为 1.11× / 1.48×，首次同时在跑
其他测试，第二次单独运行。两次均无 Actor 重执行；这些是资格任务结果，不是最低收益保证。

`exec-boundary` 首次在子进程 trace 解析之前发生 broker bypass，未错误采纳，随后四次连续通过。
现有基准现在保留分支的验证原因，不能将复测成功等同于根因已关闭。`statx` 仍未放开：仅投影为
现有 `stat` 指纹会丢失返回掩码、属性和挂载身份等可观测字段；内核还可能返回调用者未请求的字段。
参见 [Linux statx 接口](https://man7.org/linux/man-pages/man2/statx.2.html)。本轮未修改思程保护边界。

截至 `65c445a`，相对本轮 `65c8bfe`：生产源码 33,094 行，净减少 2 行；测试 15,030 行，净减少 300 行。
`95a2162` 补齐 Actor 观察输入的有界保留，`65c445a` 删除只承载记录的事务内部类；两步合计生产
代码净增长为 0，仍由原协调器维护身份所有权与提交状态。Windows 502 passed / 16 skipped、
WSL 517 passed / 1 skipped，以及两端 check、build、bench:check 和 Windows pack dry-run 通过。
两端六种原版工具资格任务均通过输出及文件效果对照：read/ls 使用封存资源，write/edit 使用原
工作区事务，grep/find 仍走 Actor。思程对照仅为本地 wire runner，不是 Runtime 验收。
较早的 30,411 行绝对目标仍未达到。完整搜索、可移植共同 profile、原生 Windows/macOS 进程
提供者仍需后续实现与资格验证，当前 goal 保持未完成；没有新增缓存层、配置开关或 CI。

### 可移植搜索资格（2026-09-08，v4）

本节保留被撤销方案的研究与测量记录，不是当前安装或使用说明。新增运行时、包和安装器已从
插件移除；当前无新增依赖路线见文末及 README，不应按历史结果启用 grep 提前执行。

`portable-kernel.mjs --pi-tools` 现在将完整 grep/find 放入同一组 Runtime 流程。grep 使用
原版 Pi 的参数、格式化、上下文回读及真实 rg WASM；find 使用原版 Pi 公开的 `operations.glob`
入口和 [globby](https://github.com/sindresorhus/globby) 的虚拟 FS / gitignore 支持，不自写忽略规则。
同步邮箱沿用 [esbuild 的 worker 模式](https://github.com/evanw/esbuild/blob/main/lib/npm/node.ts)，
把异步捕获接到 [wasi-sh 同步 FS](https://github.com/alganet/wasi-sh)。Actor 与 producer 都通过
同一个 token-owned 输入边界；已删除资格脚本中 Actor 直接读宿主 FS 的路径。

这是显式共同 profile，不是原生替换：身份记录 Pi/引擎版本、OS、Node、固定环境、虚拟元数据、
预算和 find 的配置。find 大小写敏感、排序后限额、包含目录，仅使用受控工作区的忽略配置。
现有输入视图将工作区内链接规范化为目标，不提供原生 lstat 语义；越界链接拒绝整个查询，
不能用“忽略未知条目”伪造完整结果。Windows junction / POSIX symlink 的内外目标矩阵通过；
Linux FIFO 在获取大小时即被拒绝，未请求内容且 worker 未超时。Windows 不冒充通过 FIFO 测试。

真实对照保留了差异：原生 fd 与共同 find 的限额子集、提示文字不同；Windows 的路径 glob
样例也不同。原生 rg 的多文件限额子集与共同 grep 不同。Actor/producer 同配置输出则一致。
因此结果不能跨 profile 混用，也不能在默认模式下悄悄把 fd 改成 globby。

父进程继续拥有证据、Runtime 和事务，不新增缓存。两工具共用完成/运行中采纳、关闭新预测后
跨轮次复用、两个封存输入查询重算、扩大作用域后的单次 Actor 回退、过期/执行期间变化拒绝。
不同查询的 Actor 能在 producer 暂停时完成，禁用/取消后先退出 worker，再单次恢复执行。
16 MiB 忽略文件始终保留：grep 每次 82 个输入请求、约 1.18 MB 载荷；find 为 43 个请求、
1,173 字节，均不传输忽略内容。目录名、元数据和内容由原捕获器按需保留，封存后禁止扩张。

下表是同机顺序测量，单位 ms；两个 Actor 基线各取三次中位数，完成采纳是一次 Runtime 调用：

| 平台 / 工具 | 原生 Actor | 暖共同 profile Actor | 已完成采纳 |
| --- | ---: | ---: | ---: |
| Windows / grep | 22.9 | 61.3 | 8.6 |
| Windows / find | 20.9 | 21.6 | 2.8 |
| WSL / grep | 15.2 | 60.6 | 13.2 |
| WSL / find | 7.8 | 18.0 | 3.3 |

首次 worker 准备另计 Windows 630 ms、WSL 617 ms，后续独立 Actor worker 约 336–581 ms。
采纳前已支付投机计算成本；表中不能推导冷启动净收益，更不能用慢共同基线冒充原生加速。
取消矩阵覆盖无后续 import 的无限循环及等待输入，晚到 resolve/reject 不交付旧调用；配额
覆盖输出、管道、稀疏分配和累计输入。64 MiB WASM 上限不是整个进程 RSS 上界。

当时的复现依赖独立模块文件，现已撤销这一安装路线。WSL 的依赖应放在原生文件系统；
本次从 `/mnt/c` 加载依赖的对照仅首次准备就约 2.18 s，不能混入原生存储测量。

globby/Pi 是可信实现，客体不获得任意 JS、宿主文件句柄或网络接口。没有把
[Node permission 的防误用机制](https://github.com/nodejs/node/blob/v24.x/doc/api/permissions.md)
当作恶意代码沙箱。原生链接语义、全量配置矩阵、成本优化及生产共同 profile / TUI 接入仍待完成；
上述 v4 阶段没有新增生产依赖或 CI；后续内核提取的依赖变化见文末。思程保护边界和缺失平台限制不变。

v4 两端完整 check/build/bench:check 和 Windows pack dry-run 通过；Windows 498 passed /
17 skipped，WSL 514 passed / 1 skipped。生产源码、常规测试行数不变，find 复用同一组
资格流程，不复制一套 Runtime 测试。Linux Bash 真路径重跑亦通过：冷/复用同父 1.85×、
跨父 1.91×；另计运行中 Actor 4010 → 2817 ms（1.42×），采纳后未重执行。

2026-09-08 将手工 gateway 采纳替换为真实 Runtime 后，发现 Actor 会无覆盖证明地等待不同
查询的运行中候选：旧代码在固定 checkpoint 上等到 worker 的 5 秒 deadline 才 fallback。
现在由 Actor 与 preview 共用的候选排名入口区分已完成输入召回和运行中覆盖证明；沿用原有
状态与 `canShareInFlight`，不增加工具特判、超时规则或缓存。单测在旧代码确定性失败、修复后
通过；有覆盖证明的运行中查询继续允许接管。测试复用现有矩阵和 world builder，净减少 5 行。

完整 Pi grep 在 Windows/WSL 均通过跨轮次召回、三种封存输入重算、Runtime 运行中接管、
过期/执行窗口变化拒绝。不同查询的 Actor 可在 producer 暂停期间独立完成；插件总开关禁用
会终止 worker 并排空 stdio，重新启用后 Actor 单次执行。预测请求结束不是共享候选的取消边界。
此次暖共同 profile Actor / 完成采纳分别约为 Windows 16.3 / 8.1 ms、WSL 15.3 / 9.6 ms；
仍是显式共同配置的资格任务，不是原生工具加速保证，两个进程的准备成本另列。

实测还暴露一个后续调度粒度问题：不同查询重算的采纳耗时记在 producer 的同一服务身份中，
可能抬高随后精确命中的预估。本次 Windows/WSL 均记录负预计收益并按现有门控执行 Actor，
没有伪造时间保证命中；后续应在原调度器中区分采纳工作，而非新增估算层。思程保护边界仍无变更。

验收：Windows 505 passed / 16 skipped、WSL 520 passed / 1 skipped；两端 check、build、
bench:check 和 Windows pack dry-run 通过。Linux Bash 冷/复用同父 1.79×、跨父 1.67×，
另计 Actor 运行中接管 4009 → 2649 ms（1.51×），未发生采纳后重执行。源码 33,090 行、测试
15,007 行，相对本轮 `65c8bfe` 分别净减 6 / 323 行；不冒充已经达到较早的 30,411 行绝对目标。

随后修正收益样本身份：producer 服务使用 producer 的 K(a)，Actor 基线使用 Actor 的 K(a)，
采纳使用二者的配对键，并按执行 route 与既有匹配关系分组。精确结果、输入重算以及不同
provider 的采纳成本不再串用；仍保留原有三个有界计时窗口、精确优先/同类回退及分位数策略。
默认精确进程重放调用保持兼容，没有添加工具配置、缓存层或思程改动。删除重复的计时身份
拷贝、查找包装和分位数实现后，生产代码净减 42 行，测试合并后净减 5 行。

旧实现对照确定了错用样本的反例：Actor/采纳被估为 30/200 ms，新实现正确选择 100/10 ms。
完整 grep 资格任务中原先错误 fallback 的精确结果恢复采纳，Windows 约 4.5 ms、WSL 约
7.4 ms，少执行一次 Actor；不同查询仍重新计算，未改变输出或绕过验证。这不是原生等价或
生产启用声明。两端 check/build/bench:check、Windows pack dry-run 通过；全量测试分别为
Windows 504 passed / 16 skipped、WSL 519 passed / 1 skipped。当前源码 33,048 行、测试
15,002 行；这是按需输入捕获之前的记录，生产接入仍未完成。

Linux Bash 冷/复用同父 1.81×、跨父 1.84×，Actor 运行中接管另计为 4009 → 2670 ms
（1.50×），效果与直接执行一致。新生成的 32 MiB 拓扑任务中，96 轮变换的完整/运行中采纳
均通过收益准入；0 轮轻任务 Actor 中位数约 27 ms、完成采纳约 57 ms，正确拒绝两种复用。

本次捕获重构还复现了宿主观察的祖先 ABA 缺口：Actor 通过临时 junction 读到 B，恢复原
junction 后旧代码仍把结果绑定到 A。Windows 上移动并恢复同一个 junction 可保持 inode/
ctime，因此 resource fallback 不再提供 Windows 宿主结果晋升；提前在捕获字节上计算的
候选仍可跨轮次复用。POSIX 宿主观察额外捕获祖先绑定及目标链 change stamp，变化或证据
缺失时只放弃缓存。watcher 的肯定事件用于反证执行窗口；未来复用重新比较内容/所读元数据，
不再把自身读取造成的目录事件当成永久内容变化。新的链接反例并入原有表，删除固定时间等待
和重复 fixture；思程源码、SDK、协议、profile、installer 相对 `ee97f0d` 仍无变更。

此次 Windows / WSL 全量为 498 passed / 17 skipped 与 514 passed / 1 skipped，check、
build、bench:check 及 Windows pack dry-run 通过。完整 grep 暖共同 profile Actor / 完成
采纳约为 Windows 45.9 / 8.5 ms、WSL 41.0 / 10.3 ms；worker 准备成本另计约 625 / 716 ms。
Linux Bash 冷/复用同父 1.93×、跨父 1.94×；运行中 Actor 4009 → 2823 ms（1.42×），未重执行。
当前源码 33,090 行、测试 15,000 行，相对本轮 `65c8bfe` 净减 6 / 330 行；本提交测试净减
2 行，早先 30,411 行绝对目标未达到。没有 macOS 或思程 ARM64 Runtime 真机结果。

正式 Actor 调用现独立绑定执行身份，不再借用参数相同但尚未完成的 preview K(a)。确定性反例中，
预览使用 `preview` 环境，正式调用已切换为 `actor`；旧实现错误保留前者。host 每次调用只解析
一次身份，复用准入、原始 Actor 回调和结算共享该绑定，绑定成本仍包含在 Actor 到达后的计时内。
没有绕过原执行回调或思程 fallback 生命周期，也未引入跨调用缓存。旧的微任务时序测试改为
明确候选事件；重复的 host 隔离场景由原 runtime 测试覆盖，源码净减 13 行、测试净减 56 行。

两端全量保持 Windows 498 passed / 17 skipped、WSL 514 passed / 1 skipped，check/build/
bench:check、Windows pack dry-run 及完整 grep/find Runtime 资格通过。Linux Bash 冷/复用
同父 1.77×、跨父 1.72×；另计运行中 Actor 4010 → 2913 ms（1.38×），未重复执行。当前源码
33,077 行、测试 14,944 行；生产搜索 profile 与 TUI 接入仍未完成，思程保护路径保持无改动。

旧 Bash-tail 规则在原生 Git Bash 和 WSL Bash 上均出现反例：同一环境通过 `BASH_FUNC_tail%%`
提供函数时，`tail -n 3` 与 `tail -n 2` 可以分别输出参数本身；也可以前者成功、后者以 7 退出。
旧规则仍给出无损投影。现删除该解析器、输出投影及四个相关导出，不用函数名或可执行文件白名单
修补；命令精确采纳、read-range、封存输入重算和原生子进程证书保留。真实反例替换原语法样例，
host 用 barrier 验证运行中/已完成候选都不能据此跳过 Actor。此步源码净减 223 行、测试净减
167 行；当前分别为 32,854 / 14,777 行，思程保护路径仍无修改。

Windows 485 passed / 17 skipped、WSL 501 passed / 1 skipped，check/build/bench:check、
Windows pack dry-run 通过。Linux 同父/跨父冷执行复用比约 1.65× / 1.66×；Actor 运行中另计
4010 → 2720 ms（1.47×）。额外 topology 任务本次安全拒绝，**不计通过**：stdout 预期为
`pipe`、实际为 `socket`。[strace 6.8 源码](https://github.com/strace/strace/blob/v6.8/src/strace.c#L1569)
表明 tracer 在启动 tracee 后会把自己的 stdin/stdout 替换为占位管道；独立有界复现也证实两者
端点不同。因此对 tracer PID 的一次读取或延时重试都不是稳定继承证明，后续须单独修正输出通道
所有权；没有放松端点校验或把重跑成功当成该问题已解决。

输出通道现由启动方在继承前创建并持有，端点身份不再从会变动的 tracer PID 采样。原生 Socket
对象直接交给 spawn；启动、写端释放、读取排空及失败清理由同一启动过程拥有，不新增 helper、
重试层或公共 facade。具名 socket 不等于原生匿名 socket 的全部可观察状态：地址、属性等查询
会使证据拒绝采纳；仅对已证明的文件/管道且返回 ENOTSOCK 的无效查询保留资格。后端身份升版，
旧证书不会沿用缺失上述检查的证明。旧实现被固定端点反例稳定击败，新实现连续 10 轮通过；
同一测试还覆盖相同 producer 并发、内部管道拒绝、32 KiB 输出尾部、spawn 失败与 abort 后清理。

此次 Windows 485 passed / 17 skipped、WSL 501 passed / 1 skipped；两端 check/build/bench:check
与 Windows pack dry-run 通过。Bash 冷/复用同父 1.81×、跨父 1.88×；另计运行中 Actor 4009 →
2621 ms（1.53×），未再次执行。32 MiB topology 的生成效果和三次跨父采纳均通过。源码本步
增加 45 行、测试净减 12 行；当前为 32,899 / 14,765 行，相对 `65c8bfe` 源码仍净减 197 行，
早先绝对行数目标仍未达到。思程保护路径无变更；搜索生产 profile/TUI 和缺失平台真机资格未完成。

调用绑定现独立于可选 K(a)：不可规范化的输入、轮次外调用仍保留所选执行器；绑定失败只返回
该调用错误，不悄悄改用另一种语义。显式 profile 的不可变定义随 action 进入路由、资源捕获、
抢占和失效判定，不修改全局 Pi 注册表。完整搜索资格因此不再替换整个 host 的定义；真实流程
还检出了仅按工具名失效的问题（只读搜索错误取消运行中候选），现已改由相同绑定决策。
Windows/WSL 完整 grep/find 的跨轮次、输入重算、运行中接管、变化拒绝和独立 Actor 流程通过；
Linux Bash 的输出/文件效果、输入改变 miss、运行中单次采纳回归通过。两端 check/build/
bench:check 与 Windows pack dry-run 通过，全量为 Windows 484 passed / 17 skipped、WSL
500 passed / 1 skipped。此步源码 +10 行、测试净减 21 行，当前 32,909 / 14,744 行；思程保护
路径无变更。生产搜索执行器及 TUI 选择尚未发布，不把新的绑定能力冒充整个目标已完成。

固定搜索内核现由 `src/closed-search-kernel.mjs` 统一拥有：原 Pi 搜索解析器、封闭 filesystem、
单次输入物化、不可吞掉的捕获失败、WASI 时钟/随机源与限额。完整资格任务直接调用构建后的
同一实现，不再复制搜索及 WASI 适配。模块先复制字节再验证摘要，初始化期间修改调用方 Buffer
不会改变已验证模块；错误摘要和同一 worker 并发/重复初始化均被拒绝。首次 await 前取得唯一所有权；
初始化失败须退出该 worker。每次搜索重新建立输入，grep 新建 WASM 实例，
不是第三套跨轮次缓存。globby 16.2.4 与 wasi-sh 0.11.0 已锁定为按需加载依赖。

干净 WSL 安装发现 `ripgrep` npm 包会把 `rg` 加入 npm PATH，遮蔽原生工具并使既有外部配置
反例失败。因此它没有进入本仓依赖；资格用字节仍由明确的独立目录提供，内核不加载其 CLI 或
宿主 FS 适配。生产字节分发、惰性工作进程所有权及 TUI 共同 profile 选择仍待完成，默认 Actor
和思程保护路径不变。两端完整 grep/find 的跨轮次、输入重算、运行中接管、独立 Actor、越界/
变化拒绝和取消矩阵通过；Windows 484 passed / 17 skipped、WSL 500 passed / 1 skipped，
check/build/bench:check 及 Windows pack dry-run 通过。源码此步 +179 行，benchmark 净减
147 行，常规测试不增长；当前源码 33,088、测试 14,744 行，相对 `65c8bfe` 源码仍净减 8 行。
Linux Bash 整体/跨父子进程复用、输入改变 miss、运行中单次采纳回归通过。这不满足早先
30,411 行绝对目标，也不是缺失的 macOS/ARM64 Runtime 验收。

当时的字节分发曾使用独立安装器（现已删除）：下载有体积/时间上限的固定 npm 归档，先核对 SHA-512，
仅从内存中读取指定数据模块，再核对解压 WASM 的 SHA-256。归档路径不落盘，不建立 CLI 链接。
文件句柄以排他方式取得临时文件所有权，完整关闭后原子发布；下载和验证失败不会覆盖已有模块。
Windows 与 WSL 的真实下载、替换及完整搜索资格均通过，默认 Actor/配置和思程保护路径未变。
包边界原 fixture 合并 HTTP 失败、超限和摘要失败矩阵，测试数量不变；两端全量仍分别为
484/17 skipped 与 500/1 skipped，check/build/bench:check、Windows pack dry-run 通过。
源码此步 +48 行、测试 +9 行、benchmark −7 行；当前源码 33,136，距本轮最终不增长目标尚需
净减 40 行。工作进程生命周期与 TUI 接入继续进行，不把安装器当成生产投机路线已经启用。

统一工具出口删除两层内部转发，由同一个不可变结算记录保留 Actor 原始成功值或失败，观察回调
只能接收它；可恢复复用失败仍 fallback，poisoned 提交不再执行 Actor。四段重复测试合为包含
同步/异步失败、falsy 命中和观察器修改尝试的故障矩阵。Windows 481 passed / 17 skipped、
WSL 497 passed / 1 skipped，check/build/bench:check、pack dry-run、完整 grep/find 资格通过。
Linux Bash 同父/跨父冷复用比约 1.97×/1.95×，另计运行中 Actor 4009 → 2651 ms（1.51×），
未重复执行。此步源码 −23、测试 −41 行；思程保护路径无改动，生产搜索路线/TUI 仍待完成。

固定内核增加独立 IPC 启动入口，输入邮箱由主线程拥有，计算线程只同步取得本次调用的响应。
唤醒标记与请求序号分离，错误归属和超限帧直接拒绝；父连接断开时退出整个工作进程。正式入口
仅接受 grep/find，资格专用 shell/暂停命令没有进入生产协议。现有资格任务的 Actor 搜索和
输入等待取消改走此入口，producer 与无导入死循环使用同一通信实现的资格脚本；导入本身不
启动 worker 或加载搜索依赖。Windows/WSL 完整搜索资格、全量 481/17 skipped 与 497/1 skipped、
check/build/bench:check 及 Windows pack dry-run 通过。此步源码 +61 行、benchmark 净减 27 行，
常规测试不增长；相对本轮基线源码仍 +78 行，池所有权/TUI 和最终代码预算尚未完成。思程未修改。

工作区全局单例及八个转发出口已删除，调用方显式持有原有 `WorkspaceSandboxService`；Bash
产物重放的提交也归 backend 生命周期拥有并排空。重复 dispose 共享同一完成记录，已有竞争
提交测试验证关闭后拒绝新提交、等待已准入提交，不再增加独立测试。源码 −65、测试 −7 行，
相对本轮基线源码剩余 +13 行。Windows/WSL 全量仍为 481/17 skipped 与 497/1 skipped，
check/build/bench:check、Windows pack dry-run、完整搜索及 Bash 同父/跨父和运行中回归通过。
原版六工具与本地思程 wire runner 的对照通过，但这不是 ARM64 Runtime 验收；思程保护路径
无改动。进程池与 TUI 共同搜索 profile 接入继续进行。

父进程现在统一拥有搜索准备、单次调用、输入归属和强制关闭；完整 grep/find 的 Actor 与 producer
均使用正式入口，benchmark 删除其重复生命周期实现。运行中取消和 deadline 只有在 stdio close
后才返回，晚到输入完成/失败被消费，falsy abort reason 也保持原值；独立 Actor 不等 producer。
Windows/WSL 完整搜索资格和全量 481/17 skipped、497/1 skipped 通过，check/build/bench:check
及 Windows pack dry-run 通过。源码 +76、benchmark −50、测试不增长；距本轮基线源码 +89 行，
尚须压缩。默认原生行为、思程保护路径不变，生产池和 TUI 选择仍待完成。

host 与 TUI 的配置规范化已合并；原先仅 TUI 将 `predictionTimeoutMs: 0` 还原默认值的差异消除。
三套字段编辑函数合并为按类型验证并发布不可变设置的同一入口；原菜单展示测试并入实际编辑流程，
保留非法值拒绝、取消不修改、清空删除覆盖值及零等待验证。源码 −97、测试 −13 行；当前源码
33,088、测试 14,692 行。Windows/WSL 全量 480/17 skipped、496/1 skipped，check/build/
bench:check 通过，思程保护路径无改动。搜索池及 TUI 选择仍未完成。

搜索进程池已用真实 IPC 替换资格任务的手工双进程：按 Actor/producer 各保留一个空闲执行器，
忙碌调用独占新 reservation，不按相同查询串行 join；只有现有 Runtime 可以采纳结果。显式
barrier 验证同查询双 producer 并发、Actor 独立执行、关闭取消 producer 并排空 Actor。
Windows/WSL 完整搜索、全量 480/17 skipped 与 496/1 skipped、check/build/bench:check、
Windows pack dry-run 通过。源码 +31 行（相对基线 +23），常规测试不增长；插件绑定/TUI 尚未启用。
Bash 同父/跨父冷复用比约 1.87×/1.84×；运行中 Actor 4011 → 2758 ms（1.45×），未重执行。

共同搜索绑定现归 Pi invocation 模块拥有：同一 profile/cwd 身份、Actor 输入捕获、producer
受控 filesystem 入口及虚拟路径的正/负证据转换。资格任务删除重复 broker，并直接使用正式绑定
验证 Actor、完成采纳、跨轮次和封存输入重算。模块由同一文件描述符有界读取后校验摘要，错误
摘要、超限和 Linux FIFO 在准备期拒绝。两端完整搜索和全量 480/17 skipped、496/1 skipped、
check/build/bench:check、Windows pack dry-run 通过；源码 +75（基线 +98）、benchmark −14、
常规测试不增长，思程未修改。默认插件尚未选择新 profile；下一步是 TUI 和惰性选择生命周期。

配置覆盖的空值语义归 `applyOverlay`/`diffRecord` 所有，删除外层转发、克隆包装及手写深比较；
TUI 使用相同的结构比较，不再比较 JSON 键顺序。继承、tombstone、恢复发布和菜单行为回归通过，
两端全量及 check/build/bench:check 通过，源码 −40、测试行数不变；基线净增收敛到 58 行。

统计类型现从实际初始化结构推导，移除重复字段清单和 TUI 的整套零值缓存；初始容量使用已加载
配置而非固定默认值。原 TUI 流程验证 37 条配置从启动即正确显示，实时/重放统计对照继续通过。
源码 −69、测试行数不变；两端全量及 check/build/bench:check 通过，基线源码净减 11 行。

TUI 现可明确选择 Portable search，Actor/producer 共用同一绑定；默认原生 Pi 和思程保护路径
不变。设置代际拥有准备、失败和进程池释放，关闭不初始化，缺模块拒绝调用，显式刷新可恢复。
测试夹具改用真实 gateway，替换重复 fallback 状态机；源码 +49、测试 −22 行，当前源码
33,134（基线 +38）、测试 14,670，最终不增长目标仍待收敛。Windows/WSL 全量 480/17 skipped、
496/1 skipped，check/build/bench:check、pack dry-run 通过；真实扩展回调、TUI 暂存/应用、
配置持久化和 grep/find 采纳均通过。小文件夹具的 warm Actor → ready hit 分别为 Windows
grep 7.50 → 2.19 ms、find 8.23 → 1.13 ms，WSL 7.80 → 1.68 ms、5.26 → 0.99 ms；
不是整体任务加速保证。Bash 同父/跨父冷复用比 1.88×/1.92×，另计运行中 Actor 4009 →
2699 ms（1.49×），未重复执行。macOS 与 ARM64 思程 Runtime 资格仍缺实机，不计通过。

投机源请求改用已有 `waitForCandidate` 管理等待竞争和清理，删除独立 deadline/取消状态机及
两层 cause 转发；生产者取消和请求健康结算仍由源请求拥有。barrier/虚拟时钟替换四个重复场景，
覆盖零等待、失败分类、过期及晚到成功/拒绝。源码 −30、测试 −32；当前 33,104 / 14,638，
距本轮源码不增长目标仍差 8 行。两端全量 478/17 skipped、494/1 skipped，check/build/
bench:check、pack dry-run、完整搜索和 TUI 资格通过；Linux 运行中单次采纳、exec-boundary、
128 MiB artifact、32 MiB topology 回归通过。思程保护路径仍无改动，整体目标尚未结算。

会话重复动作直接由现有有界 LRU 拥有，不再通过三个方法转发 get/set/values。合并的资格矩阵
保留跨上下文、规范化别名、schema 拒绝、非权威样本、失败耗时和会话释放证明。此步源码 −12、
测试 −48；当前 33,092 / 14,590，相对本轮基线源码 −4、测试 −740。Windows/WSL 全量
477/17 skipped、493/1 skipped，check/build/bench:check 通过；早先绝对源码预算仍未达到。

文件证据窗口修正的旧实现对照触发三项确定性失败，现有五组描述符场景合并保留短读、增长、
缩短、替换，并覆盖准入/末次路径校验；特殊文件检查实际断言未打开描述符。源码 −2、测试 +11，
未增加测试总数。两端全量最终为 478/16 skipped、493/1 skipped，check/build/bench:check、
Windows pack、完整搜索/TUI、Linux process/in-flight 通过；同父/跨父冷复用比 2.00×/2.07×，
Actor 到达后 4010 → 2696 ms（1.49×）。Windows 首次全量的 Faux E2E 墙钟省时阈值失败、
重跑通过，另行收敛该测试的时间假设；不计作文件证据回归已消除了所有测试不稳定性。

Faux E2E 现使用正式 `host.execute`，删除手写 consume/fallback/actual 出口、轮询结算、未使用
preview 设置和重复 schema 哈希；就绪、Actor 绑定、权威结算事件决定交错，不再用睡眠与墙钟
省时阈值假定顺序。仍保留五类跨层流程，并覆盖候选执行失败后的单次 Actor 回退及实际输出。
Windows 连续 100 次通过；Windows/WSL 全量仍为 478/16 skipped、493/1 skipped，check/build/
bench:check 通过。测试净减 329 行，生产代码不变；当前源码 33,090、测试 14,272，相对本轮
基线净减 6 / 1,058 行。思程保护路径无改动；这不是 metadata 零副作用或缺失平台 Runtime 资格证明。

### 无新增依赖的当前路线（2026-09-08）

删除 wasi-sh、globby、WASM 分发/校验/运行适配和安装报错；主仓与 WSL 验收副本均实际卸掉
6 个独占依赖包。旧设置不做特殊迁移，也不初始化旧路线。Captured find 仅使用 Pi 已安装的
minimatch/ignore，经公开 operations 和同一封存输入代理运行完整工具；匹配与 ignore 解析不自行重写。
Actor/producer 共享新的执行身份，原缓存/事务负责结果和输入重用，仍不声称与原生 fd 完全等价。
grep 回到原生/可用统一环境，没有获准的本地跨平台提前执行路线；既有文件工具与 Linux Bash 保留。

两端全量为 Windows 478/16 skipped、WSL 493/1 skipped，check/build/bench:check、Windows pack
通过。真机 find 保留完成/跨轮次/输入重算/运行中采纳、并发、变化/越界拒绝与关闭证明；FIFO
断言移到实际读取接口，区分请求意图与已授予读取。小文件 TUI 任务的暖 Actor→命中分别约
Windows 4.97→1.71 ms、WSL 5.88→1.38 ms，不是原生 fd 或整任务加速保证。Bash 同父/跨父
冷复用比约 1.81×/1.83×，Actor 到达后的运行中采纳另计 4010→2808 ms，未重复执行。
源码净减 135、测试净减 1 行，当前 32,955/14,271；思程保护路径无变化。旧绝对源码预算、
macOS/ARM64 Runtime 资格和 metadata 零副作用边界仍未完成，不结算整体 goal。

后续真机反例揭示 glob 的文件身份缓存会折叠 Windows 盘符和 Unicode（`é`/`é`、`①`/`1`）。
已移除这一缓存及整套模拟 Node filesystem 适配；匹配器只遍历封存的 `/workspace` 名字空间，
物理路径转换复用现有 containment 策略，输出仍交给原 Pi 格式化。执行身份升级为 v2，旧结果
不可混用；没有新增依赖。原资格矩阵合并加入这些反例及 brace/相对路径匹配，测试行数不增长。
Windows/WSL 全量仍为 478/16 skipped、493/1 skipped，check/build/bench:check、Windows pack、
真实 find/TUI 及 Bash process/in-flight 均通过；同父/跨父冷复用比 1.87×/1.83×，Actor 运行中
采纳另计 4010→2746 ms（1.46×）。源码再减 6 行，当前 32,949/14,271；思程保护路径无变化。

原搜索取消只等待 guest 退出，委托给宿主的输入工作可能仍在运行；独立 Node 输入进程的反例
在旧实现确定性失败。现在用拥有 signal/完成证明的输入记录替代 `inputPending` 布尔量，同一
进程池取消并等待这项工作后才结算，不另建生命周期层。原取消矩阵保留晚到成功/失败，加入
真实进程关闭证明；两端全量、check/build/bench:check、Windows pack 及完整 find/TUI/Bash
回归通过。源码 +5、常规测试不增长，当前 32,954/14,271；相对本轮基线源码仍净减 142 行。

无新增依赖的 grep 尚未准入：[Pi 当前接口](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/grep.ts)
仍未提供搜索进程入口。拼接 UTF-8/UTF-16 或无末尾换行文件不能保留边界，JS RegExp 也不接受
rg 的 `(?P<name>...)`。只用已有 rg、私有逐文件输入和原 Pi 格式化的后续实验虽通过主要语义
场景，但 Windows 夹具中原生 Actor 约 17.2 ms，受控 Actor 308.7 ms、命中 44.8 ms，净收益
不成立。当时撤销了未提交的进程适配和临时 benchmark；这只否定该实现/夹具，不能推论所有无新增
依赖的 grep 都没有收益。不新增设置、不用放大的 Actor 基线宣称加速。

搜索组件准备失败现只意味着没有可绑定的执行器，安静保留原生 Actor；删除单独的 error 状态、
安装/重新配置提示及重复 catch。已绑定调用的输入错误仍拒绝，不能中途切换语义。生命周期测试
改验单次原生 fallback、刷新恢复和绑定后不偷换执行器；TUI 暂存/旧设置由原实机流程覆盖。
本步源码 −2、测试 −5 行，Windows 478/16 skipped、WSL 493/1 skipped，check/build/bench:check、
Windows pack、真实 find/TUI 通过。Bash process 首次因文件时钟未推进而安全拒绝，复跑通过；
in-flight 另计 Actor 4009→2611 ms（1.54×），没有重复执行，不声称消除了时钟不稳定性。
思程保护路径未改；主仓与 WSL 副本均无新增搜索依赖，仓外旧实验残留不属于运行时且未计作清理完成。

进一步的原生 rg/fd 实测仍被 statx、目录枚举、时间/随机源及部分可变宿主输入拒绝，不能仅把
shell 描述改名为通用进程就开放完整搜索。审查同时复现了错误的 dirfd 依赖：旧 decoder 会把
renameat/linkat 的两端和 symlinkat 的新路径都解析到 cwd，未知 dirfd 也会错误地当成 cwd。
现在以 [内核路径参数 ABI](https://man7.org/linux/man-pages/man2/rename.2.html) 表统一拥有每个
pathname/dirfd 对，兼容绝对路径和描述符形式的元数据调用；删除字符串位置猜测、重复名单和
metadata 路径分支。证据 epoch 升为 v18，旧证书不能沿用。两项反例在旧实现失败，WSL 实际
renameat/linkat/symlinkat 记录通过；临时探针已删除，没有为测试安装任何组件。
源码 −43、测试 −3 行，Windows 477/16 skipped、WSL 492/1 skipped；check/build/bench:check、
pack、完整 find/TUI、Linux process/in-flight/exec-boundary/artifacts/topology 通过。
本次同父/跨父冷复用比约 1.59×/1.66×，Actor 到达后 4011→3129 ms（1.28×），不替代历史
1.83× 的指标定义。验收副本核对后仅修正旧报告字段和 README；生产/测试/依赖/安装脚本一致。
后续关闭了 [CLONE_FS 共享 cwd](https://man7.org/linux/man-pages/man2/clone.2.html) 的反例：
真实子进程切到 B 后，父进程读到 B，但旧 decoder 将普通 open 的依赖记在 A 且判为完整。
进程选择、起始 cwd 和共享关系现由同一记录拥有；共享组发生成功 chdir/fchdir 后不跨 PID
猜测顺序。独立 cwd、共享但不变仍可通过；目标 exec 之前已与被排除任务共享的边界保守拒绝，
因为 [exec 不会解除这种共享](https://github.com/torvalds/linux/blob/master/fs/exec.c)。相对 chdir
先按旧 cwd 记录路径再更新状态；epoch 升为 v19，旧证书失效。20 次真实 barrier 对照通过。
合并原有根选择、syscall 重组和分类夹具后，源码 +5、测试 −3 行（相对本 goal 起点 −182/−1070）。
Windows 475/16 skipped、WSL 490/1 skipped；check/build/bench:check、pack、find/TUI 和五组
Linux Bash benchmark 通过。同父/跨父约 1.80×/1.84×，Actor 到达后 4012→2754 ms（1.46×）。
临时探针已删除，未安装组件，依赖清单及思程保护路径未改。完整 grep 尚未准入，仓外此前被拒绝
删除的旧实验残留也未计作清理完成；整体 goal 与最终代码预算仍未结算。

元数据证据现按消费字段封存，删除名字查询对文件大小的无关依赖；受控 find 身份升为 v3。
旧实现真实跨轮次任务会重跑，新实现保留 16 MiB 文件增长后的候选；原生 Pi ls 对照中，文件
增长至 64 MiB 后输出不变、验证读取 0 字节，替换为目录仍 miss。类型证据不能晋升为大小证据，
内容读取预算和 Actor 窗口封存仍严格检查。合并既有资源矩阵，源码和测试均净零增长。
Windows 477/16 skipped、WSL 492/1 skipped，check/build/bench:check、pack、完整 find/TUI 及
五组 Linux Bash 验收通过；同父/跨父冷复用比 1.89×/1.88×，Actor 到达后 4009→2516 ms（1.59×）。
临时探针已删除，无新增依赖或思程改动；完整 grep、缺失平台资格和整体代码预算未结算。

Runtime 仍曾在原版 Pi write 改变无关内容后丢弃完整 find 候选，真实任务复现了额外执行。
现以同一后端校验契约拥有共享结果的新鲜度：无校验器、校验异常均不允许采纳；删除外部
watch 订阅和路径重叠对封存结果的直接淘汰。未完成工作、checkpoint 后代和 Actor 窗口仍保守。
原 read/ls/write 对照及 find/TUI 通过，无关写入命中、实际输入变化 miss；运行中重启、缺证据
拒绝、事务失败并入原测试矩阵。Windows 482/16 skipped、WSL 497/1 skipped，全测及构建/打包、
五组 Linux Bash 通过；同父/跨父冷复用比 1.93×/1.94×，Actor 到达后 4009→2555 ms（1.57×）。
源码 −71、测试 −29 行，当前 32,843/14,231；不增加缓存或依赖，思程保护路径保持不变。

完整原版 Pi grep 的无新增依赖对照现保留在 `bench/grep-captured-qualification.mjs`：仅使用已有 rg，
禁用下载，在私有逐文件输入上运行完整工具，再用正式 Runtime 连续采纳五次，断言输出相同且只执行
一次 producer。下表为五次 Actor/采纳的中位数，producer 为单次准备加执行；均为毫秒。

| 系统/固定夹具 | 原生 Actor | 固定排序 host Actor | producer | 已完成采纳 |
| --- | ---: | ---: | ---: | ---: |
| Windows：32 文件，字面搜索 | 18.15 | 14.58 | 157.83 | 9.26 |
| Windows：5.9 MB 单文件，Unicode `^\w{60}$` | 42.85 | 40.41 | 67.47 | 5.71 |
| WSL：32 文件，字面搜索 | 7.53 | 5.55 | 72.86 | 16.46 |
| WSL：5.9 MB 单文件，Unicode `^\w{60}$` | 29.40 | 29.21 | 52.60 | 5.05 |

单文件 Unicode 案例无匹配，也不是广泛任务收益保证。多文件有限输出在原生与固定排序间不同，
因此不能默认替换原生 Pi；固定排序 host 对照也不是完整受控 Actor profile 的耗时。WSL 轻查询
明确倒挂，未来必须使用已有收益准入。此步只恢复路线的可行性研究，不开放生产 grep；一般路径、
ignore/配置、混合编码、取消/原生子进程清理、执行身份仍须资格验证。源码、常规测试、依赖和思程
保护路径均未改，不增加安装或缓存层。仓外被拒绝删除的旧实验残留仍不计作清理完成。
Windows 482/16 skipped、WSL 497/1 skipped 全量通过，check/build/bench:check 与 Windows pack
dry-run 通过；此步只变更实验和说明，未重跑相同生产版本已经通过的五组 Linux Bash 验收。

Pi 的公开文件操作支持异步，搜索执行器不再需要旧同步内核留下的计算线程和共享内存邮箱。
现由一个 128 MiB 堆上限的子进程拥有调用/输入对应关系，父进程继续拥有期限、强制终止以及
委托输入操作的排空；同一生产协议也取代资格脚本的重复结算。Windows/WSL 完整 find/TUI、
忙碌并发、死循环取消及真实输入进程清理通过；全量仍为 482/16 skipped、497/1 skipped，
check/build/bench:check、Windows pack 和五组 Linux Bash 通过。同父/跨父冷复用比均约 1.76×，
运行中 Actor 关键路径另计约 1.44×。此步源码 −18、benchmark −10、常规测试不增长；当前源码
32,825、测试 14,231。没有新增依赖、profile 或思程改动；完整 grep 与缺失平台资格仍未完成。

完整 grep 的资格脚本现让原版 Pi 在受限进程中执行，只有父进程持有真实 rg 句柄；一次调用的
输入记录同时拥有流式输出、字节计费、取消和完成。普通输入与分块输出共用发布逻辑，不增加
另一套结果缓存或进程状态机。资格专用模块适配器转交进程操作，不改 Pi 文件、不增加安装；
生产内核仍只授予 find 文件操作，没有因此开放 grep 或任意原生进程权限。
Windows/WSL 均通过完整 Pi 格式化、命名分组、上下文回读、结果上限停止、五次 Runtime 采纳，
以及各 20 次真实 rg 启动后取消/输出超限交错；显式 barrier 证明 native close 和宿主清理都先于
请求结算。这是执行边界证明，尚不是一般目录/配置/ignore/混合编码、引擎身份或全链路 Actor
fallback 的资格。固定排序 host 的上下文搜索约 38.55/35.52 ms，已完成采纳约 4.89/4.90 ms；
producer、工作进程首次启动另计，不把排序差异或更重的执行器基线算作投机加速。
两端全量 482/16 skipped、497/1 skipped，check/build/bench:check、Windows pack、find/TUI
及五组 Linux Bash 通过；同父/跨父约 1.80×/1.76×，运行中 Actor 4010→2687 ms（1.49×）。
此步源码 +9（相对本 goal 基线仍 −262）、常规测试不增长；当前源码 32,834、测试 14,231。
思程保护路径、依赖清单和默认路线未改，整体 goal 与更早的绝对代码预算仍未完成。

### 完整动作链路整改（续轮目标）

原 goal 已由用户结算；本轮新 goal 将 K(a) 与全生命周期纳入正式目标，先关闭公共链路的不变量缺口，
再继续 grep。代码增减以 `485cdb2` 为本轮基线，更早的绝对代码预算仍单独跟踪，不视为已完成。
不新增依赖、缓存、工具名规则或纯转发层；思程保护路径继续不改。

完整链路为：原始预测 / 已准备的 Actor 参数 → 绑定调用并封存 K(a) → 候选索引 →
执行路线与权限 → 进程和资源输入 → 封存产物 → Actor 校验 / 转化 / 提交 → 保留或释放。
K(a) 只证明请求与执行契约相同，不代替资源新鲜度、输出覆盖、隔离或事务证明：

- 输入只在 K(a) 之前经过 Pi preparation；之后权限检查、执行和反馈不得重新转换。
- 键包含规范参数、语义版本、schema 和执行身份；来源、角色、call ID、轮次不是等价条件。
- 文件版本属于已执行产物的证据，不塞进另一套键或缓存；相同键仍可保留不同资源版本。
- 不同查询只能经已证明的结果投影，或在已有封存输入上重新计算，不能只凭键关系交付结果。
- 取消请求、逻辑候选结算与物理执行/资源回收是不同事实；关闭拥有者必须等待后两者完成。

按结构问题独立验证、commit 和 push：

1. 单次准备并封存执行参数：删除 Drafter 的重复校验及生成键后的 preparation，以原有全工具
   running/completed 矩阵复现非幂等转换，不增加镜像测试。
2. 审查 K(a) 的执行身份、Actor preview/最终拦截、绑定刷新及转化边界；消除可变描述或重复解析
   引起的键与执行漂移，保留低成本的候选索引和原生 Actor 默认语义。
3. 让现有 Runtime/事务所有者等待取消后的执行、晚到 branch、观察 capture 和正在采纳的资源；
   检查刷新、关闭、异常与并发路径，不另造通用生命周期框架。
4. 在上述公共边界上补齐无新增依赖 grep 的一般目录/配置/编码、原生句柄及全链路 Actor fallback
   资格，只有通过输出等价与现有收益准入后才进入生产绑定和 TUI。

验收继续区分 Windows/WSL 实测与缺少 macOS/ARM64 Runtime 的限制；同时检查普通工具、Linux Bash、
思程 opt-in 回归、生产/测试净行数及工作树状态，不用实验微基准替代完成标准。

第 1 项：原全工具矩阵加入非幂等 preparation 后，旧实现实际调用 4 次；重构后仅调用一次，
running/completed、输入重算和 stale miss 均通过。Windows 482/16 skipped、WSL 497/1 skipped
及两端 check 通过；生产 −21 行，测试净 0 行，没有修改思程或依赖。

生命周期第 1 步：现有 session lane 同时拥有物理执行和异步清理，禁用/关闭会等待晚到 branch、
Actor capture、seal 和预览；seal 跨越关闭边界时不再晋升结果。用显式 barrier 矩阵替换两段旧测试，
覆盖执行中/已封存/观察中/晋升失败/封存中的 disable 与 dispose。Windows 481/16 skipped、
WSL 496/1 skipped、两端 check 和五组 Linux Bash 验收通过；in-flight Actor 4009→2600 ms（1.54×）。
此步生产 +11、测试 −20；相对 `485cdb2` 累计生产 −10、测试 −20。事务内资源借用仍需下一步封闭。

生命周期第 2 步：事务回收先拒绝新的校验/重算，再等待已经借用封存输入的重算、校验和提交完成。
已提交或 poisoned 的历史结算不因清理改写，避免重复 commit 被误当成可安全重新执行。原单一 abort
测试改为四阶段×成功/失败交错矩阵，复现了旧实现提前 dispose 及关闭后返回 valid 的问题。
Windows 481/16 skipped、WSL 496/1 skipped 和两端 check 通过；累计生产 −9、测试 −13 行。

K(a) 绑定第 2 步：Actor 入站参数和解析后的执行元数据由本次调用持有；prepared 参数、计划与键
共用一个不可变值实现，删除两份重复深冻结。原绑定矩阵加入异步改参、环境/argv/command 后改，
验证 keyed、unkeyable、无 turn、绑定失败仍是同一执行器且恰好一次。Windows 481/16 skipped、
WSL 496/1 skipped、两端 check 通过；累计生产 −4、测试 −6 行。执行函数闭包仍由 provider 的
版本化契约负责，不能通过复制函数或比较文本推导权限或等价性。

生命周期第 3 步：取消只结算逻辑候选，物理额度由执行与清理完成后的统一 finally 归还；删除
独立 discard 和预览绕过准入的路径。实际 Actor 已持有的 reservation 决定 Actor 准入，可立即
启动但必须记账；未到达的预览仍受投机额度约束。四类交错矩阵连续通过 100 次，两端 check/
全量测试（Windows 480/16 skipped，WSL 495/1 skipped）及真实 Bash process/in-flight 通过。
此步生产 +1、测试 −26；累计生产 −3、测试 −32 行。基准与重复测试并行的耗时不用于性能回归结论。

生命周期第 4 步：统一工具出口与 Router 共享准入/关闭所有者，覆盖 Actor、prepare、fork、capture
和诊断探测。关闭先封闭新调用，等待已进入的调用，再逐个清理全部 provider；重复关闭只执行一次，
同步清理错误也不会跳过其他 provider。替换重复路由测试为七阶段交错矩阵，两端 check/全量测试
（Windows 480/16 skipped，WSL 495/1 skipped）通过；累计生产 −2、测试 −41 行。

用户新增测试负载约束：后续修改优先运行针对性、低并发测试，完整回归与真实 Bash benchmark
集中在阶段验收；不再每次修改都重复压力运行，已通过且未受改动影响的证据不重复采集。

K(a) 绑定第 3 步：原始 Actor 流式预览与预测共用一次准备/校验入口，最终 Actor 仍使用宿主已准备
参数独立绑定，不继承预览授权。七工具矩阵覆盖两种来源、运行中/完成后采纳和重复预览，并用
非幂等 read 参数验证没有漏准备或重复准备。旧实现定向复现零次准备；Windows/WSL 各 50 项
单 worker 定向测试及 check 通过，未重复高负载回归。累计生产 −6、测试 −37 行。

grep 资格脚本新增低负载 `--semantics-only`：14 类目录/忽略优先级、显式被忽略根、glob 覆盖、
混合原始编码、上下文和限额对照，进入正式 host 的 K(a)、Router、事务和采纳路径。内容、忽略
规则及负查询目录名字分别变化后，都拒绝旧证据并只执行一次独立 Actor。已有 rg 经稳定读取
封存 SHA-256 和本任务私有副本；目录与配置证据交给同一原生引擎选择，仅复制所选原始字节，
16 MiB 被忽略文件不进入内容证据。没有解析用户 glob 或重写 Pi 的结果格式化。

资格过程中复现了父级忽略规则被切断、显式被忽略目录漏结果、查询 cwd 与 glob 基准不一致等
问题；私有祖先目录准入及原生选择集合修正后，Windows/WSL 小夹具均通过，各 63 次原生执行
全部关闭，一次真实 abort barrier 证明输入清理先于结算。WSL 小查询可在 limit 取消前已退出，
不以增加负载来强求 kill 计数。未重跑大型性能/压力矩阵；这里只证明本轮列出的语义，不证明
一般链接/特殊文件闭包、成本收益或生产 TUI 已可准入。生产、常规测试、依赖和思程路径未改。

结果所有权：小夹具确认 Actor 修改已采纳的 content/details 会污染下一次共享命中。现在事务
拥有封存时的普通数据，各读取/采纳及输入重算分别获得独立值；共享 commit 仍执行一次，但
不能用后来变化的对象替换封存结果。原型对象、getter、Buffer、符号及隐藏字段不被有损复制，
退出共享复用并等待分支清理；Actor 原始值既不冻结也不改写，独占效果结算保持原语义。
同时移除 Gateway 的上下文工厂、描述符和 capture 转发，直接使用已经绑定的工具调用。

Windows 单 worker 完整回归 480 passed/16 skipped。WSL 全量其余 493 passed/1 skipped；
两项新增断言错误地要求低收益重复查询必命中，事件证明正常拒绝为 candidate_join_not_profitable。
保留首次所有权复用和跨轮次输入重算断言后，Windows/WSL 各 19 项定向回归通过，两端 check
及 bench 类型检查通过；不重复其余回归或大型 benchmark。相对 485cdb2 累计生产 −1 行、
测试 −22 行；思程受保护路径及依赖未改。grep 的链接/特殊文件和生产准入仍待完成。

推送时检测到远端独立 Actor Profile 功能 f662706，检查无文件重叠后正常合并，未覆盖或重写该
功能。合并后两端 check 与 56 项集成测试通过；生产预算一度变为 +32。随后把设置、TUI、
模式预测和 CAS 中相同的正数/非负数/概率规范化并入现有 setting-input，保留严格文本输入和
已有取整/默认值规则，生产减少 39 行。两端 check 与各 136 项单 worker 定向测试通过，没有
重跑全量/高负载基准。当前相对 485cdb2 生产 −7 行、测试 +61 行（包含外来功能新增 77 行）；
Actor Profile 功能和思程路径完整保留。继续完成 grep 的证据闭包、收益验证和 TUI 接入。

资源条目证据：在已有视图的 `stat(path, "entry")` 中提供最终条目类型和原始链接值，不跟随
最后一段链接，也不因此授予目标内容读取权限。原有 type/stat/read/ls 保留跟随规则；删除了
单独 alias 转发。既有链接矩阵加入外链、悬空链、环链、原始值变化、祖先映射及零内容读取，
特殊文件检查覆盖 Linux FIFO；条目类型变更失效而普通内容变化不污染类型证据。
两端 check、Pi/host 定向测试通过，最终四文件回归 Windows 41 passed/5 skipped、WSL 46 passed；
未重跑全量或高负载测试。此步生产 +1，相对 485cdb2 累计生产 −6 行，思程路径不变。

grep 链接资格：新增最终条目证据接入小夹具，显式工作区内目录/文件链接、POSIX 链接忽略配置
及发现后跳过的链接/FIFO 均和原生输出对照。Windows 实测 `--files` 跳过悬空 junction，实际
搜索却返回错误；不能以文件选择成功推导搜索成功。工作区外或悬空目标无法证明时拒绝投机，
Actor 直接在原工作区运行一次并保留原生错误，不再通过投机端私有复制辅助流程执行回退。
Windows/WSL 各 19 类小语义案例通过，原生进程分别 69/72 次全部关闭；两端 16 次原生链接
刻画及类型检查通过。链接配置目标变化也使旧结果失效；未跑大型性能或全量回归。
仍为资格脚本，Git 间接目录、被忽略大树的元数据成本、通用配置边界、收益及生产 TUI 待完成。

grep 目录裁剪：小夹具先复现被忽略目录仍消耗枚举配额，再用私有临时标记文件把下一层目录
交给同一原生 rg 判定准入。标记的最终 glob 只覆盖标记文件，不能放行其父目录；普通选择、
用户 glob 和显式根的原生集合规则共用，未解析用户模式或调试文本。`.git` 仅读指定 exclude
配置，不遍历对象目录；被忽略树内部新增文件后，旧输入仍可完成一次采纳，Actor 未执行。
两端各 22 类小语义案例通过（143/146 次原生进程全部关闭），包括文件级忽略后的深层重新
准入、正 glob 放行目录及负 glob 裁剪。仅类型检查和这些小夹具，无大树、全量或压力运行。
分层选择增加了原生进程次数，收益仍未证明；此步不修改生产代码，也不等于已完成生产准入。

事务证据所有权：旧共享 route 在 begin 后被外部改为独占时，缺少 backend.validate 的结果实际
被标为 valid，现有三态测试已复现。begin 现在持有不可变描述和 route，公开 attempt 不暴露可写
生命周期；既有所有者表同时持有内部状态。原生/默认校验结果也封存为独立不可变证据，后端或
读取方修改 status/metrics 不会改变采纳许可，后端原对象不被冻结。两端 check 与各 23 项单
worker 定向测试通过，没有全量或高负载运行；此步生产净 −1，累计相对 485cdb2 生产 −7 行。

捕获输入权限：封闭搜索改用 `captured_inputs` 声明，不再借用整树内容快照的宿主观察权限。
同一读重算矩阵证明捕获执行/转化仍可用，而该声明不能认证 ambient Actor；拒绝空依赖时也不再
先创建无人持有的 watcher。资源管理器的唯一工厂与 scope 转发并入既有所有者，文件系统根不
启用递归监视。两端 check 及资源/语义单 worker 定向测试通过，Windows 29 passed/5 skipped、
WSL 34 passed；未跑全量或高负载测试。生产规模继续净缩减，不扩大内容读取边界。

权限结果规范化合并到宿主现有边界，预测准入与 Actor 采纳仍分别调用当前策略，未复用旧许可。
既有 Bash 夹具合并覆盖原有不可证后缀、缺少回调、首次拒绝、采纳前撤权，以及布尔/结构化结果
和诊断保留；不启动真实 Bash。两端 check、宿主 16 项及 Gateway 2 项通过。生产再减 16 行，
相对 485cdb2 累计 −32 行；测试累计 +111 行（包含外来 Actor Profile 功能），未新增测试文件。

命名输入边界：显式 filesystem 绑定可声明只读捕获根；默认文件工具仍限制在工作区，宿主观察
权限不扩大。stat 沿用已封存的 realPath 证据，无额外目录扫描；无跟随 entry 返回链接本身的
物理名字。既有矩阵证明未声明的外部读被拒绝、声明后的具名输入参与转化/失效，并按字节预算
记账；文件系统根不递归监视。两端 check 与资源矩阵通过（Windows 19 passed/5 skipped，
WSL 24 passed），无全量或压力测试。生产 +3，累计 −29 行；grep 集成资格仍在进行。

grep 命名配置资格已覆盖上级三类 ignore、锚定规则、目录别名、Git 间接目录及负 commondir。
所有原生输入位于私有路径结构中；仅具名捕获祖先配置和外链目标，不扫描卷根或 Git 对象树。
移除实验中的 `--no-require-git`：它会让测试引擎跳过 `.git` 文件间接目录。原始 Actor 保持
原工作区和参数；配置变化后拒绝旧证据且仅执行一次。两端各 33 个小语义案例通过；本机分别为
Windows rg 15.2.0、WSL rg 14.1.0，`.jj` 识别差异由各自原生对照验证。Windows 197 次原生执行
全部关闭，WSL 修正跨版本夹具断言后仅补跑最后 4 项（23 次全部关闭），未重复已通过的 29 项。
生产、常规测试和依赖未改，累计生产仍 −29 行。别名结合 glob、成本收益及生产 grep/TUI 尚未完成。

目录别名的 glob 资格：真实路径处理原始 ignore，逻辑路径保留调用拼写；原生 rg 在中性/拒绝
默认值下区分 glob 覆盖，不解析用户模式。只有已经准入的目录成为下一层浅查询根，避免绕开被
忽略父目录；临时目录规则只编码字面文件名，执行前移除或恢复原始配置内容。两端各 40 项小语义
案例通过，原生进程 250/252 次全部关闭，包括别名正负 glob、特殊目录名、配置本身作为结果及
原有内容/配置/负名字失效。未跑全量或压力测试；生产未改，cwd 本身为别名的 glob 尚不准入。

代码预算：TUI 的预测来源、工具策略、执行路线和存储菜单共用已有 action loop；Drafter 与模式
预测的基础/高级页合并编辑入口，保留动态标签与分级菜单，没有新增中转层。现有层级夹具加入
取消/确认清理和关闭多步后的子菜单刷新。两端 check、各 10 项菜单集成测试通过；生产减少
46 行，相对 485cdb2 累计 −75 行，测试本步 +4 行。未跑全量或高负载回归，grep 生产接入仍待完成。

grep 成本可用 `node --import tsx bench/grep-captured-qualification.mjs --cost-only` 有界复查：
约 1 MB 的两类输入、7 种查询各 3 次；先关闭预测让同一 Host 学到原始 Actor 耗时，再启用预测。
采纳与 fallback 分开报告，后者逐调用断言 Actor 恰好一次且收益门给出拒绝原因，不改生产门槛。
本次 Windows 21 次采纳；WSL 13 次采纳、8 次因收益不足 fallback，说明不能把候选就绪当作收益。
Producer 准备约 Windows 75–103 ms、WSL 29–54 ms，未计作省时；原生/固定配置/Host 成本分别保留。
两端成本探针 37/45 次原生执行全部关闭，目录忽略/失效各补跑一例（8/8），无全量或压力测试。
生产仍 −75 行、常规测试不变；这不是原生默认语义、普遍加速或生产 grep 准入的结论。

进程池租约现覆盖准备、worker 和最终清理，不再只转发 request；受控 find 的捕获/释放及 grep
探针的选择/临时树清理都进入原池的所有权。关闭取消 Producer、等待 Actor，worker 已关闭也
不能删除尚在清理的租约。既有包入口夹具覆盖准备/关闭后清理两阶段；两端各 2 项定向测试及
check 通过，grep 两例语义各 13 次原生执行全关，WSL 四种有界成本查询 25 次全关。
没有全量或高负载测试；本步生产 +10，累计相对 485cdb2 仍 −65 行，grep 生产执行器尚未启用。

三类候选共用初始化：预测、Actor 预览、Actor 观察结果保留各自来源、路由、时序和输出覆盖，
统一序号、reservation 所有权与初始计数，不新增缓存或参数准备。两端原有 Runtime/提交拒绝/
候选状态 45 项及 check 通过，无新增测试、全量或压力测试；生产净减 37，累计 −102 行。

搜索 v4 共用原 worker/进程池及借入输入关闭协议，移除独立 grep worker 和池的额外 entry 参数。
WSL 实测旧 find 的 `~`：K(a) 指向工作区，Actor 却报 `/workspace` 不存在。现将 HOME 固定进
执行身份，键保留已准备的原参数，Pi 路径解析只供资源索引；父 HOME 改变、`@`、文件 URL 均有回归。
私有 grep 路径用文件 URL 传递，避免再次折叠编码后的不换行空格。工具发现入口只授予父进程
已固定的 rg，不在 worker 中探测用户目录或下载；真实 OS 输入错误保留 Pi 行为，缺失权限仍拒绝。
Windows 定向 25 passed / 1 skipped、WSL 26 passed，check 通过。WSL 46 个小语义场景 282 次
原生执行全关；Windows 路径/兼容 13 例分别 38/33 次全关。约 1 MB、三查询各三次成本复查：
Windows 9 次采纳，WSL 5 次采纳及 4 次收益不足的恰好一次 Actor fallback，原生进程 16/20 次全关。
无全量/高负载回归、新依赖或思程改动；生产累计 −34 行。grep 输入准备与 TUI 生产接入尚未完成。

候选索引移除七个纯转发入口：本索引内查询、兼容插入、命中计数和裁剪直接使用原 store；
跨索引迁移、共享/独占分离及分支释放仍归原注册表。两端既有候选索引、Runtime、提交拒绝
45 项与 check 通过；测试未增长、未跑全量/高负载，生产净减 42 行，累计 −76 行。

Git 私有仓库/索引参数由原进程执行函数一次绑定；沙箱与事务共享 regular blob 读取和模式解码，
分别保留 64 MiB 基线文件限制和事务剩余预算。删除重复路径字段和 options 声明，没有增加转发层、
缓存或依赖。生产净减 179 行，本提交相对 485cdb2 累计 −255 行（不含下一步 grep 接入）。
Windows 沙箱/身份定向 20 passed / 4 skipped，WSL 24 passed；同阶段单 worker 全量均 55 文件通过，
Windows 490 passed / 16 skipped、WSL 505 passed / 1 skipped，check 均通过。真实 WSL Bash 小夹具
冷执行 2,991 ms、同父/跨父子进程命中 1,626/1,623 ms，变更输入重新执行；此夹具不声称整个命令
缓存命中。Runtime in-flight 原始 Actor 4,010 ms、采纳 Actor 2,738 ms，第二次 Actor 恰好执行一次，
PID 结果不进入持久历史。每个既有探针仅跑一轮，没有重复压力扫描或 ThinkThread 修改。

受控搜索 v5 已接通生产 grep 和 TUI 的 Captured search：实际接受 Windows x64 rg 15.2.0 /
Linux x64 rg 14.1.0。只读查找已有文件，固定字节后由拥有关闭等待的入口验证版本，不调用会先
同步 spawn 的工具发现函数，不安装依赖。输入 materializer 从 bench 移入既有 Pi 调用所有者，
bench 直接使用生产 profile；原 pool 排空后才删除私有引擎，单调用还等待选择/搜索进程和目录清理。
两端各 46 项小语义案例通过；WSL 最终配置/编码/limit 六例补验通过。独立参考 worker 与取消探针
才进入进程计数，不能据此声称统计了生产全部进程；结果上限与 abort 均证明关闭/借入清理先于结算。
构建后的真实扩展回调两端均走通 find/grep 预测、采纳、TUI 应用、刷新及禁用，无模型网络调用。
旧 portable 夹具改为先发起禁用、再释放暂停输入并等待禁用完成；其宿主观察断言改用 captured-only
合同，而非把 Linux world 的一般观察能力当成该 profile 的权限。生产取消等待没有放宽。

约 998 KB、三种查询各三次成本复查：Windows 9 次采纳，WSL 5 次采纳、4 次因收益不足恰好一次
Actor fallback；Host Actor 中位数 Windows 20.1/26.9/25.3 ms、WSL 4.8/7.4/8.9 ms，采纳/回退混合
探测中位数分别 7.2/6.9/6.2 和 5.8/7.2/6.5 ms。冷 profile 准备 166–276/14–25 ms、Producer
约 473–482/275–290 ms 均单列，不算省时，不声称全任务或原生默认加速。常规全量复用上一个
Git 提交同阶段的两端 55 文件结果；生产接入后相对 485cdb2 仍净减 2 行。没有改依赖、CI 或
ThinkThread 受保护路径；macOS/ARM64 和真实 ThinkThread Runtime 仍未验收，完整目标未提前结项。

关闭边界继续覆盖封存失败：Gateway 跟踪完整事务，而非只等待 Router 的后端执行；共享输出无法
封存时，分支清理完成后才能销毁 world。现有关闭矩阵加入失败封存/失败清理屏障，旧实现已复现
提前关闭，修复后仍拒绝关闭后的新调用，清理错误不替换封存错误。生产行数不增加；此项与
同阶段封存所有权修正共用一轮单 worker 全量，Windows 491 passed / 16 skipped、WSL 506 passed /
1 skipped，各 55 文件；两端 check 及 26 项定向测试通过，不重复压力测试。

封存所有权：原事务改为冻结证据记录和私有状态闭包，删除重复 getter；资源、兼容性和执行指标
在封存时归属事务，验证、重建、提交和清理的方法引用固定，仍以原后端为 `this`。checkpoint
只固定不透明句柄，不复制或冻结后端实例；共享输出仍逐读者复制，独占提交仍可产生新结算，
提交指标继续在提交后读取。旧实现已实测把被事后升级的“不兼容”候选误采纳，现拒绝并恰好一次
执行 Actor；替换验证方法也不能把过期/缺失证明变成有效。并发矩阵另复现后一次验证破坏已预约
提交的时序，现等原提交结算后再验证，不重开提交或隐藏已中毒状态。

最终两端 source/test 共 142 文件哈希一致；check、单 worker 定向及各 55 文件完整测试通过，
Windows 492 passed / 16 skipped、WSL 507 passed / 1 skipped。生产本步净减 62 行，相对 485cdb2
从 32,834 降至 32,770（−64）；测试累计 +229 行，本步扩充现有矩阵，没有新增测试文件。
本阶段封存改造后、追加并发验证门前，原 WSL in-flight 小夹具补跑一次：原始 Actor 4,009.5 ms、
Producer 6,070.0 ms、采纳 2,749.8 ms、后一次 Actor 4,007.8 ms；单消费者采纳、Actor 恰好一次
fallback、PID 不持久化均通过。这只是该路径的 Actor 到达收益，不是冷启动或全命令缓存命中。
没有新增依赖、CI 或修改 ThinkThread 受保护路径；历史代码预算和完整跨平台验收仍未结项。

事务借用在进入后端前登记：旧实现的验证/重建若在同步回调里发起关闭，清理会漏等尚未登记的
Promise；既有屏障矩阵已复现提前释放。现在先登记 Promise 再调用后端，外部关闭和回调内关闭
均等待验证、重建或提交完成，失败和关闭后重入的原有结算不变。生产不增行、不增加生命周期层。
与同阶段 PatternAware 收敛共用一轮单 worker 全量：Windows 493 passed / 16 skipped、WSL
508 passed / 1 skipped，各 55 文件；两端 check/build 与合计 111 项定向测试通过。未重复真实
Bash、grep 成本或压力扫描，先前的资格结果不冒充本次新增验收。

PatternAware 反馈采用同一计数字段定义生成类型、初始值、校验和恢复；公开模式类型由内部模型
派生，只读字段与持久化字段名称不变。公开快照由逐字段六次复制收敛为一次深复制，没有增加
缓存、转发类或持久化版本。两份重复恢复夹具合并为 v17/v18 矩阵，补验每个计数的缺失、null、
负数和非数值，坏上下文/绑定/事件引用，公开快照修改不影响内部状态，以及重新持久化后的反馈
完整性和空坏池。70 项 PatternAware 测试及同阶段双端完整回归通过；生成的声明文件也已检查。
生产本步 −59、测试 −22 行（本阶段含事务测试共 −19），相对 485cdb2 生产 32,711（−123）、
测试 14,441（+210）；两端 142 个 source/test 文件哈希一致。依赖、CI、ThinkThread 受保护路径
均未改；macOS/ARM64 与真实 ThinkThread Runtime 尚未验收，完整目标保持未结项。

跨轮次 PatternAware 租约释放改为同一 Promise：旧布尔标记让第二次 release 在第一次写回尚未
结束时提前成功，也会隐藏第一次的写回失败。现有共享/隔离夹具扩为成功、失败两分支，屏障已
复现旧行为；每个调用者现在等待同一结算，引用只减一次，仍有租约时新获取不会更换存储实例。
释放 Promise 先登记再进入持久化回调，没有增加生命周期所有者。生产本步净减 2 行。
与同阶段合同绑定修正共用一轮单 worker 完整测试：Windows 494 passed / 16 skipped、WSL
509 passed / 1 skipped，各 55 文件；两端 check/build 与定向测试通过。未重复压力扫描、真实
Bash 或 grep 成本探针；这些常规测试不冒充新的收益或 macOS/ARM64 Runtime 验收。

K(a) 在调用规范化回调前固定所选合同及执行绑定。旧实现已复现：回调修改原 profile 的 epoch、
资源范围和执行描述时，旧规范化结果被标记为新版本、新指纹。现在原有规范化入口先归属合同
元数据和方法槽，指纹及不透明上下文句柄也预先固定；后一次调用仍会读取更新后的原始 profile。
私有弱集合仅识别本入口已发出的不可变定义，避免 buildKey → buildActionKey 和重建 K(a) 时
重复归属；不会按可变原对象缓存配置或结果。外部自行冻结的空 tool/epoch 仍须通过完整校验。
现有 grep/find × 两种资源范围夹具覆盖回调内改写、原要求不漂移、原方法保留、更新合同重新
选择与原生注册表不变；重复一致性夹具合并，注册表及直接重建复用已归属定义也有断言。
同阶段双端完整测试已通过，142 个 source/test 文件哈希一致。生产本步 +6 行，累计相对
485cdb2 为 32,715（−119）；测试本步 −9 行，本阶段合计 +1，累计 14,442（+211）。依赖、
CI 和 ThinkThread 受保护路径不变；历史预算继续压缩，完整目标及未具备的跨平台验收保持未结项。

投影合同及覆盖证据进入同一归属边界。旧实现已复现：替换 id/partition/project 会破坏已建立
的索引；替换 projectOutput 会采纳本应拒绝的旧候选；事后改写覆盖对象还能把未覆盖变成可采纳，
或让前一个回调破坏后一个读者。语义注册、Host、Runtime 与索引现在固定同一规则记录及方法槽，
既有来源身份只用于注册冲突检查，不缓存可变原对象；内建投影也不可被外部改写。原提供者对象
仍可修改，新注册仍读取新合同，不冻结提供者的私有状态或宣称固定其函数闭包行为。
覆盖证据复用已有 cloneSharedData：捕获时归属、每次回调单独复制；不透明证明仅拒绝输出投影，
不削弱 sealed-input 重建与前后验证。原重建矩阵保留过期、失败、取消、运行中不覆盖/范围外
拒绝，并扩充五种输出证明分支；另有规则替换、共享来源冲突与索引删除/排序断言，无新增测试文件。
成员与 recency 合并为索引的同一 Map，移除重复 source 转发和未使用夹具参数。生产本步 +4、
测试 +22 行，累计相对 485cdb2 为生产 32,719（−115）、测试 14,464（+233）。两端 142 个
source/test 文件哈希一致；check/build、定向测试及各 55 文件单 worker 完整测试通过：Windows
502 passed / 16 skipped、WSL 517 passed / 1 skipped。未重复压力或真实成本基准；依赖、CI、
ThinkThread 受保护路径不变，macOS/ARM64 与真实 Runtime 仍未验收，完整目标不提前结项。

候选注销现在使用插入时保存的精确/投影桶成员关系，不再调用提供者重新计算删除位置。旧实现
已复现：partition 暂时返回空、抛错或改桶后，已删除候选仍从原桶出现；比较及兼容性回调也能
让已注销的条目继续被选中。原成员 Map 现在同时保存该次注册及 recency，最终排序与准入前后
检查同一注册；同对象删除再插入不会恢复旧注册的选择资格。回调清空或重建作用域后，插入从
当前作用域登记，嵌套插入不再误报新建；重复插入同一结果保留原命中证据，不重置为冷条目。
移除分离的作用域创建和投影增删函数，查询分区只计算一次并沿兼容性查询/插入复用；清理无
提供者回调，没有新增索引或生命周期所有者。回归扩充原投影/精确/保留夹具，没有新增测试文件。
两端 check/build、64 项定向测试及各 55 文件单 worker 全量通过：Windows 502 passed /
16 skipped、WSL 517 passed / 1 skipped；142 个 source/test 文件哈希一致。生产本步 +12 行，
相对 485cdb2 累计 32,731（−103）；测试本步 +65，累计 14,529（+298）。未重复压力或真实
成本基准，ThinkThread、依赖和 CI 不变；完整目标及未具备的 macOS/ARM64 Runtime 验收仍未结项。

共享结果的单次图复制保留所有可枚举数据键，包括 Symbol 键，以及循环、共享引用和稀疏数组；
不再先遍历校验再交给会丢 Symbol 键的 structuredClone。Symbol 值、Proxy、不透明原型、访问器
和隐藏字段仍拒绝，且不会调用 getter 或冻结提供者对象；仅使用 Node 内建能力，没有新依赖。
这不是放弃封存：WSL 的现有稳定读观察夹具接上生产 withPiProjectionCoverage 后，旧实现把
本应复用的第二次读取交给 Actor，因为读覆盖元数据的 Symbol 键导致封存失败。现在封存、借出、
重建及提交都保留该数据图；Windows 原有宿主观察限制不变，未修改 ThinkThread 受保护路径。

输出投影复用同一归属函数，在二次验证/提交前复制提供者返回的视图；封存输入重建已经归属，
不重复复制。旧端到端回归已复现：提供者在后验证时改写结果、前一 Actor 修改后污染下一读者，
以及不透明投影被采纳。现在前两者仍给出独立的原生读结果，后者不提交并恰好一次 fallback。
投影复制计入原投影耗时；既有关闭所有者也通过暂停投影屏障，先排空调用再关闭 world，无需新层。
两端 check/build、各 102 项定向及 55 文件单 worker 全量通过：Windows 506 passed / 16 skipped、
WSL 521 passed / 1 skipped。142 个 source/test 文件哈希一致；生产本步 +7，累计 32,738（−96），
测试本步 +83，累计 14,612（+381）；未新增测试文件。未重复原生成本或压力扫描，既有 Bash/grep
收益记录不冒充本次测量；依赖、CI 不变，完整目标及 macOS/ARM64、真实 Runtime 验收仍未结项。

原 RuntimeLifecycleLane 的释放登记也提前到清理回调之前。直接探针及既有关闭夹具均已复现：
dispose 同步重入 release 时，旧记录尚未登记，导致同一资源清理两次且返回不同 Promise。
现在原 WeakMap 和工作集合先登记同一次释放，外部、重入及清理后的调用者均加入它，不新建
生命周期所有者。成功/失败清理合并进原关闭矩阵，保留同步封门和 close 合并断言，并验证关闭
回调自身结束后仍等待资源；清理错误仍不替换 Actor 结算。生产本步不增行、测试 +18 行。
两端 check/build、各 77 项定向及 55 文件单 worker 全量通过：Windows 507 passed / 16 skipped、
WSL 522 passed / 1 skipped；142 个 source/test 文件哈希一致。相对 485cdb2 生产仍为 32,738
（−96），测试 14,630（+399）；无依赖、CI 或 ThinkThread 受保护路径修改，无新增原生成本或
压力测量。完整目标保持未结项，未具备的 macOS/ARM64 与真实 Runtime 资格不由这些回归替代。

计划物化现在先捕获 proposal/delta 头、删除集合、全部动作字段和依赖记录，再复制输入图。
旧实现已复现：输入 getter 可把已校验 revision 改成 −1、改写动作身份和后续依赖，或更改
本次 delta 的删除集合；Runtime 还会把已接受的 3 token 事后记为 99。回归合并进原身份/key
绑定夹具，覆盖两种更新、输入只读取一次、原提供者可变与不透明反馈仍由提供者持有。
原依赖夹具也证明，修改暴露记录会让等待 Actor 采纳的子任务提前可匹配；现有跨轮次 Runtime
夹具的真实 preflight 回调同样复现了依赖改写。现在依赖条目与数组一并冻结，默认条件仅在
捕获时规范化；读取直接使用条件，修订比较只排序数组副本，不再重建记录。等价的依赖顺序/
默认条件更新仍保留原执行身份，子任务在父预测 miss 后的有效结果仍可跨轮次采纳。
草稿接口从 PlanAction 派生且保留原字段集合；后台调度本来就读取计划节点，本步没有把它
误判为缺失字段，也不新增草稿转发或生命周期所有者。未新增测试文件；生产本步 −24 行，
累计相对 485cdb2 为 32,714（−120），测试本步 +72，累计 14,702（+471）。
两端 check/build、各 162 项定向及 55 文件单 worker 全量通过：Windows 508 passed / 16 skipped、
WSL 523 passed / 1 skipped；142 个 source/test 文件哈希一致。按低负载要求串行验证，没有
额外重复原生成本或压力基准；依赖、CI、ThinkThread 受保护路径不变。完整目标仍未结项，
macOS/ARM64 和真实 ThinkThread Runtime 验收仍未具备，不能由本次结构回归替代。

预测请求的准入等待与物理生产完成也分开归属。旧关闭矩阵已复现：初始预测、continuation 的
请求在取消后已结算，但 producer 仍停在 finally 清理屏障，关闭却先返回。现在原 sourceTasks
集合同时保留这两种生产回调返回的 Promise；超时或取消仍及时结束准入，完整关闭则等待
实际退出和晚到失败，不新建生命周期所有者。忽略 AbortSignal、尚未返回的 producer 仍会
阻止完整关闭；超时不是退出证明。原关闭矩阵扩充 disable/dispose、超时后的 terminal 关闭，
验证清理恰好一次、晚到结果不执行、晚到拒绝被容纳，并保留终止轮次的共享结果。
取消早于 producer 微任务时也不再调用生产者。生产 Host 的原短上下文夹具加入模型/选项准备
屏障，复现了取消后仍发起一次模型调用；Drafter 现在在异步准备结束后检查本次请求的 signal。
共享 batch 结构未变。短上下文断言改为等到实际请求结算，避免尚未启动就判通过；模型调用为
mock，没有联网或把它宣称为真实 ThinkThread Runtime 资格。
两端 check/build、各 151 项定向及 55 文件单 worker 全量通过：Windows 516 passed / 16 skipped、
WSL 531 passed / 1 skipped。142 个 source/test 文件哈希一致；生产本步 +4，累计相对 485cdb2
为 32,718（−116）；测试本步 +35，累计 14,737（+506），没有新增测试文件。完整测试按平台
串行，未额外重复原生收益或压力基准；ThinkThread、依赖、CI 受保护路径不变。完整目标及
未具备的 macOS/ARM64、真实 ThinkThread Runtime 验收仍未结项。

continuation 的启动权限现在在排队完成后、领取 source slot 前重新核验。既有跨轮次夹具已
复现三种旧实现失败：execution_succeeded 请求占位时排入 actor_adopted，随后目标决策到达、
正常 observe delta 替换父动作，或 terminal 关闭开始；先前请求退出后，旧父回调仍会取得新
slot 并启动。现在检查原计划动作身份与目标决策，关闭则在等待 producer 前撤销剩余计划和
启动定时器。复用原计划、请求槽和 sourceTasks，不新增关闭标记或生命周期所有者；物理生产
清理仍完整等待，terminal 对独立共享结果的保留不变。
原跨轮次夹具同时保留正常延续，以及首个 continuation 返回空值后仍有效的第二触发重试。
原提交错误夹具改为真实 EffectTransactionCoordinator 的屏障矩阵：terminal/dispose 在提交
已占用时开始，Actor 仍得到一次结果、一次 adopted 结算和一次清理，不再启动后续预测；
poisoned 提交错误仍向上传递，不能授权 fallback。关闭撤销的是计划启动权限，不是已占用
的事务提交权。本次没有新增测试文件；生产本步 −2 行，测试 +51 行。
两端 check/build、各 104 项定向及 55 文件单 worker 全量通过：Windows 522 passed / 16 skipped、
WSL 537 passed / 1 skipped；142 个 source/test 文件哈希一致。累计相对 485cdb2 生产 32,716
（−118），测试 14,788（+557）。依照低负载要求两端顺序验证，无额外原生成本或压力扫描；
ThinkThread、依赖和 CI 受保护路径不变。完整目标仍未结项，既有 Bash/grep 成本记录不是本次
重新测量，缺失的 macOS/ARM64 与真实 ThinkThread Runtime 验收也不能由结构回归替代。

批量准入与动作就绪不再共用一个最慢完成屏障。旧并发夹具扩充后复现：只返回一个多动作
计划时，快动作会等待慢 K(a) 绑定；返回多个计划的数组或 observe 批次时，独立计划也被
前一计划阻挡。原测试中另一独立请求完成后的全局调度掩盖了前一种情况。
原 admitUpdate 扩为批量准入核心，预测、continuation 和观察更新直接进入同一实现；各计划
同时登记在原 planAdmissionTails，只有相同计划继续串行。每个动作物化结束即调用既有调度，
而批次和物化的 allSettled 仍等待所有已登记 Promise；空更新也保留原调度收敛。不新增队列、
生命周期所有者或绕过 Router、权限与收益准入。计划身份与执行绑定的归属规则不变。
原 Runtime 夹具覆盖独立请求、单计划、批次、同计划 proposal 修订及 observe delta；屏障
证明慢绑定未完成时独立动作已执行、后续修订尚未开始绑定，解除后可采纳最新动作。原生产
Host/ActorFork 集成夹具还暂停一个 sibling 的权限检查，确认另一动作先执行，暂停动作没有
启动。此处 sidecar 仍为 mock，工具耗时是夹具模拟，不是新的原生成本或真实 Runtime 资格。
两端 check/build、各 118 项定向及 55 文件单 worker 全量通过：Windows 526 passed / 16 skipped、
WSL 541 passed / 1 skipped；142 个 source/test 文件哈希一致。生产本步 −9 行，累计相对
485cdb2 为 32,707（−127）；测试本步 +12，累计 14,800（+569），没有新增测试文件。完整测试
按平台串行，无额外压力或原生成本扫描；ThinkThread、依赖和 CI 不变。完整目标保持未结项，
macOS/ARM64 与真实 ThinkThread Runtime 仍未验收，既有 Bash/grep 收益记录不冒充本次测量。

预测启动的复用验证也归入原 RuntimeLifecycleLane：先登记 Promise，再进入查询和后端回调，
验证前后核验当前计划节点身份及未结算状态。旧缓存世代夹具已复现 disable、dispose、terminal
在验证期间撤销计划后仍多执行一次旧动作；正常 observe delta 替换节点时，旧结果还会绑定
到新节点、使替换动作不再执行。这四种情况现在停止旧启动，原正常刷新仍产生并采纳新世代。
同一夹具还通过下一轮的真实缓存字节预算淘汰正在验证的结果，证明晚到 valid 曾重新绑定
已退休缓存并阻止新执行；复用选择现在只返回仍由原候选注册表持有的实例，不重新插入旧结果。
七场景矩阵复用真实 EffectTransactionCoordinator，并保留一个未包装 WorldBranch 适配器：
仅去掉启动任务登记、保留身份检查的对照仍会提前关闭；恢复登记后，完整 dispose 等待验证
完成，清理次数与实际执行次数一致。terminal 对已执行共享结果的保留不变，不把取消当作
物理退出，也不撤销已占用的 Actor 提交。移除启动阶段对原输入形状的重复检查；物化时的
检查和已绑定的不可变 K(a) 仍在，执行只使用该绑定。没有新队列、生命周期所有者或依赖。
两端 check/build、各 122 项定向及 55 文件单 worker 全量通过：Windows 532 passed / 16 skipped、
WSL 547 passed / 1 skipped；142 个 source/test 文件哈希一致。生产本步 −1 行，累计相对
485cdb2 为 32,706（−128）；测试本步 +38，累计 14,838（+607），没有新增测试文件。按平台
串行验证，无额外压力或原生成本扫描；ThinkThread、依赖和 CI 受保护路径不变。完整目标仍
未结项，macOS/ARM64、真实 ThinkThread Runtime 验收及本次未重测的原生收益范围如前。
