# afterTools：每轮工具之后问一句，然后继续或终止

`afterTools` 钩子在工具轮结束、下一次模型请求之前跑。它可以要求任务；run 等这些任务给出结论。结论只有两种用法：**终止这一轮 run**，或者**塞一条 steer 改变下一步**。

## 位置

```
请求 → 工具轮 → afterTools 任务 → 边界放置 → 下一次请求（或结束）
```

对比另外三个钩子：

| 钩子 | 时机 | 能做什么 |
|---|---|---|
| `beforeTool` | 单个调用执行前 | 改参数、拦截、睡在审批 key 上 |
| `afterTool` | 单个调用结果提交前 | 改结果 |
| `afterTools` | 一轮工具全部结束之后 | 终止 run、插 steer、加工具 |
| `onYield` | 答案提交之后 | 判答案算不算数、打回继续 |
| `afterRun` | run 结束之后 | 跑测试、发起修复 run |

## 两种结论

任务的终结结果是 `AfterToolsDecision | null`：

```ts
{ terminate: true }   // 结束这轮 run：不再发请求，答案保持已提交的状态
null                  // 没有结论：按正常流程继续下一轮
```

“继续”不是靠返回值，而是**在终结提交里投一条 steer**：

```ts
await handle.admit(tx, { type: "input", content: "The person says: go on.", whenBusy: "steer" });
```

这条 steer 在下一轮边界被放置，下一次请求就把它当用户消息看到。实测 transcript：

```
> Do the work, step by step
  tool: did step 1
> The person says: go on.
  tool: did step 2
```

模型回答“Not reached.”那次应答**根本没被消费**——`faux.state.callCount` 是 2，`terminate` 之后不再请求。这是它和“用 steer 说停”的本质区别：终止真的省掉一次请求和一次 token 账单。

## 任务本身要睡在信号上

```ts
ask: (task, runtime, ctx) => runtime.commit(
  () => ({ status: "sleeping", checkpoint: { phase: "answered" }, signals: [Choice.key("choice")] }),
  ctx,
),
```

- 等待期间不占进程：`harness.wake()` 返回 `{ active: false }`（没有 deadline，也没活可跑）。人可能过几分钟才点，进程可以休眠。
- 人没答就一直等；想加超时就是再加 `until`，醒来读 `{ kind: "expired" }`（39 的写法）。

## 一个工程细节

任务里同样要**先拿会话句柄，再进提交**：

```ts
const handle = (await runtime.conversation(runtime.conversationId, ctx))!;
await runtime.commit(async (tx) => { await handle.admit(tx, {...}); … }, ctx);
```

`runtime.conversation()` 是运行时读，放进 commit 回调会等这个提交自己。

## 另一个：宿主怎么知道要问谁

钩子不把任务 id 交给宿主，所以示例用了一个进程内 `Set<TaskId>` 记录“正在问的”，宿主轮询它拿 id 去 `harness.signal(...)`。

生产里不能这么写（重启就丢）：把“待确认的问题”放进会话文档（记 taskId + 问题内容 + 操作人），界面从文档读，点确认时按 taskId 投信号。这和 39 的 `inbox` Map 是同一个坑。

## 与 onYield 的分工

- `afterTools`：**过程中**的检查点——“到这一步了，继续吗？”
- `onYield`：**答案之后**的检查点——“这个答案算数吗？”

两个都靠子任务给结论，区别只在时机。想实现“每 N 步让人确认一次”用 `afterTools`；想实现“答案要过审才发布”用 `onYield`。

## 类型

- 任务结果类型写 `AfterToolsDecision | null`，钩子那边由框架解释 `{ terminate: true }`。
- `defineSignal` 的 schema 用 `oneOf(["go on", "stop"])`，`choice` 自动推断成字面量联合，拼错字符串会编译报错。
- `hookTask(AskToGoOn, null)`：输入是 `null` 也要显式传。
- `faux.state.callCount`：假模型被请求的次数，用来验证“真的少发了一次”。

## TS / JS 语法

- **`[...asking][0]!`**：Set 没有下标，先展开成数组再取第一个。
- **轮询等状态**：`while (asking.size === 0) await new Promise((r) => setTimeout(r, 1));`，再加一次 `setTimeout(5)` 让调度器安定。
- **`state?.kind === "value" ? state.value.choice : "stop"`**：信号缺失时退回安全默认（停）。
- **`| null` 当“无决策”**：比造一个空对象更清楚。
- **`as const` 不必到处用**：这里只有 `oneOf` 的字面量数组需要保留字面量类型（`oneOf` 内部处理）。
