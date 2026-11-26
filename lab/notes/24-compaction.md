# 压缩：三条触发路径和一张摘要条目

长对话会把上下文撑爆。durable 保留**全部条目**，但只把“最近一段 + 一张摘要”发给模型。摘要本身也是一条条目（`pi.compaction`），所以压缩不删历史。

## 三条触发路径

| 触发 | 什么时候 | 摘要在哪放置 |
|---|---|---|
| 阈值（后台） | 估算 token 超过 `blocking - backgroundTokens` | 空闲时立刻；忙时等下一个边界 |
| 手动 `conversation.compact(instructions)` | 你调用时 | 摘要作为 write submission 排队，等当前答案结束再放 |
| 溢出 | provider 报“prompt is too long” | generation 压缩后**重试一次**，还超就失败 |

阈值本身有两个数：`reserveTokens`（给回答留的空间，超过 `contextWindow - reserveTokens` 就**阻塞**压缩）和 `backgroundTokens`（提前量，超过 `contextWindow - reserveTokens - backgroundTokens` 就**后台**压缩）。所以后台压缩是“趁还没撞墙先收拾”。

## 摘要是一条条目

```ts
CompactionEntry.is(view.head)   // 当前上下文是不是由摘要开头
view.head.data.reason           // "threshold" | "manual" | "overflow"
```

- 条目的 `model` 是被包好的 user 消息（“The conversation history before this point was compacted into the following summary: …”），模型把它当上下文开头。
- `head` 指向**第一个被保留的条目**，摘要条目自己带 `head: <EntryId>` 标记，所以“从哪开始算”是显式记录的，不靠位置推断。
- 摘要后如果又追加了新的 `pi.system` 位置条目（提示词变化或压缩把旧的压掉了），它会作为新基线出现在上下文最前面。

## 压缩不改历史

```ts
const view = await conversation.context(context);        // 活跃上下文（压缩后）
const stored = await conversation.entries({}, 1000, …);  // 全部条目（只追加）
```

实测里能看到 `4 messages in context, 9 entries stored` 这种组合：被摘要掉的条目仍在存储里，只是不在下一次请求里。要展示完整历史用 `entries()`，要算上下文成本用 `context()`。

## 设置是每次读取的

```ts
const settings = {
  get compaction() {
    return { reserveTokens: 1000, keepRecentTokens: 400, backgroundTokens };
  },
};
```

getter 让 `backgroundTokens = 0` 立刻生效——示例用它关掉后台压缩，好让后面的溢出路径成为唯一触发者。同一手法在 25 里用于“用户改设置立刻生效”。

`keepRecentTokens` 决定摘要后保留多少近处内容；太小会让模型忘了刚发生的事，太大则压缩不省空间。

## 手动压缩的“排队”语义

```ts
const manual = await root.compact("Keep the hotel shortlist", context);   // 返回 taskId
const { state } = await harness.waitForTask(manual, context);
const placement = state.outcome.status === "completed" ? state.outcome.result.submissionId : undefined;
const summary = (await harness.submission(placement!, context))!;
```

- 摘要在后台任务里生成，**不打断正在跑的对话**。
- 生成完成后变成一个 write submission：空闲就立刻放置（`done`），忙就排队（`queued`），等当前答案结束再放。
- 实测就是：`manual compaction finished; its summary is queued` → 答案结束后 `the summary is done`。
- 这就是“压缩和对话并发，但放置遵守边界规则”的完整样子。

## 怎么观察、怎么测

- `fauxProvider({ models: [{ id: "tiny", contextWindow: 3000, maxTokens: 1000 }] })`：造一个极小窗口的模型，几百字就能撞阈值，不用真跑长对话。
- 应答脚本是**函数式**的：检查 `transcript.messages[0]` 是不是摘要请求（系统提示词里含 `summarization`），是就返回摘要；否则返回普通答案。这样同一个假模型既当聊天对象又当摘要器。
- 用 `Promise` 卡住下一次应答（`hold`）来制造“忙”的状态，才能在忙时提交手动压缩。
- 溢出用脚本模拟：返回 `{ stopReason: "error", errorMessage: "prompt is too long" }`，下一次请求前 generation 会压缩再重试。

## 类型

- `CompactionEntry.is(view.head)` 是类型守卫，收窄后才有 `data.reason`。
- `waitForTask` 的结局是联合：`state.outcome.status === "completed"` 之后才有 `result`，`result.submissionId` 是放置摘要那次 write 的 submission id。
- `harness.submission(id, context)` 能把已存在的提交重新拿回来，`status()` 看它现在处于 `queued` 还是 `done`。
- `Message` 的内容是 `string | (TextContent | ImageContent)[]`，取文本要先判 `typeof content === "string"`。

## TS / JS 语法

- **getter 当活设置**：`get compaction() { ... }`，每次读取都重新计算。
- **`Array.from({ length: 100 }, () => respond)`**：造 100 个应答步骤，同一个函数重复用（每次调用时才求值）。
- **`let finishAnswer!: () => void`** + `hold = new Promise(...)`：把“什么时候放行”交给外部。
- **`padEnd(9)`**：对齐打印。
- **`findLast`**：取最后一条用户消息。
- **`repeat(200)`**：造长文本撞阈值。
- **函数式 faux 步骤**：`async (transcript) => AssistantMessage`，能根据上下文决定返回什么。
