# 问一个人：信号 + deadline

任务要等一个人的回答，可能等几分钟，也可能永远没人答。做法是**一次睡眠同时挂上信号和截止时间**：谁先到就按谁处理。等待期间进程不持有任何东西。

## 一个任务的两个阶段

```ts
ask:      sleeping { signals: [Answer.key("answer")], until: now() + 4 * HOUR, checkpoint: { phase: "answered" } }
answered: 读信号 → 有值就是答案，过期就是 null → 终结
```

`answered` 阶段第一件事是看 `task.state.wake.reason`：

| `reason` | 含义 | `readSignal` 结果 |
|---|---|---|
| `signal` | 有人在截止前答了 | `{ kind: "value", value }` |
| `expired` | 截止先到 | `{ kind: "expired" }` |
| `time` | 只设了 `until`，没设信号 | 不适用 |

注意这是**一个任务走完两条路**，不是两个任务：过期不是失败，任务照常终结，结果里带 `null`（或你自己的“超时”标记）。

## 时间从哪来

```ts
now: () => clock
```

Harness 的时钟是可注入的，睡眠的 `until` 按它存。所以：

- 测试里把 `clock` 往前拨，四小时立刻过去，不用真等。
- **多个进程打开同一份存储时，时钟必须一致**——否则“到点”在不同进程里含义不同。
- 任务代码里读时间用 `runtime.now()`，不要用 `Date.now()`，两者可能不同。

## 宿主要做的三件事

1. `harness.wake()` → `{ active: false, at: <截止时刻> }`：现在不用跑，但**到 `at` 要回来**。
2. `onWake` 回调收到每次变化（打开后立刻一次），宿主据此设自己的闹钟（Durable Object 的 alarm、容器定时器）。
3. 闹钟响了 → 时钟越过 `at` → `resume()` → 调度器把睡到期的任务叫醒（`reason: "expired"`）。

示例里没有真闹钟，直接 `clock = wake().at` + `resume()`，等价于“闹钟响了”。

`onWake` 在一个微任务里跑（在改变该值的提交被采纳之后），所以脚本里想读它的结果要先让出一次事件循环。

## 过期之后迟到还算吗

不算。截止到点后这个 key 被标记过期：

- 任务读到 `{ kind: "expired" }`；
- 之后的 `harness.signal(...)` 对该任务返回 `closed`，值不会覆盖已有结局。

这解决的是“人过了一小时才点同意，而系统已经按超时处理”的经典冲突。要允许补答，就别用 deadline，或者把它做成新的一次提问（新任务、新 key）。

## 谁记录“问题是什么”

**durable 不存**。睡眠里只有 key 和截止时间，没有“要问谁、问什么”。给人看的界面（收件箱、审批卡片、聊天桥）必须自己记录问题内容。

示例里用了一个进程内 `Map<TaskId, string>`，只够演示。真实实现要放进文档（session/conversation 级），才能跨重启、被多个进程读到：任务开始时写一条“待办问题”，回答或过期时删掉。

## 类型

- 任务的终结结果可以是任意 JSON：这里是 `{ answer: string | null }`，把“没答”编码进去比让任务失败更好用。
- `Wake` 是 `{ active: boolean; at?: number }`，`at` 缺失代表“没有内部时刻会醒”。
- `task.state.wake` 是可选字段（新建的任务没有），读它要 `?.`。
- `SignalState` 判 `kind`，不要做形状探测。

## TS / JS 语法

- **可注入时钟**：`let clock = Date.UTC(...)` + `now: () => clock`，测试里直接赋值推进时间。
- **`Map<TaskId, string>`**：用品牌数字类型当 key，类型安全。
- **`wakes.at(-1)`**：取数组最后一个元素，负数下标从末尾数。
- **`!` 断言**：`harness.wake().at!`——这里确定有截止时间，所以直接取。
- **数组收集回调**：`const wakes: Wake[] = []` + `onWake: (wake) => wakes.push(wake)`，把宿主回调的输入留作证据。
- **`await new Promise((r) => setTimeout(r, 1))`**：让出一个事件循环，等微任务里的 `onWake` 跑完。
