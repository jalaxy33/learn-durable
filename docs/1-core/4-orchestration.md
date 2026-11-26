# 4. 编排：多个 agent 怎么协作

> durable 不用"递归调用一个函数"来做子 agent，而是把子 agent 做成**另一个真实会话**，用所有权树管理生死。于是取消、忙闲、清理都有确定答案。

版本：pi-durable **v1.6.1**。

## 你会学到

- 所有权树为什么是控制结构，而不只是记账
- abort 为什么自下而上、父任务为什么不能比子任务先结束
- 前台 subagent 和后台 subagent 的差别
- child task 的三种等待策略：`allSettled` / `failFast` / `any`
- task graph 能看什么、不能看什么
- fork 和 subagent 分别适合什么

---

## 1. 设计问题

多 agent 协作常见三种做法：

| 做法 | 问题 |
|---|---|
| 递归调用一个函数 | 父崩了子成孤儿；取消传不下去；结果只存在于调用栈 |
| 全局 actor 池 | 谁拥有谁不清楚；清理靠猜 |
| 手动维护 task 表 | 容易漏；abort/重启时到处补逻辑 |

durable 的答案：

> **每个 task 都有 owner；会话也可以被 task 拥有。所有权树同时决定 abort 级联、忙闲判断和清理顺序。**

```text
Conversation
  └─ pi.generation (run)
       ├─ pi.tool (工具调用)
       │    └─ Conversation (subagent 子会话)
       │         └─ pi.generation ...
       └─ 你的 task (afterRun / 自定义)
            └─ 子 task（并行支付、并行检索…）
```

---

## 2. 所有权与 abort

| 规则 | 含义 |
|---|---|
| 每个 task 都有 owner | 会话，或另一个 task |
| abort 自下而上 | 先 abort 子，再跑父的 abort handler |
| 父空闲 = 子也空闲 | 前台子任务未结束，父不算 idle |
| 子失败会 abort 自己的子树 | 失败/中止的 outcome 先清理拥有的工作 |
| `background: true` 是边界 | 它拥有的工作不随父 abort，也不让父保持 busy |

最后一条很重要：

- 前台子会话：父被 Esc、父工具抛错、父崩溃 → 子一起被杀。
- 后台子会话：父的 Esc、`waitForIdle`、`root.abort()` 都到边界为止；只有 `root.abort({ background: true })` 会杀它。

> 设计取舍：结构化并发（父不先于子结束）消除了孤儿，代价是父的完成时间取决于最慢的子。

---

## 3. Subagent：子会话，而不是函数

### 前台 subagent

```typescript
defineTool({
  name: "subagent",
  description: "Delegate a self-contained task and get its answer back.",
  parameters: obj({ task: str() }),
  replay: "safe",
  execute: async (args, api, context) => {
    const child = await api.commit(async (tx) => {
      // 重跑时复用同一个子会话
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;

      const created = await tx.createConversation({
        ownership: { kind: "task", taskId: api.taskId },
      });
      // 子会话默认复制父会话的 agent；这里换便宜模型、去掉递归
      await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
      return created.id;
    }, context);

    await api.details({ conversationId: child }, context); // UI 能挂到子会话

    const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
    const settled = await (await (await api.conversation(child, context))!.submit(request, context)).wait(context);
    return { output: [{ type: "text", text: settled.status }] };
  },
});
```

四个不能省的设计点：

| 设计 | 为什么 |
|---|---|
| 在 `api.commit()` 里创建 | 创建子会话和归属记录原子 |
| 先 `scanConversations({ ownerTaskId })` | 崩溃重跑复用同一个子会话 |
| `replay: "safe"` | 允许重跑；配合上一条才安全 |
| `requestId: subagent:${taskId}` | 子会话里的输入也幂等 |

实测（`21` / `23`）：

```text
21: subagent → "2, 3, and 5."；父会话复述同一答案
23: payments: aborted, failed, aborted, aborted
    checkout: failed
```

### 后台 subagent

把子会话挂在一个 `background: true` 的 anchor task 上：

```text
父会话
  └─ background anchor task
       └─ 子会话（常驻）
```

效果：

- 父的 Esc、`waitForIdle` 不影响子。
- 子有结果时，由另一个 reporter task 把答案作为 follow-up 投回父会话。
- `requestId` 防止重启后重复发送/重复报告。

代价：资源常驻、要显式 stop、父"空闲"时它可能还在花钱。

---

## 4. Child tasks：并行与汇合

不需要子会话，只需要"并行做几件事再汇总"时，用 task：

```typescript
pay: async (task, runtime, context) => {
  await runtime.commit(async (tx) => {
    const payments = [];
    for (const card of task.input.cards) {
      payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
    }
    return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
  }, context);
},
decide: async (task, runtime, context) => {
  const outcomes = await runtime.outcomes(task.state.checkpoint.payments, context);
  // 汇总，提交父任务 outcome
},
```

### 三种等待策略

| policy | 何时恢复 | 其他子任务 |
|---|---|---|
| `allSettled` | 全部结束 | 不受影响 |
| `failFast` | 第一个失败时 | **其余被 abort** |
| `any` | 第一个结束 | 继续跑 |

`on` 也可以等不属于自己的 task，但只能用 `allSettled` / `any`。

### `completing`：父不能先于子结束

> A task that finishes while work it owns is still running is `completing`.

```text
decide 提交 outcome → 状态 completing
  → 等所有子 task 真正结束
  → 才变 terminal；waitForTask() 这时才返回
```

失败的 outcome 会先 abort 拥有的工作。所以：

- 父的 abort handler 在子清理完之后才跑。
- 已完成的子任务需要父在业务上处理（比如退款已成功、另一笔失败）。

---

## 5. Task graph：看清整棵树

```typescript
const graph = await harness.watchTaskGraph(context);
graph.start(async (call) => {
  if (call.kind !== "value") return;
  for (const node of Object.values(call.value.tasks)) {
    console.log(node.id, node.kind, node.state.status, node.owner ?? node.conversationId);
  }
});
```

节点有：

- `owner`（父 task，或空 = 会话拥有）
- `status`：`pending` / `running` / `waiting`（带 `on`、`policy`）/ `sleeping`（带 `until`、`signals`）/ `completing`
- `background` / 是否被标记 abort
- 它拥有的 conversations

三个边界：

1. **只列 live task**；terminal 的会消失。
2. **重启后 `running` 显示为 `pending`**，直到真的再跑。
3. **blocked 原因不在图里**；用 `harness.inspect()` 看 missing/too old/migration failed。

---

## 6. Fork：另一个会话，不是子 agent

```typescript
const fork = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
```

| | fork | subagent |
|---|---|---|
| 关系 | 独立会话，共享到 `entryId` 的历史 | 子会话，owner 是 task |
| agent | 父会话在 `entryId` 时的配置 | 默认复制 owner 会话，可 configure |
| provider 身份 | **新的** | 新的 |
| 生命周期 | 完全独立 | 跟父的 abort/忙闲 |
| 用途 | 分支尝试、A/B、回到决策点 | 委派、隔离上下文、并行 |

fork 之后两边各跑各的，父的后续改动不会同步。

---

## 7. 设计取舍

| 选择 | 优点 | 代价 |
|---|---|---|
| 子 agent 是真实会话 | 可观察、可恢复、可独立 abort | 资源翻倍、要防递归 |
| 所有权树 | 取消和清理确定 | 父等最慢的子 |
| `failFast` | 快速失败、省资源 | 其他结果丢失 |
| `background` | 解耦生死 | 父"空闲"时仍可能花钱 |
| fork | 分支便宜 | 新 provider 身份，缓存从零 |

---

## 8. 自检

1. 前台 subagent 是 `replay: "safe"`，但子会话的模型调用失败。工具会怎样？子会话会怎样？
2. 父任务 `failFast` 等 4 个支付，第 2 个失败。剩下两个会怎样？父任务什么时候 terminal？
3. 一个 background subagent 正在跑。`waitForIdle()` 会等它吗？`root.abort()` 会杀它吗？
4. 什么时候用 fork，什么时候用 subagent？

答案：[2-self-checks.md](../3-appendix/2-self-checks.md#4-编排)。

---

## 9. 相关

- 上一篇：[3-control.md](3-control.md)
- 下一篇：[5-runtime.md](5-runtime.md)
- 术语：[1-glossary.md](../3-appendix/1-glossary.md)
- 原文：More Conversations and Forks、Abort and Subagents、Child Tasks、Task Graph
- 对应示例：`21-subagent-foreground`、`22-subagent-background`、`23-child-tasks`、`42-parallel-children`、`43-subagent-waits`
