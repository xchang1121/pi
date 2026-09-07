# 发布资格与清理记录（2026-09-03；2026-09-07 补充）

## 2026-09-07：执行层级与思程接入复审

追加：工作区查询依赖已统一。思程不再按工具名维护另一份 dependency scope；沿用 resource
语义，并将 SDK 不支持的 `tree_query` 保守提升为 `tree_content`。补上 `.fdignore` 内容以及
搜索子目录的父级忽略规则依赖。修复前两项确定性反例均错误地返回未过期；修复后在关闭
watcher 的真实 WSL Pi `grep/find` 中，忽略规则变化使输出从命中变为无匹配，旧证据正确失效。
Windows 499 passed / 13 skipped，WSL 511 passed / 1 skipped；生产净减 6 行、测试净减 3 行。
本项只证明工作区内规则，不补足工作区外全局配置、可执行文件等隐式依赖的证明；这些仍须
纳入真实 Runtime 资格检查，不能把本地 runner 一致性当成任意环境下安全复用的证明。

新增实测入口 `npm run bench:thinkthread-tools`（见 `bench/README.md`），六工具夹具从测试迁到
共用资格代码，不另写一套 mock benchmark；测试文件净减 130 行。入口先验证真实 SDK 连接，
随后要求确实选中思程路线、走统一事务并比较提交前隔离和提交后完整夹具效果。Windows、
普通 WSL、仅设置 `THINKTHREAD_FS` 的 WSL 均明确拒绝且未创建夹具；这只是失败关闭验证，
**不是六工具真实思程资格通过**，更不是 Bash 在思程中的性能数据。

当前结论：核心执行层级已修正，**真实思程 Runtime 资格尚未完成**。下文旧记录保留为历史，
不能用早期 SDK mock、安装布局测试或原生 WSL benchmark 推断真实思程执行与采纳已经通过。

架构仍保留五个状态所有者：Router 选择能力与执行路线；Runtime 管候选和调度；
EffectTransaction 管验证/提交/poisoned；WorkspaceSandboxService 管工作区事务；
ProcessExecutionCoordinator 管进程出口。普通候选缓存与 Bash certificate/CAS 沿用原实现，
没有第三套缓存。81 个生产 TS 模块、309 条静态内部依赖，未发现循环。

修正了以下边界：

- 删除思程独立 Actor 结果捕获：快照内容相等不能证明执行窗口没有 A→B→A；复用现有
  resource observation 的身份、change stamp 与窗口证明。测试确认变化时保留 Actor 输出但不缓存。
- 层级开关只管新的提前执行，不阻断 Actor 结果复用；Router 同时负责选择和执行前的策略检查。
  预热保留工具作用域，避免只启用读工具却初始化 Bash 后端。没有增加按工具分叉的出口。
- 思程缓存的是 client/pool，不再把旧初始化成功当作永久可用；每次选路检查当前 attachment，
  覆盖初始化后断连降级。跨 provider 的私有 checkpoint 仍由 Runtime 延后处理，不混用分支。
- Apply 等待路由诊断；关闭后再启用、初始化失败后刷新、Runtime 断连后刷新均覆盖。
  思程 turn 登记保持内存操作，不因中途打开层级而丢失回合。关闭插件不启动 native probe/helper。
- SDK payload 上传与 durable run 重试分开：同一逻辑调用不重复上传；上传期间取消不再启动 runner。
  恢复出的 cancelled 结果保留 TARGET ID，交回原分支清理，避免丢失快照所有权。

### 逐工具证据范围

| 工具 | 原生后备 | 思程路线 | 本机已验证 |
| --- | --- | --- | --- |
| read | Actor 执行后观察复用，不提前执行 host function | fs.run | 本地 runner 序列化输出与 Actor 一致 |
| grep | 同上 | fs.run | 本地 rg 结果一致 |
| find | 同上 | fs.run | 本地 fd 结果一致 |
| ls | 同上 | fs.run | 本地目录输出一致 |
| write | Git 工作区投机/提交 | fs.run + fs.apply | 本地 runner 与真实 Git 后备输出、夹具文件效果一致 |
| edit | Git 工作区投机/提交 | fs.run + fs.apply | 同上 |
| bash | Linux process world，能力不足则 Actor | 当前 fs.run provider 不接收；尝试原生后备 | 真实 WSL 投机、复用、采纳通过，未在思程中实测 |

前六项比较调用了真实 Pi 实现并通过 runner wire 编解码，但**没有运行思程 fs.run**。
read/grep/find/ls 的 Actor 观察不能称作“独立 fallback 提前投机”。SDK mock 对冲突、
durable completion-unknown、取消清理的覆盖也不等同于真实 Runtime 资格。

### 真机与包边界

- Windows：495 passed / 13 skipped；check、build、bench:check、pack dry-run 通过。
- WSL 2：507 passed / 1 skipped；check、build、bench:check 通过。原生进程与 in-flight benchmark 的输出、
  文件效果、输入变更 miss、单次 Actor fallback 和单消费者采纳断言通过。
- 原生 Bash 冷执行 / 跨父命令复用：3494.33 / 1869.02 ms = **1.870×**。
  Actor 基线 / 到达后 in-flight 采纳：4009.00 / 2782.35 ms = **1.441×**，缩短 1226.65 ms。
  这是两个不同口径的本次样本，不是所有任务的加速下界；历史 **1.83×** 口径保留。
- Capsule `c7e4158` 的真实 Agent POSIX SDK：check、12 项上游测试和 tgz 构建通过。
  安装器携带该 tgz 在前置检查明确失败：`the current ThinkThread tt binary is unavailable`，
  尚未完成真实 Profile 安装/启动资格，未用替代 tt 命令冒充通过。
- 本轮相对 `7184098` 生产源码净减 61 行、测试净减 64 行（不包含远端独立的 benchmark 提交）。
  按 `rg --files src` 的全部文件物理行计数，当前仍有 33,154 行；原先 30,411 行的全仓目标未达成。

公开 alpha2 Runtime 只有 aarch64 包，本机为 x86_64，用户也没有额外 ARM64 主机或 x86 Runtime。
现有 Actor held-exec 又限定 x86-64，不能宣称思程中自动保有全部原子能力。公开 fs.run 继承
Profile 网络授权、没有单次网络收窄，时间/随机数仍真实，且不暴露可接管的子进程资源。
因此“统一调用出口”是可行的架构角色，但不自动证明任意 Bash 可安全提前执行、部分复用或无损采纳。
后续真实验收必须在同一可运行思程环境中比较原生与思程路径、验证隔离/依赖/冲突与嵌套 helper，
再报告两套计时；目前不能保证思程性能不低于原生，也不应通过放宽能力声明实现表面命中。

## 2026-09-03 历史记录

本轮从执行权限、文件证据、进程观察、事务提交、进程出口和指标口径六个边界关闭了
审计问题；代码资格基线为前序 benchmark 清理提交。

## 验证结果

- Windows：类型检查、benchmark 类型检查、构建和 `npm pack --dry-run` 通过；477 项测试中
  466 项通过，11 项按平台或缺失的 Linux 能力明确跳过。
- WSL 2 / Ubuntu 24.04：类型检查与 477/477 测试通过。
- 真实 held-exec：已完成子进程命中约 29 ms；首次 Actor 对照尚未校准，因此只报告
  约 468 ms 被消除的进程工作，不伪造关键路径收益。
- 真实运行中认领：Actor 约 107 ms，估算直接执行约 203 ms，关键路径约缩短 102 ms。
- 真实跨父 Bash：冷执行约 3078 ms，复用约 1680 ms，约 1.83 倍；输入变化时正确 miss。

## 清理结果

- 删除无生产调用方的 `artifact_seed` 分支、两个废弃公共导出和重复的 executable、路径及
  Unix socket helper；生产源码净减 106 行，测试夹具净减 8 行。
- 删除已被架构否决的私有 OverlayFS namespace 实验及命令入口。
- 删除 105 份无人读取的逐次 JSON；审阅后的聚合结论和复现命令保留，后续原始输出默认
  写入忽略文件或仓库外。相对指标重构提交 `f1183a4`，本轮总计净减 14,722 行。
- TypeScript 开启未使用局部变量和参数检查；平台相关用例改为显式能力门禁，避免跨平台假通过。

## 静态审计

- 72 个生产 TypeScript 模块无循环依赖；唯一孤儿 `index.ts` 是包入口。
- `knip` 唯一保留项是 Pi 通过 manifest 动态加载的 `extension.ts` 默认导出。
- 生产 TypeScript 重复率为 0.06%。余下两处短重复分别是上下文对象和数值校验；跨域抽取
  会增加参数面或层间耦合，因此保持局部实现。
- 477 项测试覆盖不同的行为边界；重复扫描为 0.57%，主要是刻意内联的测试数据和失败断言，
  删除会降低单测独立可读性而不会减少生产复杂度。

## PR #1 合入资格

- 冲突没有保留 PR 新增的平行提交异常；ThinkThread 的可恢复冲突直接进入既有
  `EffectTransaction`，未知或部分提交仍统一标记为 poisoned，禁止 Actor 二次执行。
- execution world 增加通用工具作用域。ThinkThread 只提前执行不依赖外部进程的
  `read`、`ls`、`write`、`edit`；`grep`、`find` 保留 Actor 执行和快照结果复用，Bash
  保留原 Linux process world / Actor 路径。TUI 的 Fork 与 Observe 状态据此分开计算。
- Agent POSIX SDK 固定到公开仓库 `v0.1.0` 的
  `e7287acc187b4b17a9d2a0c8cad2f75f64ed538f`；修复 npm 11 跳过 optional peer 的源码构建，
  Windows 与 WSL 2 使用同一安装和校验流程完成本地资格测试。
- 合入树在 Windows 上 505 项通过、11 项明确跳过；WSL 2 原生文件系统 516/516 通过。
  独立临时 HOME 中的完整 Profile 安装通过。
- 合入后的真实跨父 Bash 冷执行约 2944 ms，复用约 1680 ms，约 1.75 倍；依赖变化仍会
  强制 miss。80 个 TypeScript 模块无循环依赖，生产重复率保持 0.06%。
