# 自检答案

> 先自己回答，再对答案。题在每篇末尾。

版本：pi-durable **v1.6.1**。

## 1. 基础

对应：[1-foundations.md](../1-core/1-foundations.md#11-自检)。

### 1.1 为什么 `submit()` 返回 `Submission` 而不是答案？

因为"受理"和"完成"是两件事：

- **受理**要快、要持久：输入先落进存储，进程崩了也不丢。
- **完成**要慢：要调模型、跑工具，可能几分钟。

拆开之后：

- UI 可以立刻显示"已发送"；
- 调用方拿句柄，可以 `wait`、`abort`，重启后还能 `harness.submission(id)` 找回；
- 调度器在后台推进，不阻塞请求。

如果 `submit()` 直接返回答案，那么"输入持久化"和"模型调用"就绑在一起，崩溃时既丢输入也丢进度。

### 1.2 `settled.answer` 是什么？为什么示例要用 `commit` 去读？

`settled.answer` 是 **EntryId（一个不透明的 ID；v1.6.1 里是数字）**，不是消息内容。

答案是 `pi.generation` task 自己 append 的。示例里：

```typescript
const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
```

- `tx.entry(token, id)` 是**读**：按 ID 取 entry，类型不符或不存在返回 `undefined`。
- `commit` 的签名是 `commit<T>(change: (tx) => T | Promise<T>)`，返回 callback 的返回值。
- 用 `commit` 是为了拿一致视图，不是"再写一遍"。

### 1.3 进程在模型回答到一半时被杀，重启后会发生什么？

- 那半截答案**保留**成一条 aborted entry。
- 这次算一次失败尝试，按 `settings.retry` 退避重试。
- 重试用完 → run 结束，`runFailure.reason = "interrupted"`。
- 花掉的 token 照算。

可能丢的：

- 最后约 1 秒尚未落盘的流式文本（`progress.persistWithinMs` 默认 1000ms）；
- 如果流在第一秒就崩，可能连 aborted entry 都没有，这次 attempt 的 usage 也不记录。

**graceful close 不算 crash**：`close()` 停掉的请求，下次直接重发，不消耗重试次数。

### 1.4 phase 里为什么不能 `await sleep(1h)`？应该怎么写？

因为**重启后整个 phase 从头再跑**。`await sleep(1h)` 前面的代码会重跑，副作用会重复；等待本身也不抗重启。

正确写法：

1. 当前 phase 提交 `{ status: "sleeping", until, checkpoint: { phase: "next" } }`（或 `runtime.sleepUntil(...)`）；
2. phase 到此结束，进程可以退出；
3. 到点后从 checkpoint 指定的 `next` phase 继续；
4. 需要跨越等待的数据放进 checkpoint（必须可 JSON 序列化）。

### 1.5 webhook 要唤醒等了 20 分钟的工具，你必须自己存什么？

durable 存的是"task 睡在哪个 key 上"，不存"外部世界怎么找到这个 task"。你必须补：

1. **`外部 ID → { taskId, key }` 的映射**，并且要在触发外部工作**之前**写好；
2. **signal 的 kind/version**（要和 `defineSignal` 一致）；
3. **外部调用的幂等键**（`api.memo` 在调用前固定），否则崩溃重跑会再创建一个外部任务；
4. **认证**：`harness.signal()` 不检查发送者，webhook 签名/登录态要在宿主做。

顺序：先 memo 幂等键 → 再登记映射 → 最后触发外部工作。早到的信号不会丢，所以不需要和 sleep 抢时序。

---

## 2. 能力

对应：[2-capabilities.md](../1-core/2-capabilities.md#10-自检)。

### 2.1 为什么扩展不能持有会话状态？需要状态时放哪？

因为扩展对象是**进程级共享、内存级、可热替换**的：

- 重启丢失；多进程各一份；
- `install` 同名新版本 = 新对象 = 新状态；
- 不能和 entry 在同一个 commit 里原子更新；
- watch/UI/fork 都看不见它。

放法：会话级状态用 `defineDoc`（`scope: "conversation"`）；task 内部用 checkpoint；幂等键用 `api.memo`；跨会话注册表用 `scope: "session"` 的文档。

进程内缓存可以留，但必须是**从已提交状态推导出来的缓存**，丢了不影响正确性。

### 2.2 什么时候必须 `replay: "safe"`？什么时候不能？

必须：`execute()` 会崩溃重跑，而重跑是无害的（只读、幂等、或副作用带幂等键）。

不能：

- 发邮件、扣款、创建资源等**没有幂等键**的副作用；
- 等外部事件/人工审批（应该 park，不是 replay）；
- 重复执行会造成业务损害的流程。

注意：**不声明 `safe` 也不等于不会重复**。默认时模型收到 `interrupted`，很可能自己再调一次。所以有副作用的工具无论如何都要幂等。

### 2.3 `modelTools` 去掉了 `bash`，模型还能执行 shell 吗？

能。

`modelTools` 只决定**菜单上有什么**。模型仍可以通过：

- `codemode` 脚本里的 `await tools.bash(...)`；
- 另一个工具内部的 `api.executeTool("bash", ...)`。

真正的边界是：

- `tools`：是否启用；
- `callers`：谁能调；
- `beforeTool`：运行时策略（能看 `call.parent`）；
- `env`：没有 shell 就没有 shell 能力。

### 2.4 为什么要三个输出通道？

三个消费者的需求冲突：

- 模型要短、可读（token 贵）；
- 程序要精确、可组合（不要解析自然语言）；
- UI 要富信息，而且不能污染模型上下文。

混成一个字符串，只能二选一：模型吃 JSON，或程序解析文案。

配套事实：transcript 只存 `output` 和 `details`；`structuredOutput` 是给程序的临时值。脱敏时 `output` 和 `structuredOutput` 都要脱。

---

## 3. 控制

对应：[3-control.md](../1-core/3-control.md#10-自检)。

### 3.1 工具跑 10 分钟时用户说"用 pnpm"，默认会怎样？

默认是 **follow-up**：排进 inbox，等当前 run 答完才开新一轮。当前这 10 分钟的工具照常用 npm。

想影响当前 run：`whenBusy: "steer"`。它放在**当前工具轮之后**，模型下一轮才看到。

- 对**正在跑**的工具：来不及，参数已定。
- 对之后的模型请求/工具调用：生效。
- 想立刻停：`abort()`，但会丢当前进度。

### 3.2 先查禁言再 `submit` 有什么窗口？

三个窗口：检查后提交前崩（消息丢）、提交后记录前崩（消息进了但没记录）、检查期间禁言被改。

用 `admit(tx, draft)` 放进自己的 commit：

```typescript
const id = await harness.commit(async (tx) => {
  const chat = await tx.doc(MyChat, root.id);
  if (chat.muted.includes(userId)) throw new Error("Muted");
  const id = await root.admit(tx, { type: "input", content: text });
  chat.sent.push({ id, userId });
  return id;
}, context);
```

检查、入队、记录要么全成要么全不成；拒绝在任何写入前抛出；提交落盘前 admission 是临时的。

必须在表写入之前：admission 要读 inbox/agent/忙闲来决定放哪；先写表就产生未发布的新状态，判断会基于半新半旧的数据，框架直接抛 `ReadAfterWrite`。

### 3.3 `afterRun` 跑测试，`wait()` 返回 `done` 时测试跑完了吗？

没有。顺序是：答案提交 → 输入 settle `done`（`wait()` 返回）→ 问 afterRun hooks → 创建任务 → 等任务 → run 结束。

产品上区分三个状态：

| 状态 | 依据 |
|---|---|
| 已回答 | `wait()` → `done` |
| 后台还在跑 | `pi.live.run.afterRun` 非空，会话仍忙 |
| 真正空闲 | `waitForIdle()` |

如果"测试不过就不能发答案"，用 `onYield`，不要用 `afterRun`。

### 3.4 `onYield` 的答案在 transcript 里，但 `wait()` 没返回，UI 直接渲染会怎样？

用户会把一个**可能被打回**的答案当成最终结果。`continue` 之后答案还在（entry 不可变），后面又追加新的工作，用户困惑"哪个算数"。

正确做法：

- 看 `pi.live.run.yield` 是否存在：存在 = 审核中；
- 用 `wait()` 的 `done` 作为"最终"信号；
- 审核中可显示答案但标"审核中"，或干脆等通过再显示。

### 3.5 reset 和 compaction 怎么选？

**"还是同一件事吗？"**

- 是 → compaction：摘要 + 保留近期原文，连续性最好。
- 不是（换阶段/换任务）→ reset（带 handoff 文本更好）。

代价：reset 失去连续性但省 token；compaction 要花摘要调用，且可能失败（阻塞阈值失败会让 run 失败）。两者都不删存储。

---

## 4. 编排

对应：[4-orchestration.md](../1-core/4-orchestration.md#8-自检)。

### 4.1 前台 subagent 是 `replay: "safe"`，子会话模型调用失败会怎样？

子会话的 run 失败 → submission settle 成 `unanswered`，`wait()` **正常 resolve**，不抛异常。

所以工具必须检查 `settled.status`：

- 不等于 `done` 时返回 `isError: true`，否则父模型会把失败当成功；
- 子会话**不会被 abort**，它只是 idle，`runFailure` 有记录。

`replay: "safe"` 只保证崩溃重跑时复用同一个子会话（ownership 索引 + requestId），不保证模型失败会重试。

### 4.2 `failFast` 等 4 个支付，第 2 个失败

- 第 1 个如果还在跑，也会被 abort；
- 第 3、4 个被 abort；
- 父任务被唤醒，进入 decide；
- 提交 outcome 后状态是 `completing`；
- **所有子任务真正结束后**才 terminal，`waitForTask()` 才返回。

`outcomes()` 会看到 `completed` / `failed` / `aborted` 混合。已完成的支付要不要退款/撤销，是父任务的业务责任。

### 4.3 background subagent：`waitForIdle()` / `root.abort()`

- `waitForIdle()` **不等**它；
- `root.abort()` **不杀**它；
- `root.abort({ background: true })` 才杀。

所以用户看到"空闲"时它可能还在花钱。需要单独的后台任务面板、预算和停止入口。这是 `background` 作为边界的代价。

### 4.4 fork 还是 subagent？

- **fork**：独立会话，共享到某个 entry 的历史；新 provider 身份；用于分支尝试、A/B、回到决策点。没有所有权，父的 abort/忙闲管不到它。
- **subagent**：子会话，owner 是 task；跟父的 abort/忙闲；用于委派、隔离上下文、并行；结果要显式回收。

---

## 5. 运行时

对应：[5-runtime.md](../1-core/5-runtime.md#10-自检)。

### 5.1 文档每次流式输出都 push，`checkpointWhen: () => false`

一万次之后，读它要把一万条操作从最近基线重放一遍：读慢、加载慢、提交慢、恢复慢，内存也大。

改法：

- 给 `checkpointWhen` 一个周期（每 N 次/大变化时存完整基线）；
- 合并写入，不要每个 token 一次 commit；
- 流式文本不要自己存文档，`pi.live` 已经处理；
- 真需要高频，考虑 deferred。

### 5.2 配额存在 deferred 文档里，用来决定是否付费调用

崩溃会丢掉未落盘的扣减，但钱可能已经花了；或者先花后扣、崩在中间。结果都是超支/账对不上。

deferred 的值不是持久事实，不能做决策依据。

正确：

1. 立即存储的 commit 里检查配额 + 写 reservation（pending）+ 记录调用意图；
2. 外部调用带幂等键（reservation.key）；
3. 成功后再 commit settled；
4. 崩溃后按 pending 去对账；
5. 硬上限放在外部（provider/支付渠道）。

### 5.3 `snapshot()` 与 `commit()` 抛 `StorageRequestError` 的区别

- **读**：只失败这次调用，Harness 继续；可以换参数重试。
- **写**：按规则 1，Harness 结束；因为不知道到底写没写，继续跑会产生不一致。

豁免只覆盖读；`commit()` / `mintId()` 抛任何错误（包括 `StorageRequestError`）都会让 Harness 停。

恢复：重开 + 用同一个 `requestId` 重提。

### 5.4 脚本 `await tools.a()` 成功、已 journal，然后崩溃

`a` **不会**再执行：重放时直接从 journal 把结果交回。

仍可能重复的来源：

- 崩溃在 journal 写入之前 → 重放再次调用 `a`；
- 嵌套 task 上次没提交结果 → 跟它自己的 `replay` 走；
- 整个 codemode 调用因路径变化/指纹变化/超时失败，模型重试整个工具；
- `a` 自己的外部副作用没有幂等键。

### 5.5 UI 只渲染 `watch.value.entries`，往上滚看不到历史

因为 `entries` 是窗口：初始 50，最多 100，滑出后只留最新 50。旧 entry 还在存储里，`value.before` 是翻页游标。

正确：用 `ConversationTranscript.merge()`，配合 `loadEarlier()` / `fillGap()` / `resume`；或自己按 `before` 翻页。

---

## 架构篇

`2-architecture/` 是对比与落地记录，不配自检。需要时直接读对应章节。
