# 一轮问答：提交、结算、条目

一次完整的模型调用涉及四件事：把用户输入落盘、跑一个生成任务、把模型结果写成条目、把输入标记为已答。这四件事都在 commit 之内完成，失败就在重启后接着做。

## 提交与结算

```
submit(draft) ──> Submission ──wait()──> SubmissionRecord { status, entry, answer }
```

- `submit()` 把输入**落盘接纳**，返回 `Submission` 句柄，不返回答案。落盘后运行由调度器接手。
- `wait()` 只是这条持久记录的观察者：进程崩了，重开后用 `harness.submission(id, context)` 重新拿到句柄再 `wait()`。结果的权威是存储里的记录，不是内存里的 promise。
- 结算后的 `answer` 是 **EntryId**，指向答案所在的条目，不是答案内容本身。要内容就再去读那条条目。

`SubmissionRecord` 的状态：`queued`（已接纳、还没进 transcript）、`placed`（进了 transcript，归某个运行所有）、`done`（答完了，带 `answer`）、`unanswered`（终态，带 `reason`，不再可能有答案）。

## 只读 commit

`commit(tx => ...)` 的回调里只能读到**已提交**状态，回调的返回值就是这个 commit 的返回值。没有写操作时它就是个一致的读点，不需要另找读接口。

写入口在 `tx` 上：`appendEntry(token, conversationId, draft)`、`createTask()`、`createSubmission()`、`createConversation()`、`signal()`、`doc()`。读入口：`conversation(id)`、`entry(token, id)`、`task(id)`、`submission(id)`、`scanEntries()` 等。

`tx.entry(token, id)` 的第二个参数是条目 ID；`token` 只提供类型和 kind 校验：

```ts
const entry = await root.commit((tx) => tx.entry(AssistantEntry, answered.answer), context);
entry?.model?.[0]; // 该条目的模型消息
```

## 条目

transcript 是一串**不可变、只追加**的条目。每条有 `kind`（`pi.user`、`pi.assistant`、`pi.tool-result`、`pi.system`、`pi.reset`、`pi.compaction`，或自己 `defineEntry()` 的）和该 kind 自己的 `data`。`model` 是这条条目贡献给模型上下文的消息。模型看到的是最新一个 reset 之后的所有条目。

读法是分页的：`entries(query, limit, cursor, context)` 返回 `{ items, cursor }`，默认最新在前。

## 系统提示词

系统提示词不是每轮拼出来的字符串，而是**位置条目**：

- 扩展通过 `section(key, render, { tag })` 贡献段落，`tag: false` 表示原样输出、不包 `<key>…</key>`。段落渲染顺序 = 选中扩展的顺序；会话自己的 `instructions` 最后渲染。
- 渲染结果变化时才追加一条新的 `pi.system` 条目，只把变化的部分再发给模型，provider 的 prompt cache 才不会被打断。所以一段对话里 `pi.system` 条目通常只有一条，不是每轮一条。
- 段落函数每次请求都会跑；返回每次都不同的值（比如当前时间）就破坏了缓存的意义。

`pi.generation` 是内置任务，负责这一整套：渲染提示词 → 需要时追加 `pi.system` → 调模型 → 追加 `pi.assistant` → 结算输入。

## 存储层

`Harness.open(storage, options, context)` 里的 storage 决定“持久”到什么程度。`MemoryStorage` 只是同进程内的内存实现：读、重放、多个视图都对，进程结束就没了。换成 JSONL / SQLite 实现时接口不变，durable 的语义不依赖存储介质。

## 类型

**`context` 显式传递**：底层是 chord 的 `Context`（abortSignal + telemetry + 自定义值），每个 API 的最后一个参数。`BACKGROUND_CONTEXT` 是没有取消信号、telemetry 挂后台的那个，脚本里用它。

**token 携带类型**：`AssistantEntry` 是 `Entry<never>`——运行时是 kind 载体，编译期是类型载体。`tx.entry(AssistantEntry, id)` 得到 `TypedEntry<never> | undefined`；换成 `Entry<{ diagnostics: … }>` 的 token，`data` 就有类型。`defineDoc` / `defineSignal` / `defineTask` 都是这个手法。

**判别式联合**：`SubmissionRecord` 用 `?: never` 把不属于某状态的字段锁死，必须两个条件都收窄：

```ts
if (record.status === "done" && record.type === "input") {
  record.answer; // 到这里才存在
}
```

只判 `status === "done"` 不行：`type: "continue"` 的 done 没有 `entry`。

## TS / JS 语法

- **顶层 await**：`"type": "module"` 下不需要 `main()` 包装。
- **嵌套选项字面量**：`{ agent: { model: { provider, modelId } } }` 是三层普通对象。内层那对花括号是 `model:` 的值，不能单独再包一层 `{ { … } }`——对象字面量里没有键的位置不是合法对象。
- **可选链 + 下标**：`entry?.model?.[0]`。
- **按 role 收窄消息联合**：`reply?.role === "assistant" ? reply.content : reply`，只有 assistant 分支有 `content`。
- **`reverse()` 原地改**：`[...page.items].reverse()` 先复制。
- **工厂 vs 类 vs 静态工厂**：`createRegistry()` / `createModels()` 是工厂，`new MemoryStorage()` 是类，`Harness.open()` 是静态工厂（要 `await` 读存储）。
- **子路径导入**：一个 `exports` 子路径一个入口（`@earendil-works/pi-ai/providers/faux`），不是深层文件路径。
- **`verbatimModuleSyntax`**：纯类型导入必须写 `import type`。
