# 4. 落地：用 durable 做一个日常可用的 agent

> durable 给了执行、恢复、状态和编排；缺的是产品层：搜索、提示词、UI、权限、撤销、模型配置。先做能闭环的七件事，再谈扩展。

版本：pi-durable **v1.6.0**。

## 你会学到

- "日常可用"的七条判据
- durable 已经有什么、缺什么
- P0/P1 缺口的实现方式和工作量
- 三个迭代的路线图
- 复用 Pi 的三档：直接依赖 / 移植 / 只借模式
- 哪些功能**不该**补

---

## 1. 判据：什么算"日常可用"

一个开发者愿意每天用，至少要闭环：

```text
1. 看懂代码     read + 搜索 + 目录导航
2. 改动代码     edit/write + 看 diff + 能撤销
3. 得到反馈     bash 跑测试/构建 + 输出可控 + 不卡死
4. 知道上下文   系统提示 + AGENTS.md + git 状态 + cwd
5. 能交互       流式、工具卡片、中断、插话、队列
6. 不丢工作     持久化、崩溃恢复、继续
7. 敢让它动手   权限/沙箱、审批、脱敏、成本上限
```

少任何一条，都只能算 demo。**主题、插件市场、分享链接不在核心列表里。**

---

## 2. durable 已经有的

| 能力 | 现状 |
|---|---|
| 模型调用 | `pi-ai` + `models` |
| Agent 循环 | `pi.generation` task |
| 持久化 / 恢复 | 提交日志 + `resume()` |
| 会话 / fork / reset | ✅ |
| 压缩 | ✅ 阈值、后台、溢出 |
| 中断 / 插话 / 队列 | ✅ abort / steer / follow-up |
| 文件工具 | `read/write/edit/bash` |
| 执行环境 | `ExecutionEnv`，可换本地/远程 |
| 权限原语 | hooks + signals |
| 子 agent / 并行 | 所有权 + child tasks |
| 成本 | usage + maxTurns |
| UI 数据 | watch / view / task graph |

### 已有工具的边界

| 工具 | 能做什么 | 缺什么 |
|---|---|---|
| `read` | offset/limit、图片、BOM、2000 行/50KB 截断 | 目录概览 |
| `edit` | 多处精确替换、**返回 diff**、换行/BOM、文件级串行 | 撤销 |
| `write` | 建目录、覆盖、串行 | 冲突检测（靠先读） |
| `bash` | 超时、输出截断、全文落文件 | **无默认超时、无后台、无 stdin/PTY** |
| `grep/find/ls` | ❌ | 全部要补 |

`edit` 的精确匹配已经是很好的防覆盖：文件被别人改了，`oldText` 匹配不上，调用失败而不是静默覆盖。

---

## 3. P0：不做就不是日常可用

### ① 搜索与导航：`grep` / `find` / `ls`

**为什么**：agent 80% 的时间在找。只有 `bash` 意味着模型要写 `rg/find` 并解析文本，浪费 token、容易错。

**怎么做**：

- `grep`：`env.exec(["rg", "--json", ...])`，尊重 `.gitignore`；结果上限 100–200 条；全文落 spill 文件。
- `find`：`env.listFiles()`（`pi-env` / `LocalExecutionEnv` 有），没有就自己 walk。
- `ls`：`openDirReader` 分页，目录优先，带大小/类型。
- 输出必须截断，`truncated` + `fullOutputPath` 放 `details`。

工作量：小（1–2 天），收益极大。

### ② 编码提示词与项目上下文

durable 的 System Prompt 是空白的。要补：

- 稳定的编码 preamble（读再改、小步编辑、跑测试、危险命令要审批）。
- `AGENTS.md` / `CLAUDE.md` 发现：从 cwd 向上找，放 section（内容稳定，缓存友好）。
- 仓库概览：cwd、git branch、两层目录树；`git status` 这种易变内容不要放 section。
- 多根目录 / monorepo 的边界。

工作量：中（2–3 天）。

### ③ 交互界面 + 协议

**最大的工作量。** durable 给了数据，没给渲染。

| 数据 | 来源 |
|---|---|
| 消息窗口 | `watch.value.entries` + `before` |
| 流式文本 | `pi.live` partial |
| 工具运行态 | `pi.live` tool slots |
| diff | 工具 `details.diff`（`edit` 已有） |
| 队列 | `pi.inbox` |
| 失败原因 | `pi.live.runFailure` |
| 花费 | `pi.usage` |
| 待审批 | task graph 里 `sleeping` 的节点 |

最小协议：

```text
GET  /view        → 当前视图
WS   /events      → { kind:"value", value, ops }
POST /submit      → content, whenBusy?, requestId
POST /abort
POST /signal      → taskId, key, value   // 审批
POST /configure
GET  /sessions
```

渲染：按工具名映射 renderer；`edit` 用 `details.diff`，`bash` 用 `details.output` + `fullOutputPath`，`read` 用文件卡片。

可以复用 `pi-tui` 做终端；Web 要自己做。工作量：大（2–4 周）。

### ④ 权限与沙箱

四层：

| 层 | 做法 |
|---|---|
| 路径 | `beforeTool` 里 resolve 绝对路径，检查是否在 workspace 内；`env.absolutePath` 不做 jail |
| 命令 | 允许列表 / 危险模式 → block 或 gate |
| 环境 | 每会话一个容器/远程 env；不继承宿主 env |
| 输出 | `afterTool` 脱敏：API key、token、`.env`、私钥 |

`NodeExecutionEnv` 继承宿主环境，不适合多租户。工作量：中（3–5 天 + 容器）。

### ⑤ 撤销与变更可见性

没有撤销，用户不敢让它改代码。

**Git checkpoint（推荐）**：

```text
每轮开始或第一次 edit 前：
  git stash create  → SHA
  存 SHA 到文档/entry
撤销：
  git checkout <sha> -- .   或 reset --hard
```

用 `afterTools` / `beforeTool` 触发；`env.exec` 跑 git。

工作量：中（3–5 天，边界在 untracked/rename/权限/大仓库）。

### ⑥ 模型配置与认证

- provider 工厂，从环境变量/密钥库读 key。
- 模型目录：context window、价格、图片/thinking 支持。
- 每会话 `configure({ model, thinkingLevel })`。
- 失败回退（主模型失败 → 备用）。
- OAuth 登录是应用层工作，`pi-ai` 不替你做。

工作量：中（2–4 天，不含 OAuth）。

### ⑦ 会话管理 UX

| 功能 | 实现 |
|---|---|
| 列表 | `harness.scanConversations()` |
| 恢复 | `root()` / `submission(id)` |
| fork | `root.fork(entryId)` |
| 重命名 | 没有 name 字段 → 自己的 global doc/表 |
| 导出 | 读 entries → Markdown/JSONL/HTML |
| 删除 | 自己删存储记录 |

工作量：小（2–3 天）。

---

## 4. P1：有了才"好用"

| 功能 | 实现方式 | 注意 |
|---|---|---|
| 后台进程 | `pi-env.openProcess` / 自己的 spawn 能力 | 进程不跨重启，要标记失效并让模型重跑 |
| Skills / 模板 | 扫描 `SKILL.md`，描述进 prompt，正文用 `read_skill` 工具 | 可移植 Pi 的 `loadSkills` |
| MCP | `pi-mcp` 客户端 → durable 工具（`deferred` + `callers`） | 连接生命周期自己管 |
| 子 agent + UI | 示例 21/22 已是产品代码；UI 通过 `details.conversationId` 挂子会话 | 防递归、预算 |
| 多模态 | `fitImage` 提交前缩放；read 已支持图片 | 模型限制 |
| 文件监听 | `env.watch`；变更作为 write entry 或提示 | 别把易变内容放 section |
| Git 工具 | 包 `env.exec(["git", ...])`，返回 `structuredOutput` | 别让模型拼 shell |
| 成本护栏 | `maxTurns` + 读 `pi.usage` 的 hook + 预算文档 | 自动 continue 要封顶 |

---

## 5. 不该补的

| 不补 | 理由 |
|---|---|
| TUI 主题/分享/包市场 | 产品层，和可用无关 |
| 原地会话树 `/tree` | fork 覆盖 90%；树 + 分支摘要是大工程 |
| LSP / 语义索引 | `tsc --noEmit` / `eslint` 够用 |
| cache warming | 位置性 system entry 够用 |
| 自研 agent 循环 / 存储 | durable 已有，重写更差 |
| PTY / 交互式命令 | 让模型避开 `git rebase -i`、`vim` |

---

## 6. 三个迭代

### 迭代 1：能读、能改、能跑（1–2 周）

```text
grep / find / ls
编码 preamble + AGENTS.md + git branch + 顶层目录
最小 UI：流式 + 工具卡片 + diff + 中断
模型配置（环境变量 key + 选模型）
路径 jail + 危险命令 block
```

验收：真实仓库改一个小 bug、跑测试、看 diff。

### 迭代 2：敢用（1–2 周）

```text
undo（git checkpoint）
审批 gate（signal + UI）
密钥脱敏（afterTool）
会话列表/恢复/fork
成本显示 + maxTurns
```

验收：危险命令被拦；改错能一键撤销。

### 迭代 3：好用（2–3 周）

```text
后台进程
子 agent + UI
Skills / 模板
MCP
文件监听 + 外部改动提醒
```

---

## 7. 复用 Pi 的三档

| 档 | 内容 | 例子 |
|---|---|---|
| 直接依赖 | 独立包，不绑 Pi 应用 | `pi-ai`、`pi-schema`、`pi-codemode`、`pi-tui`、`pi-mcp`、`pi-env` |
| 移植 | 代码可抄，依赖不划算 | `grep/find/ls` 的 schema/格式；`loadSkills`；`loadProjectContextFiles`；`DefaultPackageManager` |
| 只借模式 | 不可依赖 | `SessionManager`、`ExtensionAPI`、`agent-core`、RPC 协议形状 |

重点：

- **`pi-env` 是最大的免费午餐**：远程执行、`listFiles`、PTY、`openProcess`，本来就是为 durable 写的。
- **`pi-tui` / `pi-mcp` 是独立包**，可直接用。
- **`grep/find/ls` 不能直接依赖**：Pi 的实现直接 spawn `rg`/`fd` 或 `fs`，绕过 durable 的 env，容器/远程跑不了。抄 schema 和输出格式，用 `env` 重写。
- **不要接 `SessionManager`**：会和 durable 的提交日志形成两套真相。

---

## 8. 工作量分布（经验值）

```text
交互界面 + 协议       35–45%
搜索/导航             10%
提示词/上下文         10%
权限/沙箱/审批        10%
撤销/checkpoint       10%
模型配置/认证         10%
会话管理               5%
后台/其他              5%
```

durable 省掉的（持久化、恢复、调度、子 agent 原语、压缩、usage）大约相当于一个团队 30–40% 的工作量。它不省 UI。

---

## 9. 最小骨架

```text
src/
  app.ts                 Harness.open + registry + env + settings + resume
  extensions/
    coding-prompt.ts     preamble / AGENTS.md / tree / git
    search-tools.ts      grep / find / ls
    policy.ts            path jail / command policy / redaction
    checkpoint.ts        git snapshot + undo
    approvals.ts         signal gate
  server/
    view.ts              watch → snapshot + ops
    protocol.ts          submit/abort/signal/configure/fork
  ui/                    pi-tui 或 Web
  storage/               SQLite
```

```typescript
const harness = await Harness.open(storage, { models, registry, env, settings, onReport }, context);
const root = await harness.root(context);
harness.resume();
```

---

## 10. 结论

> **durable 给你发动机，不给你整车。**
>
> 先把七件事闭环（读、改、跑、上下文、交互、恢复、权限），再谈插件生态和远程部署。UI 永远是最大头；搜索工具和撤销是最划算的两个补丁。

---

## 11. 相关

- [1-durable-vs-pi.md](1-durable-vs-pi.md)
- [2-extending.md](2-extending.md)
- [3-deployment.md](3-deployment.md)
- durable 核心：[2-capabilities.md](../1-core/2-capabilities.md)、[3-control.md](../1-core/3-control.md)、[4-orchestration.md](../1-core/4-orchestration.md)、[5-runtime.md](../1-core/5-runtime.md)
