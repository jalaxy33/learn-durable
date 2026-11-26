# fork：从某个条目分叉出一条新会话

`forkConversation(parent, at, options)` 建一个新会话，它的 transcript 接着父会话在 `at` 那条条目处的状态往下走。**条目不复制**：新会话只记一条 `parent: { conversationId, at }`，读的时候沿链取。

## Session 与 Harness

```ts
const session = createSession(new MemoryStorage());
```

`Session` 是数据层：会话、条目、文档、提交。`Harness` 在它之上加调度器、模型、任务。这个示例只用 Session，所以能看清分叉本身，不被 run 干扰。

两套读写：

| 在提交里 | 在提交外 |
|---|---|
| `tx.doc(token, id)` → 可写 draft | `session.snapshot(token, id, ctx)` → 只读快照 |
| `tx.appendEntry` / `tx.scanEntries` | `conversation.entries()` / `context()` |

## 文档的 fork 语义

```ts
const Notes = defineDoc<{ text: string }>({
  kind: "example.notes",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ text: "" }),
  checkpointWhen: () => false,
});
```

四个字段决定分叉时文档给什么：

| 字段 | 取值 | 含义 |
|---|---|---|
| `scope` | `conversation` / `session` / `task` | 文档挂在哪一层 |
| `history` | `latest` / `rewindable` | 只保留当前值 / 可按条目回看历史 |
| `fork` | `asOf` / `current` / `initial` | 分叉时取“分叉点那一刻”/“当前值”/“重置成初始值” |
| `checkpointWhen` | 谓词 | 什么时候把增量折成一个新基点；`() => false` 表示永不折 |

`history: "rewindable"` + `fork: "asOf"` 是唯一能“看到分叉点那一刻的值”的组合。内置文档的选择可以对照理解：`pi.live` 是 `latest` + `initial`（进度不继承，分叉得到空），`pi.agent` 是 `latest` + `current`（配置继承当前值）。

实测：

```
fork transcript: [ 'hello' ]
fork notes: { text: 'after hello' }
```

分叉点在 `hello` 之后、`goodbye` 之前，所以 transcript 只有 `hello`，笔记也只是那一刻的值。

## 分叉之后互不影响

```
fork notes after edit: { text: 'changed only in the fork' }
parent notes after edit: { text: 'after goodbye' }
```

写 fork 的文档只产生 fork 侧的新增量，父会话的当前值不受影响。底层是“共享历史、各自追加”的结构，所以分叉便宜、也安全。

## 什么时候用

- **改一句重来**：保留原来的对话，从某个条目分叉，换参数再跑，两条线可以对比。
- **A/B 两个方向**：同一个前提出发，两个分支各走一条。
- **审前/审后对比**：在某个检查点分叉，一条继续用，一条做实验。
- **UI 的“编辑这条消息”**：本质就是 fork + 追加。

注意：分叉的是**会话**，不是 run。分叉出来的会话是空的运行状态，要跑就自己 `submit`；任务和 `pi.live` 都不会跟过来。

## 相关 API

- `tx.forkConversation(parentId, at, { ownership })`：必须给 `ownership`（`ownerless` 或 `task`），因为所有权不会被继承。
- `conversation.fork(at, options, context)`：在 Harness 层同样可用，返回 `Conversation` 句柄。
- `context(context, { at })`：不算真的分叉，只看“如果在这里分叉，模型会看到什么”——做预览用。
- `tx.scanEntries({ conversationId }, limit)`：分页读可见条目，默认最新在前；在提交里读，和在外部用 `entries()` 等价。

## 类型与语法

- `defineDoc<T>` 的 `T` 是文档内容形状，`initial()` 必须返回它。
- `history: "latest"` 的文档不声明 `fork`（类型上互斥），只有 `rewindable` 才能选 `asOf`。
- `commit` 的返回值就是回调的返回值：示例用它拿到 `firstEntry`，后面当分叉点。
- **`(await tx.doc(Notes, chat.id)).text = …`**：`tx.doc` 是异步的（要读当前值），拿到 draft 后直接改字段，提交时落盘。
- `checkpointWhen: () => false`：显式表示“永不合并历史”，适合读多写少的小文档；有历史膨胀顾虑时按增量数返回 `true`。
