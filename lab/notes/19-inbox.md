# inbox：忙的时候提交会怎样

对话“忙”是指有一个运行正在处理输入。此时再提交不会失败，而是按类型排队：**steer** 在当前工具轮之后插入，**follow-up** 等这次运行答完再开新一轮。

## 四种去向

```ts
await root.submit({ type: "input", content: "..." });                       // 忙时排队，作为 follow-up
await root.submit({ type: "input", content: "...", whenBusy: "steer" });    // 忙时排队，作为 steer
await root.submit({ type: "input", content: "...", whenBusy: "reject" });   // 忙时抛 ConversationBusy
await root.submit({ type: "input", content: "...", whenIdle: "reject" });   // 空闲时抛 ConversationIdle
```

- `whenBusy: "reject"` 抛错，**什么都不写**（不是先写再回滚）。
- `whenIdle: "reject"` 让这条输入永不自己开一轮，只能插进正在跑的工作；配合 `whenBusy: "steer"` 就是“只有忙的时候才接受”。
- 抛出的错误带会话号，例如 `Conversation 1 is busy`。
- “答完了但在等 `afterRun` 任务”仍算忙，此时输入会排队并开下一轮。

## 排队长什么样

队列是会话文档 `pi.inbox`（`InboxDoc`），文档里是 `{ items: [...] }`，按 ID 顺序：

```ts
const inbox = await harness.snapshot(InboxDoc, root.id, context);
// { items: [ { id, mode: "followUp" | "steer", content, entry? }, { id, mode: "write", entry } ] }
```

读出它就能做“排队中”的 UI。排队项的 `id` 就是 submission id。

## 撤回

```ts
await withdrawn.abort(context);   // "aborted" | "already_placed" | "settled"
```

只能撤回**还没被放置**的提交。已放置（`already_placed`）或已结算（`settled`）的撤不回来。撤回后那条提交结算为 `unanswered`，`reason: "aborted"`。

## 边界：什么时候放行

| 事件 | 放置什么 |
|---|---|
| 当前工具轮结束 | steer |
| 这次运行答完 | follow-up（并开下一轮）；排队中的 write 也在这里 |
| `conversation.abort()` | 撤回排队的输入（排队的 write 留着） |

`settings.steeringMode` / `followUpMode` 决定一次放一个还是全放：默认 `"one-at-a-time"`，设成 `"all"` 就一次把队列里的同类都放出来，一起开一轮。默认值就在 `HarnessOptions.settings` 上，整仓生效。

## write：不等模型，也不排队

```ts
await root.submit({ type: "write", entry: { kind: "app.note", data: "..." } });
```

只有 `kind` + `data` 的 write 改变不了模型能看到的东西，所以**忙的时候也立刻追加**，不进 inbox。这就是聊天里“我发出去的消息马上就出现在窗口里”的实现方式，代价是它可能出现在更早提交、但还在排队的项前面。

例外两条：

- 排队的 reset 之前，write 会等——否则 reset 会把它挡在旧上下文里。
- 带 `model`、`head` 或 `edits` 的 write 会改变模型上下文，按 steer 处理，等边界。

## 输入也可以不是 `pi.user`

`entry` 可以给输入换一个 kind：transcript 里记成你的类型，模型仍然看到 `content` 作为用户消息。适合做“@某人”“文件引用”这类条目。kind 不能以 `pi.` 开头（那是系统保留的）。

## 运行失败之后

队列不清空：失败后剩下的项留在 inbox，直到下一次输入、write 或 continue 把它们放出来（按 ID 从旧到新）。

失败原因在 `pi.live.runFailure` 里，直到下一次运行开始：`model_error`、`no_model`、`aborted`、`reset`、`interrupted`、`faulted`、`orphaned`、`restart_limit`、`turn_limit`、`nothing_to_answer`。这些运行的输入同时结算为 `unanswered`，reason 与之一致。

想接着跑但不想打字，提交 `{ type: "continue" }`：它不排队（忙时抛 `ConversationBusy`），而是在现有上下文上直接开一轮，让模型回答上次留下的用户消息或工具结果。上下文里没有可答的东西（空、或结尾是答案）时，运行不开请求，直接 `unanswered` + `nothing_to_answer`。

## 类型

- `Submission.abort()` 返回三态联合，不是布尔：`aborted` 才是真撤回了。
- `Submission.wait()` 返回 `SettledSubmissionRecord`：只会是 `done` 或 `unanswered`，所以 `status` 可以直接比较。
- `InboxItem` 本身是联合：用户输入项有 `content` 和可选 `entry`，write 项只有 `entry`。
- `settings` 里的 `steeringMode` / `followUpMode` 类型是 `"all" | "one-at-a-time"`。

## TS / JS 语法

- **延时触发器**：`let release!: () => void` + `new Promise((resolve) => { release = resolve })`，把“什么时候放行”交给外部控制；`!` 用在声明上表示“稍后一定赋值”。
- **异步的 faux 步骤**：`const slow: FauxResponseStep = async () => { await held; return fauxAssistantMessage(...) }`——应答可以是一个等 Promise 的函数，用它模拟“模型答得慢”。
- **`.catch` 接住预期错误**：`await root.submit(...).catch((error: Error) => ...)`，比 try/catch 窄，适合只处理一处。
- **多参数同签名的小函数**：`const status = async (name: string, submission: Submission) => { ... }`，用来批量打印五条提交的结算结果。
- **可选链读文档**：`inbox?.items.map(...)`，文档可能不存在（空会话）。
