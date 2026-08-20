# Pi speculative action

这个 package 在不修改 Pi 本体的前提下加入投机工具执行。Drafter 与 PatternAware 预测未来工具调用；只有存在可证明安全的隔离路线时才提前执行；Actor 发出等价动作后可以采纳对应结果。

## 架构

Runtime 分为四个相互独立的层次：

1. **投机源**：Drafter 与 PatternAware 只产生与执行方式无关的 `PlanAction`。
2. **动作身份**：`K(a)` 规范化工具语义、已验证 schema、参数、资源与实际执行器身份；无损投影规则可以证明一个结果覆盖另一个动作。
3. **执行路由**：统一解析器选择隔离能力。所选路由刻意不进入 `K(a)`。
4. **调度与结算**：Scheduler 决定启动时机与资源竞争；`ExecutionWorld` 管理隔离执行和采纳；唯一的结算生命周期记录匹配、采纳、回退与计时。

执行路线具有固定优先级：

| 优先级 | 路线 | 范围 |
|---|---|---|
| 1 | `runtime_sandbox` | 注入的 Runtime 全局沙箱；对所有启用工具优先 |
| 2 | `resource_snapshot` | `read`、`grep`、`find` 的本地后备，通过资源版本证据保证新鲜度 |
| 2 | `file_mutation` | `write`、`edit` 的本地后备，在私有 Git worktree 中执行并进行冲突检查后提交 |
| 3 | Actor 回退 | 没有安全路线时完全不发起投机工具执行 |

本 package **不再内置进程沙箱**。因此默认 Pi 扩展仍可预测并匹配 `bash`，但不会投机执行 Bash；命令由 Actor 通过 Pi 正常路径执行。嵌入式 Runtime 可以注入支持 `runtime_sandbox` 的 `ExecutionWorld`，一次性为 Bash 和其余工具提供隔离。

这样，未来 OS 层面的 Agent Runtime 只需接入一个完整执行世界，不需要 Pi 针对每种工具分别维护隔离实现。

## 正确性边界

- 投机源不能选择执行后端。
- 隔离后端变化不会改变 `K(a)`。
- 进行中任务和缓存只在相同执行 route 内复用。
- Actor 采纳仍必须依次通过动作等价、权限、资源新鲜度、World 兼容性、投影与提交检查。
- 同时缺少 Runtime 沙箱和已注册本地后备的工具会被标记为 execution-blocked，但仍可参与匹配、学习和反事实计时。
- 同名自定义工具保持权威；除非宿主显式提供一致的语义与执行能力，否则不会参与投机。

`read` 支持由真实输出覆盖范围证明的无损区间投影；`grep` 和 `find` 暂时只做精确 K(a) 匹配。

## 在 Pi 中运行

在仓库根目录构建：

```sh
npm install
npm run build -w @earendil-works/pi-speculative-action
```

加载 package：

```sh
pi -e ./packages/speculative-action
```

在 TUI 中打开 `/speculative-action`。菜单按投机源、调度/缓存、工具/执行分级；工具标签会说明本地后备机制。不存在隔离路线时始终回退 Actor。

配置由 package 自己管理：

- 全局：`<agent-dir>/speculative-action.json`
- 项目：`<workspace>/.pi/speculative-action.json`

示例：

```json
{
  "enabled": true,
  "draftModel": "deepseek/deepseek-chat",
  "candidateLimit": 8,
  "maxConcurrentActions": 8,
  "drafterMaxTokens": 128,
  "tools": ["read", "grep", "find", "bash", "write", "edit"],
  "patternAware": {
    "enabled": true,
    "multiStepEnabled": true
  }
}
```

旧的 `resourceCached` / `sandbox` / `predictionOnly` 三组对象仅作为迁移输入继续识别，读取后统一规范化为一个 `tools` 数组。

## 接入 Runtime 沙箱

宿主通过 `executionWorlds` 提供有序的执行世界。Runtime 全局沙箱声明 `supports("runtime_sandbox")`，能够为任意工具创建隔离 branch。每个成功后端——包括内置资源快照和 Git worktree 后备——都返回同一种 `WorldBranch`，由 branch 自己拥有兼容性证据、新鲜度校验、采纳与清理。宿主在未注册资源快照后端时会自动补上内置实现。

```ts
createSpeculativeActionHost(sessionID, {
  cwd,
  executionWorlds: [runtimeSandbox, createWorkspaceSandbox()],
  // 省略模型、权限与工具接入
})
```

第一个支持 Runtime 全局沙箱的 World 对所有工具生效；不存在时，解析器才检查工具注册的本地后备。两者都不存在时返回空 route，Runtime 将其结算为 `execution:isolation_unavailable` 并回退 Actor。

## 计时口径

对被采纳的结果：

- `attemptLeadMs`：投机意图产生到 Actor 调用被拦截。
- `executionAheadMs`：拦截前已完成的投机执行量，上限为实测工具时长。
- `hitLatencyMs`：Actor 调用被拦截到权威结果完成结算。

对因为缺少隔离而阻断的匹配，Actor 执行仍是唯一权威执行，但使用相同分解报告反事实潜力：

```text
executionBlockedPotentialHiddenLatencyMs = min(actorDuration, predictionLead)
executionBlockedPotentialHitLatencyMs    = actorDuration - potentialHidden
```

这些反事实值不会计入真实投机命中数，也不会混入真实隐藏时延。

## 验证

```sh
npm run build -w @earendil-works/pi-speculative-action
npm test -w @earendil-works/pi-speculative-action
npm run bench:check -w @earendil-works/pi-speculative-action
```

单轨迹消融方法见 [bench/README.md](./bench/README.md)。
