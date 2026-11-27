# 后台 subagent：常驻子会话 + 锚点 + 回报任务

主 agent 通过一个 `subagent` 工具管理若干个**常驻**子 agent：spawn、send（steer 或 follow-up）、stop、status。子 agent 在主 agent 回答用户的同时继续工作，答案回来时作为新消息投给主 agent。全部存活在存储里，重启接着跑。

## 四个部件

| 部件 | 是什么 | 作用 |
|---|---|---|
| `Subagents` 文档 | 会话级、`history: "latest"`、`fork: "initial"` | 名字 → `{ conversationId, reported[] }`，以及 `reporters`（task id 列表） |
| `Anchor` 任务 | 后台任务，立刻终结 | 子会话挂在它名下，从而**越过主 agent 的边界** |
| `Reporter` 任务 | 后台任务，两个阶段 | 送一条消息给子 agent，等答案，把答案回报给主 agent |
| `subagent` 工具 | `spawn/send/stop/status` | 唯一的入口 |

## 为什么要 Anchor（关键设计）

所有权决定“谁的取消能到达谁”：

- 子会话如果归**主 agent 的工具调用**（像 21/43 那样），工具调用一结束、或者用户按 Esc，子会话的工作就被带走；
- 归一个**后台任务**（`background: true`）后，它是一个边界：主 agent 的 Esc、`waitForIdle()` 都停在它外面，**但 `abort({ background: true })` 仍能穿透**——这样宿主还能“全停”。

Anchor 就是那个“立刻终结的后台任务”：子会话有主，但不属于主 agent 的当前回合。

## Reporter：两阶段 + 幂等

```ts
deliver: 提交 request（requestId: subagent:<reporterId>）→ 等结算
         在同一个提交里：把 answer 的 entryId 记进 reported[]，并决定要不要回报
report:  把报告作为 follow-up 投给主会话（requestId: subagent-report:<reporterId>）→ 终结
```

三个细节：

- **`requestId`** 让重复投递返回原记录：重启后 reporter 重跑，子 agent 不会收到两遍，主 agent 也不会收到两份报告。
- **`reported[]`** 解决“多条消息得到一个答案”的情况：同一个答案 id 只回报一次。
- **一条提交决定一切**：`reported.push` + 检查点 `phase: "report"` 在同一次提交里，所以“决定回报”不会重复发生。

`aborted` 的两种含义也分开了：被停止（stopped）或被撤回（withdrawn）→ 不回报；其它失败 → 回报 `[subagent X failed: reason]`，让主 agent 知道。

## 工具的四个动作

- `spawn`：建 Anchor → 建子会话（`ownership: { kind: "task", taskId: anchor }`）→ `configure` 去掉 `subagent-tools` 扩展（子 agent 不能再开子 agent）+ 给它身份说明 → 写进 `agents[name]`；然后为这条消息建 Reporter。
- `send`：只建 Reporter，`followUp: true` 时用 follow-up，否则用 steer。
- `stop`：`conversation.abort()` 打断子 agent 当前的答案和工具，清掉它排队的消息，但会话保留可继续用。
- `status`：读 `Subagents` 文档 + 每个子会话的 `pi.live.run` 是否存在，判断 `working` / `idle`。

`replay: "unsafe"` 是有意的：`stop` 被崩溃重放可能停掉**新**的工作，所以宁可不重放，让模型看到 `interrupted` 再自己 `status` 确认。

## 重启之后

Reporter 是持久任务，检查点在 `deliver`/`report` 边界。宿主重启、重新 `install(SubagentTools)` 之后，未完成的 reporter 继续：要么接着等答案，要么把已决定的报告投出去。

实测里关掉 Harness（进程消失）再打开，`> reader: Moby Dick.` 仍然作为新消息出现——报告没丢。

## 输出长什么样

```
> Start a subagent named reader that summarizes Moby Dick.
  subagent spawn reader "Summarize the plot of Moby Dick."
  → 
OK. 
> reader: A whale, a captain, an obsession.
Noted.
```

- 主 agent 立刻答完（`OK. …`），子 agent 的答案稍后作为 `> reader: …` 进来，主 agent 再答一次（`Noted.`）。
- `stop` 打断“逐章总结”这种长答案；`status` 显示 `reader: working|idle`。

## 已知问题：这个示例的工具结果对模型是空的

`reply()` 返回的是

```ts
{ content: [{ type: "text", text }] }
```

但工具结果给模型的字段是 **`output`**，不是 `content`。所以模型看到的工具结果是空字符串（`→ ` 后面什么都没有，主 agent 只能回一句 `OK. `）。

我验证过：同一个工具返回 `{ content: [...] }` 时条目里 `content: []`；返回 `{ output: [...] }` 时才有文本。这条在 TypeScript 里不报错，因为 `reply()` 先构造对象再返回，多余的属性被结构化类型放过了。

自己写的时候改成 `output` 即可；`details` 字段是对的（UI 靠它 attach 子会话）。

## 类型与语法

- `defineDoc<T>` 里 `T` 含 `agents` 和 `reporters` 两张表；`history: "latest"` + `fork: "initial"` 表示分叉不带子 agent。
- `tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true })`：`background` 是所有权之外的另一个维度。
- `oneOf([...])` + `opt(str())`：可选参数的 schema 写法，`args.message` 因此是 `string | undefined`。
- `Object.hasOwn(obj, key)` 而不是 `key in obj`：原型链上的键不算。
- `api.snapshot(Subagents, ……, ctx)` 在工具里读文档；`tx.doc` 在提交里读写。
- `const follow = async (harness, id) => { … }`：用一个 watch 把主会话打印成“用户视角”，子会话不混进来。
- `settle()` 等的是“所有 reporter 终结 + 主会话 idle + 50ms 让日志刷出来”。
