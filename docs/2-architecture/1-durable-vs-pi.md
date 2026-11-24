# 1. durable 与 Pi：两层，不是两个竞品

> Pi 是一个装好的 agent 应用；durable 是装 agent 的运行时。它们共享模型层，但持久化和执行模型不同。

版本：pi-durable **v1.6.0**；Pi（`pi-coding-agent`）**1.6.0**。

## 你会学到

- 两者各自的定位和依赖关系
- "会话记录"和"执行状态"的差别
- 为什么 Pi 的扩展能改 UI，而 durable 的扩展不能
- 什么时候选 Pi、什么时候选 durable
- 为什么都叫 "harness" 却不是一回事

---

## 1. 一句话定位

| | Pi | durable |
|---|---|---|
| 是什么 | CLI/TUI + 会话 + 工具 + 技能 + RPC/SDK | 持久化运行时 + task + 文档 + 视图 |
| 拥有应用吗 | 是 | 否 |
| 谁负责 UI | Pi | 你 |
| 假设你在写代码吗 | 是 | 否 |
| 依赖关系 | 不依赖 durable | 不依赖 Pi |

Pi 的 `package.json` 依赖：

```text
pi-coding-agent
  ├─ pi-agent-core   ← 内存 agent 循环、事件
  ├─ pi-ai
  ├─ pi-codemode
  ├─ pi-mcp
  └─ pi-tui
```

durable 的依赖是 `pi-ai` + `chord`。**没有 `pi-durable` 出现在 Pi 的依赖里。**

共享的底座：`pi-ai`、`pi-schema`、`pi-codemode`。

---

## 2. 持久化：记录 vs 执行状态

### Pi：JSONL 会话树

```text
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
每行一个 entry：{ type, id, parentId, timestamp, ... }
```

- entry 组成**树**，可以 `/tree` 原地分支、`/fork`、`/clone`。
- 活动分支决定下一次请求的历史。
- 会话按工作目录分组，**cwd 创建后不变**。

### durable：提交日志 + 文档 + task

一次 commit 原子地写：

```text
entry（不可变事实） + document（可变状态） + task 状态
```

- 没有树；只有 entry 日志 + reset/compaction 的可见性边界。
- fork 是 API，复制祖先。
- cwd 是会话配置，运行中可以变。

### 具体后果

| 问题 | Pi | durable |
|---|---|---|
| 崩溃在工具执行中途 | 恢复到最后一个已写入 entry；**中断的 turn 不自动重跑** | 工具是 task；按 `replay` 重跑或给 `interrupted` |
| "消息 + 我的计数"是否原子 | 分开写 | **同一个 commit** |
| 分支 | 一等公民 `/tree` | 只有 fork |
| 会话单位 | 一个 JSONL 文件 | 一个存储（可多租户、可加前缀） |

> **Pi 持久化"发生过什么"；durable 持久化"正在做什么"。**

---

## 3. 执行模型：内存循环 vs task 树

### Pi

```text
提交消息 → 加入活动分支
  → 构建请求
  → 流式返回
  → 记录 assistant
  → 执行每个工具调用
  → 记录结果
  → 下一轮
```

循环在**进程内存**里（`pi-agent-core` 的 `Agent`）。会话文件记录结果，但"正在跑的工具"不是持久对象。

- abort：停止当前 run，**排队消息还给编辑器**。
- 进程死：恢复到最后一个 entry；没跑完的工具没有"重试策略"这个概念。

### durable

```text
submit → 持久受理
  → pi.generation task
       → pi.tool task（独立、有 owner、有 replay 策略）
       → 下一个 pi.generation
```

- 每个工具调用都是 task。
- 有 `replay`、`restartLimit`、所有权、park/signal。
- `resume()` 接着做。

同一个"调外部 API 10 分钟"的工具：

| | Pi | durable |
|---|---|---|
| 进程被杀 | 工具结果丢失 | task 仍在；重跑或 `interrupted` |
| 等待 10 分钟 | 进程/请求挂着 | park；进程可退出 |
| 用户按 Esc | 停 run，消息回编辑器 | abort task 树，排队输入 settle `unanswered` |

---

## 4. 交互语义

名字很像，细节不同：

| | Pi | durable |
|---|---|---|
| steering | 当前 assistant turn 之后 | 当前工具轮之后 |
| follow-up | 当前待办结束后 | run 答完后 |
| abort 时排队消息 | **还给编辑器** | 输入 `unanswered`；排队的 write 保留 |
| 失败后的队列 | 用户处理 | 默认留 inbox，直到下一条输入/continue |
| 显式续跑 | 重新发消息 | `submit({ type: "continue" })` |

Pi 把队列更多当 UI 交互；durable 把它当持久状态（`pi.inbox`），所以能跨重启、能被 watch、能被策略控制。

---

## 5. 上下文管理：默认值一样，机制不同

两边压缩默认值相同：`reserveTokens 16384`、`keepRecentTokens 20000`、`modelOverrides`。

差异：

| | Pi | durable |
|---|---|---|
| 触发 | `prepareNextTurn`；溢出后一次恢复 | 后台阈值 + 阻塞阈值 + 溢出重试一次 |
| 分支摘要 | **有**（`/tree` 切换时摘要旧路径） | 没有；用 reset/handoff |
| 压缩失败 | 报错，可重试 `/compact` | 阻塞阈值失败 → **整个 run 失败** |
| 手动压缩 | `/compact` | `root.compact()` 返回 task ID |
| 缓存策略 | 显式 cache warming | 位置性 system entry |

---

## 6. 扩展模型

### Pi

> Extensions are TypeScript modules ... subscribe to lifecycle events, register tools, add commands ... run inside the Pi process with the same OS permissions.

能做的事：

- 注册工具、命令、快捷键、provider、MCP server
- 拦截/修改工具调用、注入上下文、自定义压缩
- **操作 UI**（`ctx.ui`、完整 TUI 组件）
- `pi.appendEntry()` 持久化状态
- 自定义渲染、主题

特点：有生命周期、能持有进程状态、能碰 UI。代价是信任边界 = 整个进程。

### durable

`defineExtension({ name, tools, sections, hooks, wraps, tasks })`：

- 没有生命周期，没有 init/dispose。
- 不能持有会话状态；状态进 `defineDoc`。
- hook 挂在内置 task 类型上，不是全局事件。
- 没有 UI 能力；UI 通过 `watch()` 自己画。

特点：可热替换、可移植、可重放。代价是表达能力受限于"声明式五件套"。

> **Pi 让你改应用；durable 让你装配运行时。**

---

## 7. 能力对照（只列一边有的）

| 能力 | Pi | durable |
|---|---|---|
| TUI / 主题 / 快捷键 / 命令 | ✅ | ❌ |
| CLI / print / JSON / RPC / SDK | ✅ | ❌ |
| 会话树 `/tree` / `/fork` / `/clone` | ✅ | fork API，无树 |
| 分支摘要 | ✅ | ❌ |
| 技能 / 提示模板 / 主题包 | ✅ | section/扩展自己做 |
| 项目 trust | ✅ | ❌（宿主负责） |
| MCP 内置 | ✅（`pi-mcp`） | 通过工具接入 |
| cache warming | ✅ | ❌ |
| **durable task / 重启恢复** | ❌ | ✅ |
| **park / signal / sleep** | ❌ | ✅ |
| **子 agent 所有权 / child tasks** | ❌（Pi 明说跳过 sub-agents） | ✅ |
| **task graph / 文档 / 原子提交** | ❌ | ✅ |
| **多存储后端** | ❌（JSONL） | ✅ |
| **env 抽象（容器/远程）** | ❌（进程权限） | ✅ |
| **code mode 跨重启续跑** | ❌ | ✅（journal） |
| **plan mode** | ❌（明说跳过） | 示例 26 |

---

## 8. 能不能互相替代

### 用 durable 做 Pi 那样的 coding agent

可以，但要补：

- 工具：durable 有 `read/write/edit/bash`；缺 `grep/find/ls`。
- 环境：`NodeExecutionEnv` 或 `pi-env`。
- 压缩、hooks、审批、子 agent：durable 有原语。
- **缺**：TUI、会话树 UI、技能发现、模板、主题、分享、`/tree` 分支摘要、trust。

> durable 给发动机，Pi 给整车。

### 给 Pi 加 durable 的恢复语义

**没有现成路径。** Pi 不依赖 durable，`SessionManager` 写自己的 JSONL 树；durable 的调度器是另一套。

写扩展能持久化一些状态，但没有原子提交把"工具意图 + entry + 队列"绑在一起，也没有 `replay`/`restartLimit`/所有权。

### 组合

现实做法是分层：

```text
交互层：Pi（TUI/CLI/RPC）        或 你的 Web UI
运行时：pi-agent-core（内存循环）  或 durable（持久执行）
模型层：pi-ai
沙箱层：pi-codemode
执行环境：NodeExecutionEnv / pi-env
```

但 Pi 的应用层是围绕 `pi-agent-core` 写的，想同时要 Pi 的 UX 和 durable 的恢复，需要重写胶水。

---

## 9. 选型

| 情况 | 选 |
|---|---|
| 本地写代码的工具，要终端体验 | Pi |
| 单人/单机，会话文件够用 | Pi |
| 多租户 SaaS，每会话隔离存储/容器 | durable |
| 工具要等外部事件（webhook、审批、慢任务） | durable |
| 一个请求并行多个子任务，失败要取消/汇总 | durable |
| 进程会被随时杀掉 | durable |
| 自定义 UI/协议，不想被 TUI 绑定 | durable |
| 需要 `/tree` 分支体验 | Pi |
| 浏览器里跑 | durable（IndexedDB） |

判据：

> **"崩溃时丢一条聊天记录"能接受吗？**
> 能 → Pi 的会话模型够了。
> 不能（钱、订单、外部副作用、长任务）→ 需要 durable 的执行模型。

---

## 10. 术语撞车

两边都叫 "harness"，但指的不是一回事：

| | Pi | durable |
|---|---|---|
| harness 的含义 | **应用骨架**：循环 + 工具 + 会话 + UI + 扩展 | **执行骨架**：提交 + task + 所有权 + 等待 + 视图 |
| 你扩展什么 | 应用行为（工具、命令、UI、事件） | 运行时装配（tools/sections/hooks/tasks） |
| 状态在哪 | 会话 JSONL + 扩展 entry | 提交日志 + 文档 + task |
| 谁负责 UI | Pi 自己 | 你 |

---

## 11. 相关

- [2-extending.md](2-extending.md)：Pi 插件系统，以及如何在 durable 上复刻
- [3-deployment.md](3-deployment.md)：pi-env、跨机通信
- [4-building-an-agent.md](4-building-an-agent.md)：用 durable 做 coding agent 的缺口与路线
- 上游：Pi 的 `docs/how-pi-works.md`、`docs/session-format.md`、`docs/extensions.md`
