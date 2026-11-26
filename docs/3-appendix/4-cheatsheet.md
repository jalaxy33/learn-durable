# 速查表

> 一页纸：原语、决策、默认值、失败原因、坑。细节回到各章。

版本：pi-durable **v1.6.1**。

## 1. 原语

| 原语 | 作用 |
|---|---|
| `Harness.open(storage, host, ctx)` | 打开存储 + 建 Session |
| `harness.root(ctx, { agent })` | 根会话（首次创建） |
| `conversation.submit(draft, ctx)` | 持久受理输入，返回 `Submission` |
| `submission.wait(ctx)` | 等 `done` / `unanswered` |
| `submission.abort(ctx)` | 撤回排队中的提交 |
| `conversation.commit(fn, ctx, opts?)` | 原子读/写；返回 `fn` 的返回值 |
| `conversation.configure(change, ctx)` | 改会话 agent 配置 |
| `conversation.reset(text?, ctx)` | 新上下文边界 |
| `conversation.compact(instr?, ctx)` | 手动压缩，返回 task ID |
| `conversation.fork(entryId, opts, ctx)` | 从某条 entry 分叉 |
| `conversation.abort(ctx)` | 停止当前工作 |
| `conversation.watch(ctx, opts?)` | 结构视图 + 增量 |
| `conversation.entries(query, limit, cursor, ctx)` | 翻历史 |
| `harness.createConversation(opts, ctx)` | 新会话 |
| `harness.signal(taskId, token, key, value, ctx)` | 投递信号 |
| `harness.submission(id, ctx)` | 按 ID 找回提交 |
| `harness.snapshot(doc, scopeId, ctx)` | 读文档 |
| `harness.watchTaskGraph(ctx)` | 任务图 |
| `harness.inspect()` | blocked / 定义问题 |
| `harness.usage(ctx)` | 总花费 |
| `harness.resume()` | 启动调度器，继续未完成 |
| `harness.close(ctx)` | 关闭 |
| `harness.closed` | 关闭/失败的 Promise |

## 2. 决策表

### 等待

| 等什么 | 用什么 |
|---|---|
| 毫秒级、必成功 | 普通 `await` |
| 分钟~小时 | park `sleep` |
| 外部事件/审批 | park `sleep` + signal |
| 自己的子任务 | park `wait` |
| 另一个会话的答案（同 Harness） | `notify` + `SubmissionSettled` |

### replay

| 工具做什么 | 策略 |
|---|---|
| 只读、纯计算 | `"safe"` |
| 副作用 + 外部支持幂等键 | `"safe"` + `api.memo` |
| 副作用 + 无幂等键 | 默认；并让模型先查后写 |
| 等外部事件 | park，不是 replay |

### 投递

| 目的 | 方式 |
|---|---|
| 纠正当前方向 | `whenBusy: "steer"` |
| 补充新任务 | follow-up（默认） |
| UI 事件/审计 | `type: "write"` |
| 不能启动新 run | `whenIdle: "reject"` |
| 忙就拒绝 | `whenBusy: "reject"` |
| 不用打字继续 | `submit({ type: "continue" })` |

### 上下文边界

| 目的 | 方式 |
|---|---|
| 同一件事，缩小上下文 | compaction |
| 换任务/换阶段 | reset |
| 工具主动交接、run 继续 | `control.handoff` |
| 另开一件不相干的事 | 新 conversation |

### 多 agent

| 目的 | 方式 |
|---|---|
| 委派、隔离上下文 | subagent（前台） |
| 常驻助手 | subagent + background anchor |
| 并行取数/汇总 | child tasks + `allSettled` |
| 快速失败 | child tasks + `failFast` |
| 分支尝试 | fork |

### 工具可见性

| 目的 | 方式 |
|---|---|
| 启用/禁用 | `agent.tools` |
| 模型菜单收窄 | `agent.modelTools` |
| 只给程序调 | `tool.callers: ["tools"]` |
| 按需加载 | `deferred` + `tool_search` |
| 运行时拦截 | `beforeTool` |

### 文档作用域

| 状态 | `scope` |
|---|---|
| 整个 Harness 共享 | `session` |
| 每会话 | `conversation` |
| 单 task | `task` |

### 存储

| 场景 | 后端 |
|---|---|
| 测试 | Memory |
| Node 生产 | SQLite |
| 浏览器 | IndexedDB |
| Cloudflare | DO SQLite |
| 本地调试 | JSONL（注意内存） |

## 3. 常用起点（不是硬性默认）

```typescript
settings: {
  stream: { timeoutMs: 120_000 },
  retry: { maxRetries: 3 },
  progress: { partialIntervalMs: 100, outputIntervalMs: 100, persistWithinMs: 1_000 },
  compaction: {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    backgroundTokens: 32_768,
  },
}
```

| 项 | 值 |
|---|---|
| `restartLimit` | 5（`Infinity` 永不为它结束） |
| `maxTurns` | 未设 = 无限制 |
| 工具输出截断 | 2000 行 / 50KB（`read`、`bash`） |
| watch 窗口 | 初始 50，最多 100，滑出后保留 50 |
| ops 整体替换 | 待处理超过 10,000 |
| `afterFailedRun` | `"keep"` |

## 4. `runFailure` 原因

| reason | 含义 |
|---|---|
| `model_error` | 模型调用失败（带 detail） |
| `no_model` | 没配置/模型不存在 |
| `aborted` | 用户停止 |
| `reset` | 被 reset 打断 |
| `interrupted` | 进程在回答中停止，重试用完 |
| `faulted` / `orphaned` | task 出错/孤儿 |
| `restart_limit` | 反复崩溃 |
| `turn_limit` | 达到 `maxTurns` |
| `nothing_to_answer` | continue 时没东西可答 |

## 5. `onReport` 的 kind

| kind | 动作 |
|---|---|
| `storage_failed` | 重开进程（Harness 已死） |
| `task_faulted` | 告警 |
| `task_interrupted` | 统计环境稳定性 |
| `task_error` | 记录 |
| `extension_error` | 修扩展 |
| `host_error` | 修宿主回调 |
| `task_outdated` | 部署问题（没装/版本不匹配） |
| `listener_error` | 修 listener |

## 6. 十个最常见的坑

1. `modelTools` 不是权限：脚本/其他工具仍能调被隐藏的工具。
2. 默认 `replay` 不重跑，但**模型会重试**；副作用仍要幂等。
3. phase 里 `await sleep(...)` 会在重启后重跑，必须切 phase。
4. `onYield` 的答案在 transcript 里，但 `wait()` 没返回；UI 别当最终答案。
5. `afterRun` 跑测试时 `wait()` 已返回 `done`；"已回答" ≠ "已完成"。
6. deferred commit 只适合可丢的进度；配额/账本必须立即落盘。
7. 压缩在阻塞阈值失败会**直接让 run 失败**，不是只影响摘要。
8. 扩展改名/卸载是**静默降级**；重启必须重装。
9. `reserveTokens` 与 `keepRecentTokens` 配不好，会"压完立刻又该压"。
10. 工具输出是账本：大内容放外部，返回引用；transcript 不能删。

## 7. 版本提醒

- 本文代码基于 **v1.6.1**。
- v1.6.1 相对 v1.6.0 只改了返回值形状（park/signal/`admit` 等改为带 `kind` 的标签联合），机制不变；逐项差异见 [3-source-map.md](3-source-map.md#4-v160-与-v161-的差异)。
