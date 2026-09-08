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
仍未提供搜索进程入口。两端已有 rg 的 stdin 实验表明，直接拼接 UTF-8/UTF-16 文件会丢失匹配，
无末尾换行也会破坏文件边界；JS RegExp 则不接受 rg 的 `(?P<name>...)`，不是同一语法。
不以这两种快捷替代宣称完整 grep；下一步需保留真实引擎和文件边界，并复用此输入工作所有权。
