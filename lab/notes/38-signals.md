# signals：从外面把值送进正在跑的任务

任务要等的东西不一定在进程里：一个人点确认、一个 webhook 回来、另一个服务跑完。信号就是这条通道——**带类型的 JSON 值，按 key 投递给一个活着的任务**，投递本身是一次提交。

## 定义一个信号

```ts
const Greeting = defineSignal({ name: "example.greeting", version: 1, schema: obj({ text: str() }) });
Greeting.key("hello");   // 一次等待的 key
```

- `name` 像任务和文档的 kind，全局唯一、不含 `/`。
- `version` 是值形状的版本；形状变了就升版本 + 写可选的 `migrate`，读出来时自动迁移到 token 的版本。
- `schema` 是 pi-schema 的 schema，值类型由它推断（`Static<S>`），投递时按它校验。
- `key` 是**一次等待**的标识，不是信号种类的标识：同一个 token 可以用不同 key 等不同的事（`"build-42"`、`"user-7"`）。

## 五种投递结果

```ts
const result = await harness.signal(taskId, Greeting, "hello", { text: "hi" }, context);
```

| 结果 | 含义 |
|---|---|
| `delivered` | 已持久接受。**不等于已经被消费** |
| `duplicate` | 这个 key 里已经有值了（webhook 重试走到这里） |
| `invalid` | 不是 JSON 或不匹配 schema，什么都没存 |
| `closed` | 任务已终结、持有结局、被标记中止，或这个 key 已过期 |
| `not_found` | 没有这个任务 |

所以接收方不需要自己实现幂等：重复投递被存储层挡成 `duplicate`。`harness.signal()` 和 `submit()` 一样，会顺手开启调度。

## 睡觉等信号

任务用检查点声明“我睡在这个 key 上”：

```ts
runtime.commit(
  () => ({ status: "sleeping", checkpoint: { phase: "greeted" }, signals: [Greeting.key("hello")] }),
  ctx,
);
```

- 睡眠期间任务**不持有调用**，进程可以退出。
- 唤醒原因记在 `task.state.wake`：`{ reason: "signal", signal, key }`、`{ reason: "time" }`、`{ reason: "expired" }`、`{ reason: "tasks", ended }`。
- 同时给 `until` 就是“信号或时间，谁先到谁算”；时间先到，`reason` 是 `expired`。
- **值先到也没关系**：投递会存在任务里，睡眠一提交就立刻醒（示例的第一个 greeter 就是这样）。

## 读值

```ts
const state = await runtime.readSignal(Greeting, "hello", ctx);
const text = state?.kind === "value" ? state.value.text : "(none)";
```

- `SignalState` 是 `{ kind: "value", value } | { kind: "expired" }`（或 `undefined`：这个 key 从没来过东西）。
- 读到任务结束为止；形状按 token 版本迁移；`expired` 表示这个 key 等超时了。
- 一个 key 只服务一次等待：**唤醒即消费**。值被消费后，同一个 key 再来一次就是新的一轮等待。

## 宿主的视角

`harness.wake()` 回答“这个进程现在需要跑吗”：

- 有能立刻跑的或正在跑的任务：`{ active: true }`。
- 只有带 deadline 的睡眠：`{ active: false, at: <最早时刻> }`，宿主定时叫醒自己。
- 只有等信号的睡眠：`{ active: false }`，**没有 `at`**——所以宿主可以彻底休眠，等外部投递再起。

`HarnessOptions.onWake` 是“该定闹钟了”的回调，宿主在里面安排定时器；`resume()` 是醒来后打开调度。这一对就是“自己管进程”的完整接口，Durable Object alarm 那种场景靠它。

## 用在哪

- 工具 park 等外部事件（webhook、人、慢任务）——工具从 `execute()` 返回 park，本质就是“睡在某个信号上”。
- 子会话结算通知：内置的 `SubmissionSettled` 信号在提交结算的那个 commit 里投给指定任务，让父任务等子会话答完。
- 审批闸：`beforeTool` 睡在 `Approval.key(参数指纹)` 上，人来点批准或拒绝。

## 类型

- `defineSignal()` 返回值是 `SignalToken<Static<S>>`，`readSignal()` 和 `signal()` 的值类型都由它决定，不用手写泛型。
- `SignalState` 是标签联合，判 `kind`，不要用 `"value" in state` 这种形状探测。
- `task.state.wake` 也是标签联合，`reason` 收窄之后各分支字段不同。
- `TaskId` 是品牌数字类型，测 `not_found` 时要 `as TaskId` 转一下。

## TS / JS 语法

- **用 `as never` 测非法输入**：`{ text: 42 } as never` 绕过编译期检查，专门验证运行时 schema 校验。
- **数字下划线**：`999_999 as TaskId`。
- **表达式体箭头函数**：`work: (_task, runtime, ctx) => runtime.commit(...)` 直接返回 Promise，不必写 `await`。
- **阶段联合**：`defineTask<null, { phase: "work" } | { phase: "greeted" }, string>`，两个阶段各自一个检查点形状。
- **轮询等状态**：`while ((await harness.getTask(id, ctx))?.state.status !== "sleeping") await new Promise((r) => setTimeout(r, 1));`——脚本里等任务进入某状态最省事的写法。
- **空实现占位**：`onWake: () => {}` 表示这个宿主不需要额外动作。
