# 前台 subagent：一个工具调用拥有一个子会话

“agent 调 agent”在 durable 里的形态：父模型的工具调用创建一个**子会话**，子会话归这个调用所有，调用等它答完，把答案当工具结果返回。子会话的 transcript 通过调用的 `details` 暴露给界面。

## 子会话归调用所有

```ts
const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
```

`ownership: { kind: "task" }` 决定三件事：

1. **生命周期**：调用被中止 → 子会话被中止；Harness 重启后由父任务继续持有。
2. **结算顺序**：调用要等它名下的活干完才算终结。所以工具任务会先进入 `completing` 状态（结局已定，但名下还有活），父模型看到的结果一定是子会话的最终答案，而不是“已经派出去了”。
3. **可查找性**：`tx.scanConversations({ ownerTaskId })` 能列出这个调用拥有的会话——这正是幂等重放的抓手。

子会话默认**复制父会话当时的 agent**（模型、thinking level、cwd、扩展、工具），然后显式去掉自己：

```ts
await configure(tx, created.id, { extensions: { remove: [Subagent] } });
```

不去掉的话，子会话也被提供 `subagent` 工具，就会无限递归。

## 幂等：三件套缺一不可

工具声明了 `replay: "safe"`，意思是崩溃后允许重跑。但重跑不能变成“再建一个子会话、再问一遍”，所以：

| 机制 | 挡住什么 |
|---|---|
| `tx.scanConversations({ ownerTaskId: api.taskId }, 1)` 在提交里查 | 重跑找到已创建的子会话，而不是再造一个 |
| `requestId: \`subagent:${api.taskId}\`` 随输入提交 | 重复提交返回原来的记录，子会话不会被问第二次 |
| `replay: "safe"` | 崩溃后调用本身会重跑（默认 `unsafe` 会被记成 `interrupted` 不再执行） |

三者都在提交里，所以“创建子会话 + 提交问题”这件事整体是幂等的。这套写法可以套到任何“工具触发外部副作用”的场景。

## 把子会话暴露给界面

```ts
await api.details({ conversationId: child }, callContext);
```

运行中的 `details` 落在 `pi.live.tools[].details`，调用结束后如果结果不带 `details`，它就成为结果的 details。界面据此知道“这次调用背后有个子会话”，去 attach：

```ts
for (const slot of live.tools ?? []) {
  const child = (slot.details as { conversationId?: ConversationId } | undefined)?.conversationId;
  if (child !== undefined && !attached.has(child)) await attach(child, `${indent}  `);
}
```

`attached` 这个 Set 是必需的：同一个调用槽位会在很多帧里重复出现，不去重会重复 attach。

## 读子会话的答案

```ts
const settled = await (await handle.submit(request, ctx)).wait(ctx);
if (settled.status !== "done" || settled.type !== "input") throw new Error(...);
const text = await answerText(api, settled.answer, ctx);
```

- `settled.answer` 是**条目 ID**，不是文本——和 13 一样，要读回来。
- 读的方式是 `api.commit((tx) => tx.entry(AssistantEntry, answer))`：工具没有独立的读接口，提交里的 `tx` 就是读点；条目 ID 全局唯一，读别的会话的条目也合法。
- 子会话失败（`unanswered`）就 `throw`：工具结果变成错误，模型自己决定怎么补救。

## 前台 vs 后台

这个示例是**前台**：父调用阻塞到子会话答完，模型拿到的是答案本身。适合“委派一个自包含的小任务”。

后台形态（22）不一样：spawn 立刻返回，子会话常驻，父用 steer/follow-up 消息沟通，答案通过信号回报。复杂度高一个量级，只在真需要并发子 agent 时才用。

## 类型

- `api.details` 的值是 JSON，读回来要断言成自己的形状（`{ conversationId?: ConversationId }`）。
- `ToolExecutionApi` 泛型化细节：本示例用默认参数，`details` 就是宽松 JSON。
- `settled.status !== "done" || settled.type !== "input"` 收窄后才能读 `settled.answer`。
- 任务所有权里的 `taskId` 就是 `api.taskId`（当前工具调用自己的任务）。

## TS / JS 语法

- **`satisfies FauxResponseStep[]`**：检查数组元素是否符合类型，但不把元素拓宽成 `FauxResponseStep`（保留具体推断）。
- **`as const`**：`{ type: "input", ..., requestId } as const`，让 `type` 是字面量 `"input"` 而不是 `string`。
- **非空断言**：`(await api.conversation(child, ctx))!`——刚创建的会话一定存在。
- **`new Set<ConversationId>()` + `has/add`**：去重 attach。
- **递归 + 缩进字符串**：`attach(child, `${indent}  `)`，层级直接体现在输出里。
- **早返回收窄**：`print()` 里先 `if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return;`，之后就能安全遍历 `content`。
- **`flatMap` 拼文本块**：`content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")`。
