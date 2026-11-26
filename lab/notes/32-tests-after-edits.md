# afterRun：跑完之后的收尾工作，以及自修正 loop

`afterRun` 钩子在“答案已提交、输入已结算”之后跑，可以要求任务；run 要等这些任务结束才算完，期间会话仍是“忙”。用它实现“改过文件就跑测试，不过就发起一次修复”的标准闭环。

## 钩子在哪一刻跑

顺序是固定的：

1. 答案提交，输入结算 `done`（`wait()` 这时返回）。
2. 问 `afterRun` 钩子；它返回 `{ tasks: [...] }` 就创建这些任务（本次 run 的子任务）。
3. run 等这些任务结束；`pi.live.run.afterRun` 列出它们，所以会话仍忙，`waitForIdle()` 包含它们。
4. 任务全部终结 → run 结束。

实测：

```
answered: done
busy with after-run tasks: true
```

`wait()` 已经返回 `done`，但会话还忙——这正是“答案先交付、收尾后完成”的设计。

## 判断“这次 run 改了文件吗”

```ts
const range = { minEntryId: run.first, maxEntryId: run.last, order: "ascending" } as const;
const { items } = await api.entries(range, 1000, undefined, ctx);
const edited = items.some((entry) => {
  const message = entry.model?.[0];
  return ToolResultEntry.is(entry) && message?.role === "toolResult" && message.toolName === "edit";
});
```

- `run.first` / `run.last` 是本次 run 的条目区间（第一条它自己的输入/答案，到最后一条）。按条目区间扫，比“猜最近发生了什么”精确，也不受压缩影响（压缩不删条目）。
- 判据落在工具结果上（`toolName === "edit"`），而不是字符串匹配。
- 没改就返回 `undefined`，什么都不创建。

## 任务里做两件事，一次提交

```ts
const conversation = (await runtime.conversation(runtime.conversationId, ctx))!;
await runtime.commit(async (tx) => {
  if (!result.passed && task.input.attempt < 3) {
    await conversation.admit(tx, {
      type: "input",
      content: `The tests failed: ${result.output}. Fix it.`,
      whenBusy: "followUp",
      requestId: `fix-${task.input.attempt}`,
    });
  }
  await tx.appendEntry(runtime.conversationId, { kind: "app.tests", data: result });
  return { status: "terminal", outcome: { status: "completed", result: result.passed } };
}, ctx);
```

三个细节：

- **先拿句柄，再进提交**：`runtime.conversation()` 是运行时读，放在 commit 回调里会等这个提交自己（死等）。注释特意点出了这一点。
- **`admit` 在提交里**：把“投一条修复输入”和“记录测试结果、任务终结”写成一个原子步骤。任一步失败都不存在。
- **`requestId`**：崩溃重跑时同一个 id 返回原记录，不会重复投递修复请求。

`whenBusy: "followUp"` 表示排队，等当前 run 结束再开一轮——不会打断。

## 谁来踩刹车

每个修复 run 都会**重新问一次 `afterRun`**（新 run、新的轮数预算），如果测试一直不过就会无限循环。示例把刹车放在扩展里：

```ts
if (!result.passed && task.input.attempt < 3) { … }
return edited ? { tasks: [hookTask(RunTests, { attempt: ++attempts })] } : undefined;
```

`attempt` 进任务输入，跟着任务持久化；`++attempts` 在内存里，重启会归零——所以真正的幂等保障是 `requestId`，次数上限只是防跑飞。

## 排队顺序

测试跑的同时用户提问：

```
> Are the tests green now?
agent: Not yet: add subtracts. The fix is queued next.
> The tests failed: add(1, 2): expected 3, got -1. Fix it.
agent: Fixed: add adds now.
tests: 1 passed
```

follow-up 按入队顺序放置，所以先来的用户提问先跑；修复输入在它之后。两条用户输入、两次 run、两次测试记录（`app.tests` 条目）就是这次会话的全部形状。

## 类型

- `hook(GenerationTask, { afterRun })`：`GenerationTask` 是内置任务的 token，`afterRun` 拿到 `{ first, last }`（条目 ID）和 `api`（读、memo、`now()`、`models`）。
- `hookTask(RunTests, input)` 把一个任务定义 + 输入包成“请求的任务”。
- `runtime.commit` 的返回值是任务状态联合：`{ status: "terminal", outcome }` 才算结束。
- `app.tests` 是自定义条目 kind，读的时候 `entry.data` 断言成自己的形状。
- `as const` 用在 `range`（`order: "ascending"` 要是字面量）和 abort 的返回值上。

## TS / JS 语法

- **`Array.prototype.some` + 类型守卫**：`items.some((entry) => ToolResultEntry.is(entry) && …)`。
- **`!` 断言**：`runtime.conversation(...)!`——本次 run 的会话一定存在。
- **`++attempts` 内联自增**：`{ attempt: ++attempts }` 先加再取。
- **`entry.data as { output: string }`**：自定义条目数据在类型上是 JSON，用处时断言。
- **`flatMap` 拼文本**，与前面示例一致。
