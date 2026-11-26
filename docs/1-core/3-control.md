# 3. 控制：一次 run 怎么被驱动

> 用户、agent、外部事件会同时想改变下一步。durable 不靠锁，也不靠拒绝，而是用**持久 inbox + 明确的放置边界**来决定顺序。

版本：pi-durable **v1.6.1**。

## 你会学到

- busy / run / turn 到底怎么算
- follow-up、steer、write、reset 分别放在哪
- 为什么"检查 + 入队"要放进一个 commit
- 失败后队列去哪、`continue` 解决什么
- reset 和 handoff 的区别，compaction 和 reset 的区别
- hooks 如何在不改核心的情况下加业务规则

---

## 1. 设计问题

一次 run 正在跑，用户又说话了。三种常见做法都不好：

| 做法 | 问题 |
|---|---|
| 直接拒绝 | 用户丢消息；产品体验差 |
| 无脑排队 | 用户说"别用 npm"，agent 还是用 npm 跑完 |
| 直接杀掉当前 run | 丢失进度，可能留下半成品副作用 |

durable 的答案：

> **输入先进持久 inbox，再按"放置规则"决定它插在哪；每一条都有明确的边界和结算状态。**

---

## 2. run / turn / busy

```text
run    = 从一条输入到最终答案（可能多个 turn）
turn   = 一次模型回复 + 它发起的工具调用
busy   = 有 run 正在处理输入
```

两个容易忽略的点：

1. **答案给出后，run 不一定结束**：`afterRun` 任务还在跑时，会话仍然 busy。
2. **`waitForIdle()` 包含 afterRun**；`Submission.wait()` 不包含。

```text
submit → run 开始
  turn 1 → 工具 → turn 2 → 答案
    → 输入 settle done        ← wait() 在这里返回
    → afterRun 任务
    → run 结束                ← waitForIdle() 在这里返回
```

---

## 3. Inbox：四种投递

```typescript
// 默认：follow-up，等这一轮答完再开新 run
await root.submit({ type: "input", content: "Also run the tests" }, context);

// steer：插到当前工具轮之后，加入正在跑的 run
await root.submit({ type: "input", content: "Use pnpm, not npm", whenBusy: "steer" }, context);

// 忙就拒绝
await root.submit({ type: "input", content: "...", whenBusy: "reject" }, context);

// 只在忙时插话，闲就拒绝
await root.submit({ type: "input", content: "...", whenBusy: "steer", whenIdle: "reject" }, context);

// write：写 entry，不惊动模型
await root.submit({ type: "write", entry: { kind: "app.note", data: "user opened a file" } }, context);
```

放置位置：

```text
run
 ├─ 模型回复（工具调用）
 ├─ 工具执行
 ├─ ← steer 放这里
 ├─ 模型回复（看到 steer）
 ├─ 工具执行
 └─ 答案
      └─ ← follow-up 放这里，开下一个 run
```

| 类型 | 放在哪 | 用途 |
|---|---|---|
| follow-up | run 答完后 | 补充一个新任务 |
| steer | 当前工具轮之后 | 打断并纠正方向 |
| write | **立刻**（不进队列） | UI 事件、审计、聊天消息 |
| reset | 下一个边界 | 划新上下文 |

### 三条容易踩的规则

1. **steer 不能改变已经发出的工具调用。** 它在下一轮才生效；当前工具照旧跑完。
2. **write 只有 `kind` + `data` 时立刻追加**，因为它不改变模型看到的东西。带 `model` / `head` / `edits` 的 write 像 steer 一样等边界。
3. **write 可能出现在更早排队消息之前**；唯一例外是前面排着 reset，这时它要等，否则 reset 会把它藏起来。

`submission.abort()` 可以撤回排队中的提交。

`settings.steeringMode: "all"` / `followUpMode: "all"` 会把排队的项一次全放进去，而不是一轮一个。

实测（`19-inbox`，faux provider）：

```text
rejected: Conversation 1 is busy
withdraw: aborted
inbox: [ '10 followUp', '11 steer' ]
first / follow-up / steer / note: done
withdrawn: unanswered aborted
transcript: pi.user, app.note, pi.assistant, pi.user, pi.user, pi.assistant
```

`app.note` 在 busy 时立刻出现，排在第一条 assistant 之前——这就是“write 不进队列”。

---

## 4. `admit(tx, draft)`：把"检查 + 入队"变成原子操作

问题：

```typescript
if (muted.includes(userId)) throw ...;        // ① 读
await root.submit({ ... }, context);          // ② 入队
await myDb.log({ userId, text });             // ③ 记录
```

三个窗口都会出事：崩在 ①② 之间（消息丢了）、②③ 之间（消息进了但没记录）、① 期间禁言被改。

解法（事务内受理）：

```typescript
const id = await harness.commit(async (tx) => {
  const chat = await tx.doc(MyChat, root.id);
  if (chat.muted.includes(userId)) throw new Error("Muted");
  const id = await root.admit(tx, { type: "input", content: text, whenBusy: "steer" });
  chat.sent.push({ id, userId });
  return id;
}, context);
```

保证：

- 检查、入队、你自己的写入，**要么全成，要么全不成**。
- 拒绝（`ConversationBusy` / `ConversationIdle`）在**任何写入之前**抛出，可以 catch。
- commit 落盘前，admission 是"临时的"；回调后面抛错 → 根本没有这个 submission。
- 同一个 commit 里，admission 放在表写入（`appendEntry`、`createTask`、另一个 admission）之前，否则抛 `ReadAfterWrite`。

> 为什么必须在表写入之前：admission 要读会话当前状态（inbox、agent、是否忙）来决定放哪。先写表就产生了"未发布的新状态"，判断会基于半新半旧的数据。框架直接拒绝，避免你写出这种逻辑。

> v1.6.0 叫 `submit(tx, draft)`；v1.6.1 起改名 `admit(tx, draft)`。`submit(draft, context)` 不变。

---

## 5. 失败与 `continue`

run 失败后，`docs["pi.live"].runFailure` 记录原因：

| reason | 含义 |
|---|---|
| `model_error` | 模型调用失败 |
| `no_model` | 没配置/模型不存在 |
| `aborted` | 用户停止 |
| `reset` | 被 reset 打断 |
| `interrupted` | 进程在回答中停止，重试用完 |
| `faulted` / `orphaned` | task 出错/孤儿 |
| `restart_limit` | 反复崩溃 |
| `turn_limit` | 达到 `maxTurns` |
| `nothing_to_answer` | continue 时没东西可答 |

默认（`afterFailedRun: "keep"`）：失败 run 后面的输入**留在 inbox**，直到下一次输入、write 或 continue。

可选：

- `"continue"`：自动用排队的输入开下一轮。
- `"withdraw"`：全部 settle `unanswered`，reason `run_failed`。

### `continue`

```typescript
const resumed = await root.submit({ type: "continue" }, context);
await resumed.wait(context);
```

- **从不排队**：会话忙时直接抛 `ConversationBusy`。
- 先把失败 run 留下的排队项放进去，一起加入新 run。
- 上下文"没东西可答"（空，或结尾是答案）→ `nothing_to_answer`，不发请求。
- 被截断的、带工具调用的答案可以 continue：那些调用没跑过，上下文结尾是它们的错误结果。

> 这是 `turn_limit` / `interrupted` / `model_error` 之后的标准恢复姿势：不动输入，只让模型继续看当前上下文。

---

## 6. 边界：reset 与 handoff

### `reset()`

```typescript
await root.reset(undefined, context);                                  // 从零
await root.reset("We were fixing the flaky test. Continue.", context); // 带交接说明
```

- 模型只看到**最新 reset 之后**的 entry；旧 entry 仍在存储里。
- 会话身份（`pi.provider` 的 sessionId）不变。
- 忙时排队；如果它被放在工具轮期间，当前 run 结束，输入 settle `unanswered`，reason `reset`，排队的输入在新上下文跑。

### `control.handoff`

```typescript
return { control: { handoff: "The plan is approved. Implement step 1." } };
```

和 reset 的区别：

| | `reset()` | `handoff` |
|---|---|---|
| 谁触发 | 宿主/用户 | 工具 |
| 当前 run | **结束** | **继续** |
| submission | `unanswered` / `reset` | 用最终答案 settle |
| 队列 | 排队输入在新上下文跑 | writes/steers 落在 handoff 文本之后；follow-ups 等 run 结束 |

如果这一轮**所有**工具调用都返回 `terminate: true`，handoff 之后 run 直接结束。

用途：阶段切换（调查 → 处理）、上下文瘦身、换角色。

> 注意：reset/handoff **不是删除**。旧数据还在存储和审计里，只是模型看不见。不能当隐私清理用。

---

## 7. Compaction：摘要，而不是删除

```text
旧 entry（原文保留）
  ↓ 摘要
pi.compaction：summary + head（保留的第一条 entry）
```

模型看到：摘要 + head 之后的原文。

### 三个阈值

```typescript
compaction: {
  enabled: true,
  reserveTokens: 16384,     // 剩余 < reserve：下一次请求等压缩
  keepRecentTokens: 20000,  // 保留多少近期原文
  backgroundTokens: 32768,  // 剩余 < background：后台开始压
  modelOverrides: { "local/small-32k": { reserveTokens: 4096, ... } },
}
```

```text
0 ─────────────────────────────── 窗口
                  background 开始    reserve 阻塞
```

- **`keepRecentTokens` 必须小于"窗口 - reserve"**，否则压完立刻又该压。
- `backgroundTokens > reserveTokens`，否则后台来不及。
- `backgroundTokens: 0` 关闭后台压缩。

### 层级

每个字段取自第一个设置它的层：

```text
会话 modelOverrides > settings modelOverrides > 会话字段 > settings 字段
```

例外：会话的 `enabled: false` 连 settings 的 modelOverrides 也压过。

### 失败与过期

- provider 报上下文太长 → 压缩一次并重试一次。
- 摘要切在了当前上下文起点之前 → 放置时 settle `stale`；多个在飞时切得最远的生效。
- 阻塞阈值上的压缩失败 → **整个 run 失败**（`model_error`，detail `Compaction failed: ...`），模型根本没被调用。
- 摘要花费计入 `pi.usage`。
- `beforeCompact` hook 可以拒绝或提供自己的摘要。

### reset 还是 compaction？

**"还是同一件事吗？"** 是 → compaction；不是 → reset（带 handoff 更好）。

---

## 8. Hooks：在边界加策略

hooks 挂在内置 task 上，不改核心。

| hook | 时机 | 能做什么 |
|---|---|---|
| `beforeTool` | 工具执行前 | block / 改写参数 / park 等审批 |
| `afterTool` | 结果写入前 | 替换结果、脱敏 |
| `afterRun` | 答案之后 | 起任务（跑测试、交付） |
| `onYield` | 答案生效前 | 起任务审查，决定答案算不算 |
| `afterTools` | 每轮工具后 | 起任务，可 `terminate` 或 steer |

### `beforeTool` gate

```typescript
hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    if (call.name !== "refund_order" || call.arguments.amount <= 50) return undefined;
    const key = digest(call.arguments);
    const state = await api.readSignal(Approval, key, context);
    const until = await api.memo(`until.${key}`, api.now() + DAY, context);
    if (state === undefined) return { kind: "sleep", signals: [Approval.key(key)], until } };
    if ("expired" in state) return { block: "No approval within a day" };
    return state.value.allow ? undefined : { block: "Not approved" };
  },
});
```

三个必须：

1. **每次唤醒都从头重跑**整条链，所以 gate 必须"读信号 → 决定"。
2. **截止时间要 memo**，否则每次唤醒都续期，永远不过期。
3. **副作用幂等**，因为 gate 会跑很多次。

实测（`44-approval-gate`，faux provider + 假时钟）：

```text
asked to approve "rm -rf build"; the call is sleeping; wake: { active: false, at: ... }
  approve: delivered
  result: ran: rm -rf build (quiet-hours gate asked 2 times)
asked to approve "rm -rf dist"
  deny: delivered
  result: <harness> [error] Tool call blocked: Not approved
asked to approve "rm -rf cache"
  result: <harness> [error] Tool call blocked: No approval within a day
```

一次唤醒里 gate 被问了两次（sleep 前一次、醒来后一次），证明“整条链重跑”。

### `afterRun` 与 `onYield` 的关键差别

| | `afterRun` | `onYield` |
|---|---|---|
| 答案状态 | 已定 | **未定** |
| `wait()` | 答案一到就返回 | 审查通过才返回 |
| 适合 | 交付、通知、跑测试 | 审查、打回重做 |

`afterRun` 里如果测试失败并 follow-up 一个 fix run，会再次触发 `afterRun` → 必须自己封顶。

---

## 9. 设计后果

1. **"已回答" ≠ "已完成"**：`wait()` 在答案时返回，afterRun 还在跑。
2. **`onYield` 的答案在 transcript 里，但不算数**：UI 要等 `wait()` 或看 `pi.live.run.yield`。
3. **steer 只影响下一轮**：已经发出的工具调用不会改。
4. **reset 不是删除**：只是可见性边界。
5. **压缩失败会杀死 run**：它和模型错误一样致命，要单独监控。
6. **busy 是策略**：afterRun、排队、`whenBusy` 都由它决定。

---

## 10. 自检

1. 工具跑 10 分钟时用户说"用 pnpm 别用 npm"。默认会怎样？想立刻影响该用什么？来得及改正在跑的工具吗？
2. 先查禁言再 `submit` 有什么窗口？用 `admit(tx, draft)` 怎么改？为什么必须在表写入之前？
3. `afterRun` 跑测试，`wait()` 返回 `done` 时测试跑完了吗？产品上怎么表达"真的完成"？
4. `onYield` 的答案已经写进 transcript，但 `wait()` 没返回。UI 直接渲染会怎样？
5. reset 和 compaction 都能让模型少看历史，什么时候用哪个？

答案：[2-self-checks.md](../3-appendix/2-self-checks.md#3-控制)。

---

## 11. 相关

- 上一篇：[2-capabilities.md](2-capabilities.md)
- 下一篇：[4-orchestration.md](4-orchestration.md)
- 术语：[1-glossary.md](../3-appendix/1-glossary.md)
- 原文：Busy Conversations、Reset and Handoff、Compaction、Hooks
- 对应示例：`19-inbox`、`24-compaction`、`32-tests-after-edits`、`33-turn-limit-and-continue`、`44-approval-gate`、`45-review-on-yield`、`46-after-tools-terminate`
