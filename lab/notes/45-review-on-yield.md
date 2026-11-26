# onYield：答案先提交，再由审查任务决定它算不算数

`onYield` 钩子在答案提交之后跑，可以要求任务。答案**已经进 transcript**，但这次运行的输入**保持未结算**——所以 `wait()` 不会返回，直到审查给出结论。这是“答案要过审才发布”的机制。

## 三个状态要分清

| 观察 | 含义 |
|---|---|
| transcript 里已有答案条目 | 答案已提交，模型说过的话不会因为审查而撤回 |
| `submission.status()` 是 `placed` | 输入还开着，等审查结论 |
| `pi.live.run.yield` 非空 | 正在等这些审查任务（含答案条目 id 和任务 id） |

实测：

```
while reviewing, the input is: placed
review 说 continue 之后，模型又答一次
input: done
```

## 审查任务怎么判

钩子只负责建任务；判据在任务里：

```ts
const live = await runtime.snapshot(LiveDoc, runtime.conversationId, ctx);
const entry = await runtime.entry(live!.run!.yield!.answer, ctx);
const text = …读条目里的文本…;
const decision: YieldDecision = text.length < 20 ? { continue: "Too short: explain your reasoning." } : {};
```

- `run.yield.answer` 是**答案条目的 id**，所以审查读的是“将被发布的那个答案”，不是最新的模型输出。
- `YieldDecision` 是 `{ continue?: UserInput }`：给了 `continue` 就是打回，内容是**一条用户消息**；`{}` 表示答案成立。

## 打回之后发生什么

`{ continue: "Too short: …" }` 的效果：

1. 那条文本被放置成用户消息（实测 transcript 里出现 `> Too short: explain your reasoning.`）；
2. 在**同一个 run 里**继续跑（不是新输入、不新开 run）；
3. **轮数预算归零**（源码注释：continuation 把 run 的 turn 计数重置，“给 onYield 循环设上限是扩展自己的责任”）；
4. 新的答案**再走一次 onYield**——所以审查会看到每一版答案。

输出里 `[review]` 出现两次，就是第一版打回、第二版通过。

## 排队的用户消息优先

审查期间用户又发了一条（`whenBusy: "followUp"`）。这时审查说“打回”也不作数了：边界先放置排队的用户消息，于是模型回答的是那个新问题，而不是审查的意见。

```
[review] "No." -> {"continue":"Too short: explain your reasoning."}
[review] "Answering the queued question instead." -> {}
```

规则来自源码 `takesContinuation()`：只有 inbox 里没有会被选中的用户项、也没有排队的 reset，才采纳 continuation。**人的新输入永远压过自动打回**——这条值得记住，它决定了“审查循环不会挡住用户”。

## 与另外两个收尾钩子的分工

| 钩子 | 时机 | 通过标准 |
|---|---|---|
| `afterTools` | 每轮工具之后 | 继续/终止本轮，可插 steer |
| `onYield` | 答案之后、输入结算之前 | 答案成立/打回重答 |
| `afterRun` | run 结束之后 | 跑测试，可发起修复 run |

`onYield` 的特别之处是**发布门槛**：外部等待者（`wait()`）看不到“未经审查的答案”，因为它一直没结算。

## 类型

- `hook(GenerationTask, { onYield })` 在 1.6.1 返回带标签的形式：`{ kind: "tasks", tasks: [...] }`（1.6.0 是 `{ tasks }`）。
- `YieldDecision` 是 `{ continue?: UserInput }`，任务结果类型直接写它。
- `live!.run!.yield!.answer`：三个非空断言，因为审查任务只有在 yield 存在时才被创建。
- `release` 是模块级的 `let`，任务里的 Promise 把 resolver 赋给它，脚本才能“卡住审查”做观察。

## TS / JS 语法

- **`let release = (): void => {}`** + `new Promise<void>((resolve) => { release = resolve; })`：外部控制放行。
- **轮询等条件**：`while ((await harness.snapshot(...))?.run?.yield === undefined) await new Promise((r) => setTimeout(r, 1));`
- **`flatMap` 把条目拍成行**：返回 `[]`、`["> …"]` 或 `[文本]`，一次遍历既过滤又改造。
- **字符串长度当判据**：`text.length < 20`——示例用最简规则，真实审查任务会读源码 diff、跑 lint、问模型。
