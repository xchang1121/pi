# 发布资格与清理记录（2026-09-03）

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
