# subagent 等子会话：park 在结算信号上

父工具把任务派给子会话，然后 **park 在“子会话的输入结算”这个信号上**，而不是 `await handle.submit(...).wait()`。子会话自己也可能 park（等一个人回答），于是整条链上没有任何东西占进程。

## 和 21 的差别

| | 21 前台 subagent | 43 |
|---|---|---|
| 父等子 | `await handle.submit(...).wait(ctx)` | `return { kind: "sleep", signals: [SubmissionSettled.key("answered")] }` |
| 等待期间 | 父调用持有 invocation | 父调用 park，**不占进程** |
| 适合 | 子任务短时间内答完 | 子任务要等人、要等外部事件，可能很久 |

21 的写法简单直接，但子 agent 花十分钟等人时，父调用也一直占着进程。43 把“等”变成可持久化的 park。

## `notify` 是这条链的接线

```ts
await handle.submit(
  { type: "input", content: task, requestId: `subagent:${api.taskId}`,
    notify: { taskId: api.taskId, key: "answered" } },
  ctx,
);
return { kind: "sleep", signals: [SubmissionSettled.key("answered")] };
```

- `notify: { taskId, key }` 表示“这条提交结算时，把结算记录作为 `SubmissionSettled` 信号投给这个任务的这个 key”。
- 投递发生在**结算的那次提交里**，所以不存在“信号丢了”的窗口。
- 信号的值就是 `wait()` 会返回的那条记录（含 `status`、`answer` 等）。

`SubmissionSettled` 是内置信号 token，不用自己 `defineSignal`。

## 工具的三段式

```ts
const state = await api.readSignal(SubmissionSettled, "answered", ctx);
if (state?.kind === "value") { …读答案返回… }          // ① 子会话已经结算
const extensions = …                                    // ② 还没派
const child = await api.commit(... createConversation …);
await handle.submit({ …notify… });
return { kind: "sleep", signals: [SubmissionSettled.key("answered")] };  // ③ park
```

醒来重跑时，第一段就读到值，直接返回。`readSignal` 的三态和 40/42 一样：`undefined`（还没来）/ `{kind:"value"}` / `{kind:"expired"}`。

## 醒来后的处理

```ts
if (settled.status !== "done" || settled.type === "write")
  return { output: [{ type: "text", text: `Subagent ended: ${settled.status}` }], isError: true };
const answer = await api.commit((tx) => tx.entry(settled.answer), ctx);
```

- 子会话没答成（`unanswered`、被中止、孩子自己失败）→ 返回**错误结果**，父模型能看见“子代理失败了”，而不是抛出去。
- 成功时 `settled.answer` 是条目 id，用一次只读 commit 把它读回来（`tx.entry` 不带 token 时返回通用记录）。这也是“读任何条目”的标准姿势。

## 幂等

和 21 一样三件套：`replay: "safe"`、`tx.scanConversations({ ownerTaskId })` 找回已建的子会话、`requestId` 让重复提交返回原记录。区别只在等待方式。

## 零进程的三个层次

```
parent call: subagent sleeping
wake while everything waits for the person: { active: false }
```

三层都停住：

1. 父的 `subagent` 调用 → 睡在 `SubmissionSettled` 上；
2. 子会话的 generation → 等它的工具轮；
3. 子的 `ask_person` 调用 → 睡在人的回答上。

没有 deadline，所以 `wake()` 是 `{ active: false }`——人可能第二天才回，进程可以彻底退掉。人答了 → 子会话答完 → 结算信号 → 父调用醒来 → 父模型收尾。

## 类型与语法

- `SubmissionSettled` 的值是结算记录联合：先判 `status === "done"`，再判 `type !== "write"`（write 没有 `answer`），才读 `settled.answer`。
- `api.agent(ctx)` 读解析后的 agent（含 `extensions`），用来算“父的选择减去自己”。
- `tx.entry(id)` 不带 token → `EntryRecord`；带 token（如 `AssistantEntry`）→ 收窄后的条目。
- `message.content.filter((part) => part.type === "text")` 直接产出 `TextContent[]` 当 output（工具输出允许文本块数组）。
- `const [question] = asked.keys(); question!`：`noUncheckedIndexedAccess` 下要断言。
