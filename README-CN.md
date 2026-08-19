# Pi Speculative Action

[English](README.md) | 中文

Pi 的工具动作投机执行功能。它在 Actor 模型思考期间预测接下来可能调用的工具，提前执行安全候选；当 Actor 随后发出相同动作时，Pi 直接复用已经完成或正在执行的结果。

这里的“投机”是工具动作级投机，不是 LLM token 级 speculative decoding。当前支持：

- `read`、`grep`、`find`：资源版本校验后的结果缓存与复用。
- `write`、`edit`：在私有 Git 工作区预执行，命中后事务式提交变更。
- `bash`：在私有 Git 工作区和隔离进程后端中预执行，命中后复用输出并提交变更。
- PatternAware：从历史工具序列学习模板，并预测未来一步或多步动作。
- Drafter：与 Actor 并行调用模型，生成当前回合的候选动作。

投机失败、候选不匹配、资源发生变化或沙箱不可用时，Pi 会回退到 Actor 的正常工具执行路径，不会把投机失败当成任务失败。

## 快速开始

Speculative Action 现在是普通的 Pi package，只使用公开 extension API，不修改 `pi-agent-core`、`pi-coding-agent` 或 Pi 的 settings schema。

### 1. 从源码启动

要求 Node.js 22.19 或更高版本，以及 Git。构建 package 后，可以把它安装到任意兼容且未修改的 Pi：

```bash
git clone --branch speculative-action https://github.com/xchang1121/pi.git pi-speculative
cd pi-speculative
npm install --ignore-scripts
npm run hydrate:model-data
npm run build --workspace @earendil-works/pi-coding-agent
npm run build --workspace @earendil-works/pi-speculative-action
pi install ./packages/speculative-action
```

`hydrate:model-data` 会获取 monorepo 构建所需的模型目录。已经构建好的发布包会包含 `dist`，不需要这一步源码构建。

如果只想临时试用一个会话而不写入 Pi 设置：

```bash
pi -e /absolute/path/to/pi-speculative/packages/speculative-action
```

### 2. 信任当前项目

package 只会在受信任项目中预执行候选动作。交互模式下可运行：

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
spec: on · Windows AppContainer · 3/4 hits · 1.2s ahead · 5/512 results
```

首次运行或模板尚未学习时，命中率可能较低。完成若干包含重复 `read`、`grep`、`find` 或 `bash` 工作流的任务后，再观察 `Hits` 和 `Execution ahead`。

## 命令

| 命令 | 作用 |
|---|---|
| `/speculative-action` | 打开交互式设置面板 |
| `/speculative-action on` | 开启投机执行 |
| `/speculative-action off` | 关闭投机执行，作为 baseline |
| `/speculative-action status` | 查看配置、沙箱健康状态、命中和时间指标 |
| `/speculative-action refresh` | 重新探测已配置的 Bash 隔离后端并显示状态 |
| `/speculative-action reset` | 删除当前作用域配置，恢复默认值；默认总开关为关闭 |

## 默认配置

总开关默认关闭。执行 `/speculative-action on` 后使用以下默认值：

| 配置 | 默认值 | 说明 |
|---|---:|---|
| Drafter | 开启 | 默认使用当前 Actor 模型，也可以另外配置模型 |
| PatternAware | 开启 | 学习并匹配历史动作模板 |
| PatternAware multi-step | 开启 | 允许未来动作和多步投机展开 |
| Pattern beam width | 4 | 在每个学习到的前沿只保留预期延迟收益最高的动作 |
| Pattern prediction depth | 6 | 限制递归多步展开深度，同时允许有界的重复模式 |
| Drafter requests | 8 | 每轮并行发起的独立单动作请求数；结果由 K(a) 去重 |
| Drafter rollout depth | 2 | 把已完成的投机结果回放给 Drafter，最多继续两个动作；`0` 表示关闭 rollout |
| Concurrent actions | 8 | 最大并行投机动作数 |
| Resource cache | 512 项 / 256 MiB | `read`、`grep`、`find` 结果缓存 |
| Prediction timeout | 300 秒 | 单轮预测生命周期上限 |
| Resource-cached tools | `read`, `grep`, `find` | 资源校验后可复用 |
| Sandbox-staged tools | `bash`, `write`, `edit` | 在隔离工作区中预执行 |
| Isolation backend | `auto` | 优先使用 OCI worker；不可用时回退原生 OS broker |

`bash` 默认在候选工具列表中，但只有所选进程后端健康检查通过后才会投机执行。隔离不可用时，Actor 发出的 Bash 仍按 Pi 原生路径正常运行。

## 配置文件

可以通过交互面板配置，也可以直接编辑 JSON：

| 文件 | 作用域 |
|---|---|
| `~/.pi/agent/speculative-action.json` | 全局配置 |
| `.pi/speculative-action.json` | 当前项目配置，覆盖全局配置 |

完整示例：

```json
{
  "enabled": true,
  "drafterEnabled": true,
  "draftModel": "provider/model",
  "candidateLimit": 8,
  "drafterMaxDepth": 2,
  "maxConcurrentActions": 8,
  "resourceCacheMaxEntries": 512,
  "resourceCacheMaxBytes": 268435456,
  "predictionTimeoutMs": 300000,
  "isolation": {
    "backend": "auto",
    "runtime": "auto",
    "image": "pi-speculative-worker:latest"
  },
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
```

省略 `draftModel` 时使用当前 Actor 模型。可选的 Pi `provider/model` 引用既可以显式选择相同模型，也可以选择其他已认证模型；无效或不可用的引用会回退到 Actor。

## 启用 Bash 投机

`write` 和 `edit` 依靠私有 Git snapshot/worktree 隔离；`bash` 还必须具备进程隔离。推荐的跨平台后端是持久化 Docker/Podman worker 池。

在 TUI 中启用 speculative action 时，package 会分别探测两个后端。`auto` 会在 OCI 可用时使用 OCI，否则回退到原生 OS 沙箱。面板分别显示 **Configured backend**、**Active backend**、**OCI worker** 和 **Native sandbox**，因此 Docker 不存在但 AppContainer 或其他原生后端可用时，不会再误报为全局沙箱不可用。只有两个后端都不可用时，才会自动给出 Docker/Podman 安装选项；任何系统包安装都必须先确认。即使当前正在使用原生回退，仍可从 **Tools & sandbox → Install or repair OCI dependencies** 主动配置 OCI。

手动配置时，先构建一次仓库内置的 Linux worker 镜像：

```bash
npm run build:worker --workspace @earendil-works/pi-speculative-action
```

Pi 不会隐式拉取自定义镜像。默认镜像是 `pi-speculative-worker:latest`；可以通过设置面板、JSON 或 `PI_SPECULATIVE_WORKER_IMAGE` 选择其他不可变镜像。`runtime: "auto"` 会先探测 Docker、再探测 Podman；也可以设置 `PI_SPECULATIVE_WORKER_RUNTIME=podman`。`PI_SPECULATIVE_WORKER_RUNTIME_BIN` 用于指定明确受信任的 runtime 可执行文件，`PI_SPECULATIVE_WORKER_SHELL` 用于指定 guest shell。

然后在 Pi 中重新检查：

```text
/speculative-action refresh
```

根据宿主平台，状态中可能出现：

```text
Configured isolation: auto
Active sandbox: Windows AppContainer ready (...)
OCI worker: unavailable (...)
Native sandbox: Windows AppContainer ready (...)
```

worker 池会预先准备执行 slot，并在 branch 工作区及其 Actor 逻辑路径确定后创建一次性容器。每条命令结束后会删除整个容器再复用 slot，因此被丢弃的进程树、根文件系统修改和临时文件不会泄漏到其他 branch。源工作区从不挂载进容器；worker 只能看到 branch 副本，且网络被禁用。在兼容的 OCI guest 中，该副本会挂载到 Actor 的逻辑工作区路径，原命令中的绝对路径无需改写即可保持语义。Linux worker 还使用只读根文件系统、删除全部 capability、`no-new-privileges`、PID 上限，并在可用时使用宿主 UID/GID。

内置镜像运行 Linux Bash，可通过 Windows 上的 Docker Desktop，以及 Linux/macOS 上的 Docker/Podman 使用。如果必须精确复现 Git for Windows 行为，可提供 Windows 容器镜像，并把 `guestShell` 设置为 `C:\\Program Files\\Git\\bin\\bash.exe`。配置的镜像 ID、OS、架构、runtime 和 guest shell 都会进入 K(a) 的 execution-world fingerprint，改变任一项都会使旧投机结果失效。

Linux、macOS 和 Windows 都可以显式使用原生 broker，也可以在 `auto` 下把它作为回退。构建命令为：

```bash
npm run build:native --workspace @earendil-works/pi-speculative-action
```

若使用在别处构建且明确受信任的 broker，设置 `PI_SPECULATIVE_SANDBOX_NATIVE_BIN=/absolute/path/to/pi-sandbox-native` 并选择 `backend: "native"`。原生沙箱提供：

- Linux：namespace、只读宿主挂载、seccomp、capability 移除和进程树监管。
- macOS：Seatbelt profile、源目录/用户目录/网络限制和进程树监管。
- Windows：零 capability AppContainer、仅授予暂存工作区的 package-SID 权限、私有 desktop 和 kill-on-close Job 监管。

Windows 的 `auto` 会先尝试 OCI，再回退 AppContainer。AppContainer 不设命令白名单，可运行兼容的原生 shell，但 Git for Windows 的 MSYS runtime 无法在该边界内完成初始化。需要投机 Git Bash 时应使用 OCI；否则失败候选会由 Scheduler 丢弃，Actor 再按正常路径执行，且不影响 `write`、`edit` 和资源缓存类投机。

`ExecutionWorld` 是 Agent adapter 使用的隔离边界。`ActionSemanticsRegistry` 选择 world mode（`file_mutation` 或 `workspace_snapshot`），world 不再维护第二份硬编码工具列表。完成的 `WorldBranch` 会把工具输出、可提交的文件系统 delta 和不可变 checkpoint 一起封存。与来源无关的 Scheduler 可以在 Actor 确认前从 checkpoint 派生后续沙箱动作，而 Actor 匹配仍按顺序遵循已确认的祖先动作意图。进程内 cwd/环境状态以及被阻断的网络副作用不会越过隔离边界。World commit 会检查冲突且至多发生一次；未提交的 branch 无法改变 Actor 所在的 world。Linux 原生隔离还会在 mount namespace 内把私有 branch 投影到 Actor 的逻辑工作区路径。

若所有已配置后端都不可用，Bash 投机会 fail closed，并回退到 Actor 的正常 Bash 执行。

## 如何判断功能是否生效

运行 `/speculative-action status`，重点查看：

| 字段 | 含义 |
|---|---|
| `Started` 的间接计数 | 已实际启动的投机候选；状态中命中分母会综合 started、hit 和 miss |
| `Hits` | Actor 动作成功复用了投机结果 |
| `Misses` | 预测未被采用、资源失效或安全检查拒绝 |
| `Execution ahead` | 被采纳的工具执行在 Actor 拦截前已经运行的时间，各次命中均以该次实测执行时长为上限 |
| `Hit latency` | 从 Actor 拦截到采纳结果完成必要的校验、剩余执行、投影、必要的 world commit 和同步命中结算的时间 |
| `Attempt lead` | 产生该执行所有者候选的请求到 Actor 拦截之间的诊断时间差 |
| `Actual` | 未命中后 Actor 原生工具执行时间 |
| `Draft tokens` | Drafter 累计 token 用量 |
| `Cache` | 当前缓存项、容量、内存占用和运行中任务数 |
| `Configured isolation` | 用户请求的后端策略及 OCI runtime/image 配置 |
| `Active sandbox` | Scheduler 当前实际可以使用的后端 |
| `OCI worker` | Docker/Podman worker 健康状态，与原生状态独立 |
| `Native sandbox` | AppContainer/Seatbelt/Linux 原生沙箱状态，与 OCI 状态独立 |

`Execution ahead` 是直接观测到的执行重叠量，不是反事实“节省时间”：已完成的缓存动作最多贡献其真实执行时长，仍在运行的动作只贡献 Actor 拦截前已经执行的部分。`Attempt lead` 可能大得多，但只用于诊断。这些指标都不虚构未发生的 Actor 工具路径；判断端到端收益仍应比较相同任务、模型和环境下的 baseline/full 配对墙钟时间。

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
- package 只允许受信任项目中的已知工具进入投机路径。
- `write`、`edit` 和 `bash` 在独立 Git snapshot/worktree 中预执行，不直接修改真实工作区。
- 命中时会再次逐文件校验 base 内容；任何资源变化都会拒绝提交。
- 提交变更采用完整 change set，部分写入失败时回滚已经写入的路径。
- 路径逃逸和 symlink 路径 fail closed。
- Bash 必须通过可证明的进程隔离后端，单纯复制目录不被视为安全边界。

## 零修改边界

package 只通过 Pi 原生公开 API 接入：生命周期事件提供模型上下文，`registerCommand()` 提供 TUI，同名 `registerTool()` 定义包装 Pi 公开的 `read`、`bash`、`edit`、`write`、`grep` 和 `find` 工厂。命中时返回缓存 settlement；未命中时委托给未修改的原生工具。package 自己管理配置，不进入 Pi settings schema。删除 package 后即可恢复 baseline，不需要回退任何 Pi 源文件。

引擎仍通过 `createSpeculativeActionHost()` 支持非 Pi adapter，但普通 Pi 用户应安装 package，而不是修改 `Agent` 实例。

## 故障排查

- `Enabled: Off`：运行 `/speculative-action on`。
- `Active sandbox: unavailable`：查看独立的 OCI/native 状态行。OCI 可使用 **Tools & sandbox → Install or repair OCI dependencies**；原生后端可构建或指定 broker，然后运行 `/speculative-action refresh`。
- 已开启但一直没有候选：确认项目已信任，并检查是否关闭了 Drafter 和 PatternAware。
- 有候选但没有命中：预测动作必须与 Actor 的工具名和规范化参数匹配；资源变化也会让候选失效。
- PatternAware 初期没有效果：它需要先观察重复工作流；冷启动阶段主要依赖 Drafter。
- Drafter 成本偏高：指定更快、更便宜的 `draftModel`，或降低 `candidateLimit`。
- 开发模式缺少模型 JSON：在仓库根目录运行 `npm run hydrate:model-data`。

## 实现概览

Actor 与 Drafter 并行运行。每轮 Drafter 会并行发起 `candidateLimit` 个独立请求：每个请求看到 Actor 的对话和可投机工具 schema，以 Assistant 身份只调用一个工具，关闭 reasoning，并使用较小的输出预算；第一个请求使用 temperature 0 保证准确性，其余请求使用 0.7 提供多样性。每个响应只接收第一个工具调用，再由现有 K(a) 关系在执行前合并等价工作。候选成功后，可把准确的 Assistant 调用和工具结果回放给同一条有界 Drafter 轨迹。Runtime 按目标 Actor 序号统一分配请求预算，避免 continuation 与下一 turn 的扇出重复；父动作未采纳时会取消晚到分支并使后代失效。候选仍经过 schema 校验、preflight、资源版本捕获和执行策略选择。完成结果进入 `ResultCache` 或仅支持精确匹配的 `ActionStore`，隔离副作用由封存的 `WorldBranch` 表示。PatternAware 按 workspace hash 持久化模板和有界 PPM 计数 trie；DAG 执行、新鲜度和调度保持来源无关。

所有命中、未命中、取消、实际执行、草稿 token、缓存和沙箱阶段耗时均以 typed event 暴露，供实验记录与可视化使用。
