# Pi Speculative Action

[English](README.md) | 中文

Pi 的工具动作投机执行功能。它在 Actor 模型思考期间预测接下来可能调用的工具，提前执行安全候选；当 Actor 随后发出相同动作时，Pi 直接复用已经完成或正在执行的结果。

这里的“投机”是工具动作级投机，不是 LLM token 级 speculative decoding。当前支持：

- `read`、`grep`、`find`：资源版本校验后的结果缓存与复用。
- `write`、`edit`：在私有 Git 工作区预执行，命中后事务式提交变更。
- `bash`：在私有 Git 工作区和原生进程沙箱中预执行，命中后复用输出并提交变更。
- PatternAware：从历史工具序列学习模板，并预测未来一步或多步动作。
- Drafter：与 Actor 并行调用模型，生成当前回合的候选动作。

投机失败、候选不匹配、资源发生变化或沙箱不可用时，Pi 会回退到 Actor 的正常工具执行路径，不会把投机失败当成任务失败。

## 快速开始

投机功能已经作为 Pi 内置插件接入本仓库，无需另外安装 extension。官方发布版 Pi 暂不包含本分支的代码，因此需要从包含该功能的仓库或发布包启动 Pi。

### 1. 从源码启动

要求 Node.js 22.19 或更高版本，以及 Git。把下面的仓库地址替换成实际 GitHub 地址：

```bash
git clone <your-github-repository> pi-speculative
cd pi-speculative
git switch feature/speculative-action
npm install --ignore-scripts
npm run hydrate:model-data
./pi-test.sh
```

`hydrate:model-data` 会获取 Pi 构建和运行所需的模型目录。如果使用包含模型快照的 release source，可以跳过该步骤并使用 `npm run build:offline`。

也可以保留原有 `pi` 命令，直接从任意项目目录调用这个仓库中的脚本：

```bash
/path/to/pi-speculative/pi-test.sh
```

### 2. 信任当前项目

内置插件只会在受信任项目中预执行候选动作。交互模式下可运行：

```text
/trust
```

保存信任决定后重启 Pi。未受信任时可以开启和查看投机设置，但候选动作不会被预执行。

### 3. 开启并检查状态

进入 Pi 后运行：

```text
/speculative-action on
/speculative-action status
```

成功开启后，底部状态栏会出现类似信息：

```text
spec: on · native · 3/4 hits · 1.2s saved · 5/512 cached
```

首次运行或模板尚未学习时，命中率可能较低。完成若干包含重复 `read`、`grep`、`find` 或 `bash` 工作流的任务后，再观察 `Hits`、`Saved` 和 `End-to-end speedup`。

## 命令

| 命令 | 作用 |
|---|---|
| `/speculative-action` | 打开交互式设置面板 |
| `/speculative-action on` | 开启投机执行 |
| `/speculative-action off` | 关闭投机执行，作为 baseline |
| `/speculative-action status` | 查看配置、沙箱健康状态、命中和时间指标 |
| `/speculative-action refresh` | 重新探测原生 Bash 沙箱并显示状态 |
| `/speculative-action reset` | 删除当前作用域配置，恢复默认值；默认总开关为关闭 |

## 默认配置

总开关默认关闭。执行 `/speculative-action on` 后使用以下默认值：

| 配置 | 默认值 | 说明 |
|---|---:|---|
| Drafter | 开启 | 与 Actor 并行预测候选动作 |
| PatternAware | 开启 | 学习并匹配历史动作模板 |
| PatternAware multi-step | 开启 | 允许未来动作和多步投机展开 |
| Pattern beam width | 4 | 在每个学习到的前沿只保留预期延迟收益最高的动作 |
| Pattern prediction depth | 6 | 限制递归多步展开深度，同时允许有界的重复模式 |
| Adaptive drafter | 开启 | 已有高价值模板时跳过冗余 drafter 请求 |
| Candidate limit | 8 | 每次最多接收的候选数 |
| Concurrent actions | 8 | 最大并行投机动作数 |
| Resource cache | 512 项 / 256 MiB | `read`、`grep`、`find` 结果缓存 |
| Prediction timeout | 300 秒 | 单轮预测生命周期上限 |
| Resource-cached tools | `read`, `grep`, `find` | 资源校验后可复用 |
| Sandbox-staged tools | `bash`, `write`, `edit` | 在隔离工作区中预执行 |

`bash` 默认在候选工具列表中，但只有原生进程沙箱健康检查通过后才会投机执行。沙箱不可用时，Actor 发出的 Bash 仍按 Pi 原生路径正常运行。

## 配置文件

可以通过交互面板配置，也可以直接编辑 JSON：

| 文件 | 作用域 |
|---|---|
| `~/.pi/agent/settings.json` | 全局配置 |
| `.pi/settings.json` | 当前项目配置，覆盖全局配置 |

完整示例：

```json
{
  "speculativeAction": {
    "enabled": true,
    "drafterEnabled": true,
    "draftModel": "provider/model",
    "candidateLimit": 8,
    "maxConcurrentActions": 8,
    "resourceCacheMaxEntries": 512,
    "resourceCacheMaxBytes": 268435456,
    "predictionTimeoutMs": 300000,
    "adaptiveDrafter": true,
    "patternAware": {
      "enabled": true,
      "multiStepEnabled": true,
      "beamWidth": 4,
      "maxPredictionDepth": 6
    },
    "tools": {
      "resourceCached": ["read", "grep", "find"],
      "sandbox": ["bash", "write", "edit"]
    }
  }
}
```

省略 `draftModel` 时使用当前 Actor 模型。设置其他模型时使用 Pi 的 `provider/model` 引用格式，并确保该 provider 已完成认证。

## 启用 Bash 投机

`write` 和 `edit` 依靠私有 Git snapshot/worktree 隔离；`bash` 还必须具备原生进程隔离。仓库当前没有提交平台预编译资产，因此首次使用 Bash 投机前，需要在目标机器构建 Rust broker：

```bash
npm run build:native --workspace @earendil-works/pi-speculative-action
```

然后在 Pi 中重新检查：

```text
/speculative-action refresh
```

状态中应出现：

```text
Sandbox: native ready (...)
```

如果需要使用自行构建且明确受信任的 broker，可以设置：

```bash
export PI_SPECULATIVE_SANDBOX_NATIVE_BIN=/absolute/path/to/pi-sandbox-native
```

原生沙箱按平台提供以下隔离：

- Linux：namespace、只读宿主挂载、seccomp、capability 移除和进程树监管。
- macOS：Seatbelt profile、源目录/用户目录/网络限制和进程树监管。
- Windows：零 capability AppContainer、受限 token、私有 desktop 和 Job 管理。

`ExecutionWorld` 是 Agent adapter 使用的隔离边界。`ActionSemanticsRegistry` 选择 world mode（`file_mutation` 或 `workspace_snapshot`），world 不再维护第二份硬编码工具列表。完成的 `WorldBranch` 会把工具输出和可提升的文件系统 delta 一起封存；进程内 cwd/环境状态以及被阻断的网络副作用不会被提升。并发消费者会合并到同一次经过冲突校验的事务式 adoption，而未被采用的 branch 无法改变 Actor 所在的 world。

若 broker 缺失、版本不匹配、完整性校验失败或未明确证明进程隔离，Bash 投机会 fail closed，并回退到 Actor 的正常 Bash 执行。

## 如何判断功能是否生效

运行 `/speculative-action status`，重点查看：

| 字段 | 含义 |
|---|---|
| `Started` 的间接计数 | 已实际启动的投机候选；状态中命中分母会综合 started、hit 和 miss |
| `Hits` | Actor 动作成功复用了投机结果 |
| `Misses` | 预测未被采用、资源失效或安全检查拒绝 |
| `Saved` | 因提前执行而估算节省的工具等待时间 |
| `Waited` | Actor 命中尚未完成的投机动作后实际等待的时间 |
| `Actual` | 未命中后 Actor 原生工具执行时间 |
| `End-to-end speedup` | 根据观测墙钟时间和 saved 时间计算的会话内指标 |
| `Draft tokens` | Drafter 累计 token 用量 |
| `Cache` | 当前缓存项、容量、内存占用和运行中任务数 |
| `Sandbox` | Bash 原生隔离是否可用 |

判断真实收益时，应以相同任务、模型和环境下的 baseline/full 配对墙钟时间为准，不应只根据 `Saved` 推断端到端加速。

## 常用消融配置

以下设置足以覆盖几个主要变量：

### Baseline

```json
{ "speculativeAction": { "enabled": false } }
```

### 关闭 Drafter，只保留 PatternAware

```json
{
  "speculativeAction": {
    "enabled": true,
    "drafterEnabled": false,
    "patternAware": { "enabled": true, "multiStepEnabled": true }
  }
}
```

### 关闭多步，只保留即时模板预测

```json
{
  "speculativeAction": {
    "enabled": true,
    "patternAware": { "enabled": true, "multiStepEnabled": false }
  }
}
```

### 关闭 PatternAware，只使用 Drafter

```json
{
  "speculativeAction": {
    "enabled": true,
    "drafterEnabled": true,
    "patternAware": { "enabled": false }
  }
}
```

### 关闭 Sandbox 动作投机

```json
{
  "speculativeAction": {
    "enabled": true,
    "tools": {
      "resourceCached": ["read", "grep", "find"],
      "sandbox": []
    }
  }
}
```

每个实验组应使用独立的 Pi 状态目录或清理 PatternAware 学习状态，避免前一组历史影响后一组结果。

## 安全模型

- 所有候选参数先经过真实工具 schema 校验和非交互式 preflight。
- 内置插件只允许受信任项目中的已知工具进入投机路径。
- `write`、`edit` 和 `bash` 在独立 Git snapshot/worktree 中预执行，不直接修改真实工作区。
- 命中时会再次逐文件校验 base 内容；任何资源变化都会拒绝提交。
- 提交变更采用完整 change set，部分写入失败时回滚已经写入的路径。
- 路径逃逸和 symlink 路径 fail closed。
- Bash 必须通过原生进程隔离，单纯复制目录不被视为安全边界。

## SDK 集成

不使用 Pi coding-agent 内置插件时，也可以直接安装到 `Agent`。通用 SDK 默认关闭投机，并且必须提供非交互式 `preflight`；缺少该回调时只生成预测，不执行候选。

```ts
import {
  createNativeSandboxProcessRunner,
  createWorkspaceSandbox,
  installSpeculativeAction,
} from "@earendil-works/pi-speculative-action";

const allowedTools = new Set(["read", "grep", "find", "bash", "write", "edit"]);

const installed = installSpeculativeAction(agent, {
  cwd: process.cwd(),
  getSettings: () => ({
    enabled: true,
    drafterEnabled: true,
    candidateLimit: 4,
    maxConcurrentActions: 4,
    resourceCacheMaxEntries: 256,
    resourceCacheMaxBytes: 256 * 1024 * 1024,
    predictionTimeoutMs: 1_000,
    adaptiveDrafter: true,
    patternAware: {
      enabled: true,
      multiStepEnabled: true,
      beamWidth: 4,
      maxPredictionDepth: 6,
      futureGapCoverage: 0.9,
      decayHalfLifeEvents: 2048,
    },
    tools: {
      resourceCached: ["read", "grep", "find"],
      sandbox: ["bash", "write", "edit"],
    },
  }),
  preflight: ({ toolName }) => allowedTools.has(toolName),
  sandbox: createWorkspaceSandbox({
    processRunner: createNativeSandboxProcessRunner(),
  }),
  onEvent: (event) => console.debug(event),
});

// 在销毁 Agent 前调用。
await installed.uninstall();
```

如果 Drafter 与 Actor 使用不同 provider，应通过 `getDraftOptions` 提供正确的认证和请求选项。投机异常应继续保持可回退语义，不要在 `preflight` 中显示交互式授权界面。

## 故障排查

- `Enabled: Off`：运行 `/speculative-action on`。
- `Sandbox: bash unavailable`：构建 native broker，然后运行 `/speculative-action refresh`。
- 已开启但一直没有候选：确认项目已信任、Drafter 已认证，并检查是否关闭了 Drafter 和 PatternAware。
- 有候选但没有命中：预测动作必须与 Actor 的工具名和规范化参数匹配；资源变化也会让候选失效。
- PatternAware 初期没有效果：它需要先观察重复工作流；冷启动阶段主要依赖 Drafter。
- Drafter 成本偏高：启用 `adaptiveDrafter`，或指定更快、更便宜的 `draftModel`。
- 开发模式缺少模型 JSON：在仓库根目录运行 `npm run hydrate:model-data`。

## 实现概览

Actor 与 Drafter 并行运行，候选依次经过 schema 校验、preflight、资源版本捕获和执行策略选择。完成的候选进入 `ResultCache` 或仅支持精确匹配的 `ActionStore`，隔离副作用由封存的 `WorldBranch` 表示；Actor 发出工具调用时，Pi Agent 的 `settleToolCall` hook 尝试复用完全匹配或安全可投影的结果。PatternAware 按 workspace hash 持久化模板和有界 PPM 计数 trie，只保留少量预期收益最高的 beam；DAG 执行、新鲜度和资源调度仍由来源无关的 runtime 统一负责。

所有命中、未命中、取消、实际执行、草稿 token、缓存和沙箱阶段耗时均以 typed event 暴露，供实验记录与可视化使用。
