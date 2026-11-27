# 在宿主自己的提交里接纳消息

访客/多用户的场景里，“检查 + 入队 + 记录”必须是一个原子动作。`conversation.admit(tx, draft)` 把接纳放进**你自己的提交**，于是你的检查、你的状态、这次接纳要么一起落地，要么一起不发生。

## 一个函数做三件事

```ts
return await harness.commit(async (tx) => {
  const visitors = await tx.doc(Visitors, root.id);
  if (visitors.muted.includes(from)) return `${from} is muted`;
  const id = await root.admit(tx, {
    type: "input", content: `${from}: ${text}`,
    whenBusy: "steer", whenIdle: "reject", requestId,
  });
  visitors.sent.push({ from, text });
  return `${from}'s message is submission ${id}`;
}, context);
```

三条保证：

1. **原子**：检查、接纳、自己的写入同一次提交。
2. **拒绝发生在任何写入之前**：`ConversationIdle` / `ConversationBusy` 在写表之前抛出，可以 catch；抛出后整个提交不发生。
3. **接纳必须先于表写入**：`admit` 要读会话当前状态（inbox、agent、忙闲）来决定放哪。放在 `appendEntry` / `createTask` 之后会抛 `ReadAfterWrite`。文档读写可以在它前后随便放。

## `whenIdle: "reject"` 是关键

```ts
whenBusy: "steer",  // 忙时：作为 steer 加入当前 run
whenIdle: "reject", // 空闲时：直接拒绝，绝不开新 run
```

这是“只能插话，不能触发工作”的完整表达。实测第一条消息就是这种情形：

```
ana: the agent isn't working now
```

宿主 catch 住 `ConversationIdle` 转成一句人话——**而且什么都没写**（`sent` 里没有这条）。

## 宿主自己的检查

`muted` 那行用 `return` 短路，而不是抛错：它不写 `sent`、不 admit，提交照常完成（只是什么都没改）。用 `return` 还是 `throw` 取决于你想让调用方看到“成功但无事发生”还是“错误”。

## `requestId`

```ts
requestId: "ana-2"
```

同一个 id 重复提交返回**原来那条**（不会插两次话）。访客重试、网络重传都靠它兜住。

## 实测的时序

```
ana: the agent isn't working now      ← 空闲，被 whenIdle 拒绝，无写入
ana's message is submission 11        ← run 进行中，作为 steer 接纳
bob is muted                          ← 宿主检查拒绝
> Build the project.
> ana: Add a test for the build.      ← steer 在工具轮之后被放置
agent: Built, and I added the test Ana asked for.
recorded: [ { from: 'ana', text: 'Add a test for the build.' } ]
```

- 只有 ana 在 run 进行中发的那条进了 transcript（作为用户消息）并被记录；
- steer 出现在 `build` 工具调用之后、最终答案之前——这是 steer 的定义（当前工具轮之后插入）；
- 最终答案里模型确实采纳了这条插话。

`release()` 卡住 `build` 工具，制造“run 正在工作”的窗口——这跟 19 用 `hold` 卡住模型回答是同一手法。

## `admit` 和 `submit(draft, context)` 的区别

| | `submit(draft, ctx)` | `admit(tx, draft)` |
|---|---|---|
| 提交边界 | 自己一次提交 | 你自己的那次提交 |
| 返回值 | `Submission` 句柄 | submission **id** |
| 用在哪 | 宿主直接投递 | 要和自己的检查/写入原子 |

⚠️ 1.6.0 里事务形态叫 `submit(tx, draft)`，1.6.1 改名 `admit`；普通形态 `submit(draft, ctx)` 没变。

## 类型与语法

- `ConversationIdle` / `ConversationBusy` 是导出的错误类，用 `instanceof` 判断。
- `admit` 返回 `Promise<SubmissionId>`（数字品牌类型），可以直接写进日志或自己的文档。
- `tx.doc` 在提交里可读写；`harness.snapshot` 在提交外只读。
- `let release!: () => void` + `new Promise((resolve) => { release = resolve })`：卡住工具，制造忙碌窗口。
- `message.stopReason === "stop"`：只打印最终答案，跳过工具轮里的中间应答。
