# turn limit 与 continue：给 loop 装刹车和继续键

一次 run 能跑多久由 `agent.maxTurns` 限制（工具轮的次数）。到顶不是错误，而是**可恢复的停止**：run 以 `turn_limit` 结束，宿主可以在合适的时候提交 `continue` 接着跑，预算重新开始。

## 上限存在会话上

```ts
const root = await harness.root(context, { agent: { model: {...}, maxTurns: 2 } });
```

- 和模型一样存在会话的 `pi.agent` 里，**子会话和 fork 继承**。
- 计的是“工具轮”，不是消息数：一次工具调用 → 结果 → 下一次生成算一轮。
- 未设 = 不限制。

## 到顶之后是什么状态

```
first run: unanswered turn_limit (2 turns)
```

- 输入结算为 `unanswered`，`reason: "turn_limit"`。
- `pi.live.runFailure` 带 `reason` 和给人看的 `detail`（`"2 turns"`），保留到下一次运行开始——界面据此显示“已达轮数上限，继续？”。
- 已经完成的工具轮**都有效**：条目都在，下一轮接着用。

## continue：不带用户消息继续

```ts
const resumed = await root.submit({ type: "continue" }, context);
```

- 在**当前上下文**上直接开一轮（上下文以工具结果结尾，模型有东西可答）。
- **预算重置**：`turns` 从 0 开始。所以 4 步工作需要两次 continue（第一次也只跑 2 轮）。
- **从不排队**：忙时抛 `ConversationBusy`，因为“是否有东西可继续”取决于当前 run 怎么结束。
- 没有可答的东西时（空上下文，或上下文以答案结尾）**不发请求**，直接 `unanswered` + `nothing_to_answer`。

```
second continue while busy: ConversationBusy
first continue: unanswered turn_limit   ← 又是 2 轮
second continue: done (runFailure cleared)
continue after the answer: unanswered nothing_to_answer
```

`runFailure` 在下一轮开始时被清掉，所以 `done` 之后快照里已经没有它。

## 宿主要做的判断

- 看到 `turn_limit`：显示“继续”按钮，或自动 continue（但要设**总次数上限**，否则就是没有刹车）。
- 看到 `nothing_to_answer`：说明用户点了一次“继续”但没什么可接的——提示他直接提问。
- 其它 `runFailure` reason（`model_error`、`restart_limit`、`aborted`…）语义不同，不能一律当“再点一次继续”。

这条机制的价值在于：长任务可以**被人按下暂停**，而不是一口气跑到底。真实产品里通常配合 onYield（45）把“要不要继续”变成一次审查。

## 读 transcript 的顺序

```ts
const page = await root.entries({ order: "ascending" }, 100, undefined, context);
```

`order: "ascending"` 从旧到新（默认最新在前）。配合 `message.stopReason === "stop"` 只打印最终答案、跳过工具调用的中间应答，是最常用的“人工检查 transcript”写法。

## 类型

- `ConversationBusy` 是导出的错误类，用 `instanceof` 判断，别比字符串。
- `entries` 的 `order` 属于查询条件，和 `conversationId` 一样在 query 对象里。
- `live?.runFailure` 可选：运行正常时不存在。
- `fauxAssistantMessage(fauxToolCall(...), { stopReason: "toolUse" })` 造一次工具调用应答，没有 `toolUse` 的就是最终答案。

## TS / JS 语法

- **`defineTool` + `num()`**：参数 schema 推断出 `args.n: number`，`execute` 里直接 `args.n`。
- **`instanceof` 收窄错误**：`if (!(error instanceof ConversationBusy)) throw error;`——只吞掉预期的那种。
- **`flatMap` 拼文本**：`content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")`。
- **`message.content[0]?.type === "text"`**：数组元素可能是文本或图片，先判再取。
- **同一函数造多个应答**：`const call = (n) => fauxAssistantMessage(...)`。
