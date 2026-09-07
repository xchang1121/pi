# 发布资格与清理记录（2026-09-03；2026-09-07 更新）

## 2026-09-07：本轮修复与验收边界

本轮代码范围为 `6fc9f1f..cdc8077`，18 个独立提交均推送到
`xchang1121/pi:speculative-action`。未新增 CI、第三套缓存或 SDK 分叉。
以下是当前结论；后面的旧记录不能替代本轮资格证据。

### 已修正的不变量

- **提交所有权**：EffectTransaction 在验证期间就保留同一提交 Promise；并发调用只提交一次。
  held-exec 的不可逆交接覆盖整个 Actor 调用，helper 在输出与退出替换完成后确认；
  交接后的失败统一 poisoned，停止进程树，不再继续 Actor 或重复执行。
- **文件证据**：资源键调用已安装 Pi 的路径解析实现，不再维护另一套 `@`、Unicode、
  Windows 路径规则。资源与 provenance / workspace 共用描述符捕获；拒绝符号链接和特殊文件，
  FIFO 不会在类型检查前阻塞。取消隐藏目录豁免和无界版本 Map，沿用有界观察日志。
- **观察与预测解耦**：关闭某个工具或全部工具的预测，仍保留权威 Actor 结果的观察、验证及
  跨轮次缓存；没有增加平行缓存。
- **队列与生命周期**：设置写入记录失败但不毒化后续队列；临时文件有独立所有权。
  调度样本复用现有有界 LRU，避免长流程无限保留身份。
- **思程连接与恢复**：使用 SDK 的 Transport 接口补上帧上限、EOF、绝对连接期限和取消清理。
  durable 调用沿用同一 request ID，取消后不重新投递；恢复等待有界，完成状态不确定时保留
  request ID 并拒绝盲目重跑。BASE 直接由 ExecutionScope 获取，不再依赖世界/插件两份活动回合状态。
- **思程契约**：删除无依据的重复 Runtime epoch 和不可达的 Bash 环境转发。
  路线指纹绑定 runner 与实际执行选项；Runtime run key 仍由 SDK / Runtime 自己证明。
- **安装事务**：替换前先登记回滚所有权，逆序恢复；恢复失败时保留备份，不删除救援数据。
  没有复制 Capsule 源码，也没有将可选 SDK 变成默认运行时依赖。
- **进程证据发布**：输出端点只在 spawn 成功事件后采集；采集失败是有原因的证据结果，
  不产生无人消费的 rejected Promise。端点不匹配保留期望/实测值。原生并发测试同时覆盖
  PID 先可见、FD 尚未发布的交错：旧实现确定失败，新实现通过，未另增测试场景。

Git / OverlayFS 两份时间围栏也已合并：同一私有描述符的身份在写入前后验证，
等待预算使用单调时间，资源时间戳仍独立比较；时钟不推进时继续拒绝证书。
[Linux 时间戳文档](https://cdn.kernel.org/doc/html/latest/filesystems/multigrain-ts.html)
说明跨文件排序有前提，系统实时时钟回退可能破坏排序。因此本轮没有通过改时间戳、
延长任意睡眠或放宽等价校验来“保证命中”，也不能仅凭复跑通过认定所有宿主时钟问题都已消失。

### 明确收窄的能力

真实 Pi `grep/find` 会读取工作区外 rg/fd 配置，rg 配置还可以启动预处理进程。
仅验证工作区文件无法证明它们的完整效果。本轮将二者归入已有的完整进程能力要求，
删除伪静态资源证明，并拒绝空依赖证据；没有追加配置文件黑名单。

| 工具 | 当前原生后备 | 当前思程 provider |
| --- | --- | --- |
| read / ls | Actor 执行后的稳定窗口观察与跨轮复用 | 声明 fs.run 能力，真实 Runtime 资格待验证 |
| write / edit | Git 工作区分支及事务提交 | 声明 fs.run / verify / apply 能力，真实资格待验证 |
| grep / find | 默认由 Actor 执行，不再用不完整快照缓存 | 不提前执行；需要完整进程依赖与效果证明 |
| bash | 原有 Linux process world、certificate/CAS、Actor replay | 不声称具备完整进程效果证明，继续原生后备 / Actor |

TUI 沿用同一能力模型显示 Predict / Replay / Observe / Fork 与执行层级。
思程不可用不会阻断原生后备，预测开关也不等同于 Actor replay 开关。
“统一工具出口”是路由角色，不等于所有工具已经获得安全提前执行权限。

### 本机验证

- Windows：55 个文件，**506 passed / 16 skipped**；check、build、bench:check、
  pack dry-run 和 tgz 构建通过。
- WSL 2 x86-64：55 个文件，**521 passed / 1 skipped**；check 和原生 helper 编译通过。
  process、inflight、artifacts、topology、exec-boundary 的真实路径均在本轮运行。
- Bash 冷执行 / 同父复用：3081.16 / 1666.91 ms = **1.848×**；
  冷执行 / 跨父复用：3081.16 / 1517.89 ms = **2.030×**。
- Actor 基线 / 到达后的运行中采纳：4009.32 / 2705.47 ms = **1.482×**，缩短 1303.85 ms。
  128 MiB artifact 的冷执行 / 复用中位数约 **1.168×**。这些是不同口径的样本，
  不是所有任务的加速下界；历史 **1.83×** 的“冷执行 / 复用执行”口径保留。
- exec-boundary 连续三轮的结果、文件效果与单次结算检查通过：两轮运行中接管，
  一轮 Actor 执行。固定提前 400 ms 不保证应该 join；Actor 分支明确不显示命中或省时。
  输出采样也改为等 stdio close，避免只等 exit 就截断尾部。
- 首轮 100 次短进程探针出现 3 次变化时钟拒绝；后续长跑仍见一次安全 bypass，
  拓扑 benchmark 将其定位到输出端点不匹配。修正发布边界后，拓扑路径通过，
  **100 次独立短进程证书探针全部通过**。此记录不构成“任何宿主下永无 false miss”的保证。
- 真实 Capsule `c7e4158` SDK 生成 tgz，与插件及固定 Pi peers 安装到临时目录。
  已验证默认入口不加载 SDK、opt-in 入口可加载、公共入口可调用，以及打包后
  read/ls/write/edit runner 的实际文件效果。安装事务另有真实 shell 故障注入；
  这些均不冒充 fs.run 的 Runtime 测试。

### 尚未完成的资格与规模目标

公开 Capsule 仍只有 ARM64 Runtime，本机 x86-64，用户没有额外 Runtime / ARM 主机。
因此 **真实思程 Profile 启动、fs.run 隔离、fs.apply 冲突与崩溃恢复、思程内 Bash 的采纳及收益**
仍未验收；不声称已证明它们与原生后备性能相同或更快。

本轮相对 `6fc9f1f`，生产源码净 **−52 行**、测试净 **−64 行**。
合并了普通入口 / 思程入口的 Actor 缓存旅程和重复夹具，新增故障模型替换或加强已有测试。
按全部跟踪文件物理行计，当前 `src` 为 **33,096 行**，`test` 为 **15,330 行**；
本轮没有净膨胀，但历史全仓 30,411 / 约 14,000 行目标不能标为已达成。

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
