# Pi speculative action

这个独立 package 在不修改 Pi 本体的前提下加入投机工具执行。Drafter 与 PatternAware 预测未来工具调用；只有存在可证明安全的隔离路线时才提前执行；Actor 发出等价动作后可以采纳对应结果。

本仓库刻意与 Pi monorepo 解耦：它拥有独立的 Git 历史、构建配置、测试和依赖锁。对 Pi 的依赖仅限于以 peer 形式声明的已发布公共扩展 API；不导入 Pi 源码工作树、不使用 workspace 路径别名，也不要求存在对应的 `main` 分支。

仓库沿用历史 URL `xchang1121/pi`，但其所有可达历史都只投影 speculative-action 相关改动，不再包含 Pi monorepo 父提交或源码树。

## 架构

Runtime 分为四个相互独立的层次：

1. **投机源**：Drafter 与 PatternAware 只产生与执行方式无关的 `PlanAction`。
2. **动作身份**：`K(a)` 规范化工具语义、已验证 schema、参数、资源与实际执行器身份；无损投影规则可以证明一个结果覆盖另一个动作。
3. **执行路由**：动作语义只声明可观察效果，由唯一的 `ExecutionWorldRouter` 选择并准备隔离能力。所选路由刻意不进入 `K(a)`。
4. **调度与结算**：Scheduler 决定启动时机与资源竞争；`ExecutionWorld` 管理隔离执行和采纳；唯一的结算生命周期记录匹配、采纳、回退与计时。

执行路线具有固定优先级：

| 优先级 | 路线 | 范围 |
|---|---|---|
| 1 | `runtime_sandbox` | 注入的 Runtime 全局沙箱；对所有启用工具优先 |
| 2 | `resource_snapshot` | `read`、`grep`、`find`、`ls` 的本地后备，通过资源版本证据保证新鲜度 |
| 2 | `workspace_branch` | `write`、`edit` 的本地后备，在私有 Git worktree 中执行并进行冲突检查后提交 |
| 3 | Actor 回退 | 没有安全路线时完全不发起投机工具执行 |

本 package **不再内置进程沙箱**。因此默认 Pi 扩展仍可预测并匹配 `bash`，但不会投机执行 Bash；命令由 Actor 通过 Pi 正常路径执行。嵌入式 Runtime 可以注入一个 runtime scope 的 `ExecutionWorld`，一次性为 Bash 和其余工具提供隔离。

这样，未来 OS 层面的 Agent Runtime 只需接入一个完整执行世界，不需要 Pi 针对每种工具分别维护隔离实现。

## 正确性边界

- 投机源不能选择执行后端。
- 隔离后端变化不会改变 `K(a)`。
- 进行中任务和缓存只在相同执行 route 内复用。
- Actor 采纳仍必须依次通过动作等价、权限、资源新鲜度、World 兼容性、投影与提交检查。
- 同时缺少 Runtime 沙箱和已注册本地后备的工具会被标记为 execution-blocked，但仍可参与匹配、学习和反事实计时。
- 同名自定义工具保持权威；除非宿主显式提供一致的语义与执行能力，否则不会参与投机。

`read` 支持由真实输出覆盖范围证明的无损区间投影；`grep`、`find` 和 `ls` 暂时只做精确 K(a) 匹配。

## 安装与运行

仓库根目录就是 Pi package 根目录。本地 checkout 可以直接加载或安装，不需要构建 Pi，也不会修改 Pi 本体：

```sh
pi -e /absolute/path/to/pi-speculative-action
pi install /absolute/path/to/pi-speculative-action
```

Pi 可以直接安装该仓库：

```sh
pi install https://github.com/xchang1121/pi
```

`pi.extensions` 指向 `src/extension.ts`，由 Pi 的公共 TypeScript 扩展加载器直接加载。因此 Git 安装不依赖已提交的构建产物或 dev dependency。`dist` 只作为 npm 使用时的标准 JavaScript/类型入口，在 `npm pack` 或 `npm publish` 时生成。

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
  "drafterMaxDepth": 1,
  "tools": ["read", "grep", "find", "ls", "bash", "write", "edit"],
  "patternAware": {
    "enabled": true,
    "multiStepEnabled": true
  }
}
```

`drafterMaxDepth` 表示每个单动作 Drafter 初始请求之后，最多允许多少次利用已完成工具输出的后继请求。后继请求占用该投机源在下一次 Actor 决策上的既有 slot，不会增加每个决策的请求宽度；设为 `0` 即恢复单步 Drafter。

`drafterMaxTokens` 是可选的硬上限。省略该项——或清空 TUI 输入框——会使用服务商默认输出上限，避免长命令和结构化工具参数被截断。

旧的 `resourceCached` / `sandbox` / `predictionOnly` 三组对象仅作为迁移输入继续识别，读取后统一规范化为一个 `tools` 数组。

## 接入 Runtime 沙箱

宿主通过 `executionWorlds` 提供执行世界。runtime scope 的 World 在类型上就是覆盖全部工具的 `runtime_sandbox`；只有 fallback World 才按工具效果声明有限能力。Router 在返回 route 前确认后端可用，因此不可用的 Runtime 沙箱会自然降级到兼容的本地后备。每个成功后端——包括内置资源快照和 Git worktree 后备——都返回同一种 `WorldBranch`，由 branch 自己拥有兼容性证据、新鲜度校验、采纳与清理。宿主在未注册资源快照后端时会自动补上内置实现。

```ts
createSpeculativeActionHost(sessionID, {
  cwd,
  executionWorlds: [runtimeSandbox, createWorkspaceSandbox()],
  // 省略模型、权限与工具接入
})
```

第一个可用的 Runtime 全局沙箱对所有工具生效；不存在时，Router 才检查与动作效果兼容的本地后备。两者都不存在时返回空 route，Runtime 将其结算为 `execution:isolation_unavailable` 并回退 Actor。解析、准备、fork 与 dispose 全部经过同一个 Router，工具侧不会持有可绕开的后端对象。

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
npm install --ignore-scripts
npm run check
npm run build
npm test
npm run bench:check
npm pack --dry-run
```

单轨迹消融方法见 [bench/README.md](./bench/README.md)。
