# reviewer：第二个 agent，用 onYield 做审查循环

主 agent 和 review agent 是**两个独立的会话**。reviewer 有自己的模型（更便宜）、自己的扩展选择、只读的工具集、自己的检出目录；它靠一个 `onYield` 钩子把“还有问题就再查一遍”变成循环。

## 两个会话，各自配置

```ts
await harness.root(context, { agent: { model: { provider: "faux", modelId: "big" } } });

const reviewer = await harness.createConversation({
  ownership: { kind: "ownerless" },
  agent: {
    model: { provider: "faux", modelId: "small" },
    extensions: [CodingTools, Reviewer],
    tools: [createReadTool()],
    cwd: worktree,
  },
}, context);
```

四项都**存在 reviewer 这个会话上**，不是进程里的常量：

| 字段 | 值 | 效果 |
|---|---|---|
| `model` | `small` | 审查用便宜模型 |
| `extensions` | `[CodingTools, Reviewer]` | 恰好这两个、这个顺序（主 agent 只选了 CodingTools） |
| `tools` | `[read]` | **绝对列表**：即使 CodingTools 带 write/edit/bash，reviewer 只有 read |
| `cwd` | 自己的 worktree | 各自检出，互不干扰 |

实测解析结果：

```
reviewer: small [ 'coding-tools', 'reviewer' ] [ 'read' ] true
```

这也再次说明：会话的 agent 状态是**存储里的**，重启后照样能解析出这套配置。

## 审查循环：onYield

```ts
const Reviewer = defineExtension({
  name: "reviewer",
  sections: [section("role", () => `You review diffs. Report problems as a list. Never edit files.`)],
  hooks: [
    hook(GenerationTask, {
      onYield: (answer) =>
        textOf(answer).includes(DONE)
          ? undefined
          : { kind: "continue", continue: `Look again for anything you missed. Say "${DONE}" when there is nothing left.` },
    }),
  ],
});
```

两件事：

- **`role` 段落**：给模型立规矩（列表报问题、绝不改文件）。这是软约束，真正的“不能改”由 `tools: [read]` 保证。
- **`onYield`**：每次答案出来先问它。不含终止标记 → 返回 `{ kind: "continue", continue: "…" }`；含 → 返回 `undefined`（答案成立）。

`continue` 的文本会被放置成**用户消息**，在**同一个 run 里**继续，轮数预算重置。实测：

```
> Review user.ts.
reviewer: 1. `name` does not handle a missing user.
> Look again for anything you missed. Say "No further findings." when there is nothing left.
reviewer: 2. `user` has no type. No further findings.
```

第二轮答案带上了 `No further findings.`，钩子返回 `undefined`，run 结束。

## 为什么用 onYield

| 钩子 | 时机 | 适不适合“再审一遍” |
|---|---|---|
| `onYield` | 答案提交后、输入结算前 | ✅ 答案还没发布，打回就等于没答过 |
| `afterRun` | run 结束后 | 要新开一个输入/run，外部等待者已经拿到第一版答案 |
| `afterTools` | 每轮工具后 | 时机太早，还没有答案可审 |

`onYield` 的语义正是“这个答案算不算数”，所以审查用它最自然。

## 循环刹车

每次 `continue` 都会重置轮数预算，所以必须自己设终止条件：

- 这里靠**模型自己说终止标记**（`DONE`）；
- 真实实现通常再加一层：审查次数上限（`attempt <= 2`）、或把“审查意见为空”作为更强的判据。

没有刹车的话，模型永远不说 DONE 就是一个死循环——32 里那个 `attempt < 3` 是同一个问题的另一种解法。

## 类型与语法

- `reviewer.agent(ctx)` 返回解析后的 `Agent`：`model`、`extensions`（含名字）、`tools`、`cwd`——调试“这个会话到底跑什么”就看它。
- `tools: [createReadTool()]` 是绝对列表；`{ remove: [...] }` 才是从默认里删。
- `onYield` 在 1.6.1 返回带标签的形式：`{ kind: "continue", continue }` / `{ kind: "tasks", tasks }` / `undefined`。
- `AssistantEntry.is(entry)` 收窄成 assistant 条目后才能安全读 `model[0]`。
- `textOf()` 把 `content` 里的文本块拼起来（跳过 `toolCall`）。
- `env: ({ cwd = process.cwd() }) => …`：reviewer 的 `cwd` 就是它的 worktree，主 agent 用默认值。
