# child tasks：一个任务拥有并等待一组子任务

父任务把工作拆成子任务，一次提交里建完并进入等待。等待期间不占调用；父任务的 abort 会先级联到子任务，等它们结束后才跑父的 abort。

## 建子任务 + 进入等待，一次提交

```ts
await runtime.commit(async (tx) => {
  const payments = [];
  for (const card of task.input.cards) {
    payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
  }
  return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
}, ctx);
```

三个要点：

- `ownership: { kind: "task", taskId: task.id }` 决定这是子任务：跟着父任务的生命周期走，出现在任务图的父节点下面。
- 建任务和“进入等待”在**同一个提交**里：要么全部存在并等着，要么什么都没发生。
- `on` 列出等谁，`policy` 决定怎么等。等待期间任务不持有调用，存储里记着它在等哪些 id。

## 三种等待策略

| policy | 什么时候继续 |
|---|---|
| `allSettled` | 全部终结（默认常用） |
| `failFast` | 任一失败就中止其余，然后继续 |
| `any` | 任一终结就继续（其余仍在跑） |

`failFast` 只中止**兄弟任务**，不中止父任务——父任务照常进入下一阶段，由它自己决定这单生意的结论。实测：

```
  payment visa-1 aborted, refunded
  payment visa-3 aborted, refunded
  payment visa-4 aborted, refunded
  payments: aborted, failed, aborted, aborted
  checkout: failed
```

`expired-2` 立刻失败，另外三个（已扣款、正睡在确认上）被中止并各自退款；父任务拿到四个结局后决定 `failed`。`outcomes()` 保持传入顺序，不是完成顺序。

## 副作用要能被 undo

子任务的 `abort` 在新的一次调用里跑，用来撤销已经生效的外部效果：

```ts
abort: async (task, runtime, taskContext) => {
  const refunded = charged.delete(task.input.card);   // 撤销扣款
  console.log(`  payment ${task.input.card} aborted${refunded ? ", refunded" : ""}`);
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
},
```

注意 `aborted` 是**结局状态**，和 `failed` 不同：前者是“被叫停”，后者是“自己出错”。业务上通常要区别对待。

## 取消的级联顺序

```
  example.checkout 12: waiting on 13, 14, 15, 16
    example.payment 13: sleeping
    …
  payment visa-5 aborted, refunded
  …
  checkout aborted
  checkout: aborted
```

`harness.abortTask(id)` 先标记，然后：

1. 父任务名下**普通**的子任务被中止（各自的 `abort` 跑完）；
2. 全部结束后，父任务自己的 `abort` 才跑——所以父的清理能看到子任务的最终状态，不会和它们抢资源。

“普通子任务”这个限定很关键：`background: true` 的任务不在普通作用域里，父的取消不会碰它们（后台 subagent 就靠这个活下来）。

## 观察任务图

```ts
const graph = await harness.watchTaskGraph(context);
printGraph(graph.value);
await graph.stop();
```

`TaskGraph` 里是 `tasks`（按 id 索引的记录），每个节点带 `owner`、`kind`、`state`。`state.status` 有 `running` / `pending` / `waiting`（带 `on` 列表）/ `sleeping`（带 `until`）/ `completing` / `blocked`。

渲染只需要一层筛选：`owner === undefined` 是顶层，其余按 `owner` 挂到父节点下面。这是“任务在干什么”的唯一权威视图，比日志可靠。

## 崩溃后继续

关闭 Harness（进程消失）、重新打开同一份 SQLite，然后 `waitForTask(id)`：

```
  payments: completed, completed, completed, completed
  checkout: completed
```

没有手工恢复动作：`waitForTask` 本身开启调度，存活的子任务按检查点继续，父任务等到全部终结后进入 `decide`。

## 类型与语法

- `defineTask<I, S, R>` 里 `S` 的两个阶段各自带自己的字段，`decide` 阶段才能访问 `checkpoint.payments`。
- `TaskId<PaymentResult>`：带结果类型的任务 id，`runtime.outcomes(ids)` 据此推断 `result` 的类型。
- `policy: "failFast"` 是字面量联合，拼错编译报错。
- `Object.values(graph.tasks)`：图是按 id 的 Record，渲染前先转数组。
- `for (const child of nodes.filter((candidate) => candidate.owner === node.id))`：父子关系直接由 `owner` 字段表达，不需要额外索引。
- `harness.abortTask` 返回 `"marked" | "terminal"`；`waitForTask` 返回 `SettledTask`（`state.status` 已收窄成 `terminal`）。
