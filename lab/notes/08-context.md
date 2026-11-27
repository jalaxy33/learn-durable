# context()：条目怎么变成“模型真正收到的消息”

transcript 是**存储里的条目**，请求是**一串消息**。中间那一步推导全在 `conversation.context()`（内部叫 context view）里，规则有五条，不理解它就没法解释“为什么模型看到的是这些”。

## 五个规则

| 规则 | 含义 |
|---|---|
| `head` 标记开新上下文 | 标记之后的条目才进请求；之前的仍在存储里 |
| `edits` 替换/省略早期条目的贡献 | 对话编辑、脱敏、纠正 |
| 中断/报错/延迟的 assistant 消息**不发** | `stopReason: aborted / error / deferred` 的条目不进请求 |
| 工具结果紧跟其调用，按调用顺序 | 存储顺序可能是 b → system → a，请求里是 call(a) call(b) result(a) result(b) |
| 缺结果的调用补一条**合成的错误结果** | fork 在调用中途、崩溃在结果之前 |

还有一条隐含的：没有 `model` 的条目（纯应用数据）对请求零贡献。

## 实测对照

存储里的活跃条目（`view.entries`）：

```
[ 'message', 'message', 'message', 'message', 'pi.system', 'message', 'message', 'edit', 'note' ]
```

推导出来的请求消息（`view.messages`）：

```
system: {"cwd":"<cwd>/repo</cwd>"}          ← pi.system 条目，位置不变
user: read files a and b                    ← 原本是 "read a and b"，被 edit 替换
assistant: reading call(a) call(b)          ← 工具调用
result(a)                                   ← 存储顺序是 b 先到，这里按调用顺序排
result(b)
assistant: a and b look fine
```

三件值得注意的事：

- **`I crashed` 那条（`stopReason: "aborted"`）完全不在消息里**——存储里有，请求里没有。
- **结果被重排**：存储是 `b`、`pi.system`、`a`，请求里必须是“调用之后紧接它自己的两个结果”，且按调用顺序 a、b。
- **`note` 条目没出现**——它没有 `model`，只用于显示。

## fork 在调用中途

```ts
const cut = await transcript.fork(calls.id, { ownership: { kind: "ownerless" } }, context);
```

```
fork messages: [
  'user: read a and b',
  'assistant: reading call(a) call(b)',
  'result(a) error',
  'result(b) error'
]
```

分叉点在工具调用那一条，之后的结果还没发生。`context()` 不会留下“悬空的调用”——**给两个调用补上合成的错误结果**。（注意分叉也带回了编辑前的 `read a and b`，因为编辑发生在分叉点之后。）

这条规则的实际意义：崩溃在“模型调用了工具但结果还没写入”时，重启后的请求仍然是合法的（模型看到“这两个调用失败了”），而不是一个半截的对话。

## head 标记：换上下文但不删历史

```ts
await transcript.commit((tx) => tx.appendEntry(transcript.id, {
  kind: "summary", head: "self",
  model: [{ role: "user", content: "Summary: a and b are fine.", timestamp: 5 }],
}), context);
```

```
after summary: summary [ 'user: Summary: a and b are fine.' ]
```

`head: "self"` 表示“上下文从这条自己开始”，于是请求里只剩这条摘要。`view.head` 指向它；压缩（24）、reset、handoff 用的都是这个机制。

**历史一条都没删**：

```
newest stored entries: [ 'summary', 'note', 'edit' ] more: true
```

`entries()` 分页读的是存储（最新在前，含继承来的父条目），`context()` 读的是“这一次请求要发什么”。两个 API 分工明确：

| 想问 | 用 |
|---|---|
| 完整历史 / 客户端 transcript | `entries()`（配合 31 的分页/缺口） |
| 这次请求的 token 成本、模型看到什么 | `context()` |
| 哪个 head 在生效 | `view.head`（类型守卫：`CompactionEntry.is(...)` 之类） |

## 调试时怎么用

模型“莫名其妙”的行为，先看三样：

```ts
const view = await conversation.context(ctx);
view.head;      // 是不是被压缩/重置了
view.messages;  // 它到底看到了什么（顺序、内容、有没有合成错误）
view.entries;   // 存储里都有什么（可能是 edit / 不发 的消息）
```

## 类型与语法

- `ContextView = { head, entries, contributions, messages }`：`contributions[i]` 是 `entries[i]` 贡献的消息（经过 edit 调整后），`messages` 是最终请求。
- `edits: [{ target, action: "replace", messages: [...] }]`：编辑是指向某个条目的操作，不是改写条目本体。
- `head: "self"` 是特殊值：指向这条条目自己。
- `stopReason` 决定 assistant 消息发不发：`stop` / `toolUse` / `length` 会发，`aborted` / `error` / `deferred` 不发。
- 手写 `Message` 对象时要补齐 `api`、`provider`、`model`、`usage`、`timestamp`（示例里的 `assistantMessage()` 就是最小骨架）。
