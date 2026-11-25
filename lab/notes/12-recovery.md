# recovery：自己写一个任务，关掉再打开继续

durable 里“任务”是可恢复的状态机：输入 + 检查点 + 备注都在存储里，进程只是执行器。关掉进程再打开，任务从最后一个已提交的检查点继续。

## 定义一个任务

```ts
const Ticker = defineTask<{ to: number }, { phase: "tick"; n: number }, string>({
  name: "example.ticker",
  version: 1,
  initial: () => ({ phase: "tick", n: 1 }),
  phases: { tick: async (task, runtime, ctx) => { ... } },
  abort: async (_task, runtime, ctx) => { ... },
});
```

四块必填、两块可选：

- `name`：注册的 kind，写进 `TaskRecord.kind`，重启后靠它找回代码。
- `version`：定义版本，跟着存活的输入和检查点一起存。升级定义时配合可选的 `migrate(input, checkpoint, fromVersion)`；没有它，旧版本记录会以 `task_too_old` / `migration_failed` 阻塞。
- `initial(input)`：新任务的第一个检查点。
- `phases`：**穷尽**的阶段表，键必须是检查点 `phase` 的所有可能值；编译器会保证不漏。
- `abort`（必填）：被标记中止时在新的一次调用里跑，必须提交一个终结结局。
- `hooks`（可选）：`TaskRuntime.hooks` 暴露给扩展挂的钩子。

处理函数拿到 `(task, runtime, context)`：`task.state.checkpoint` 已经被收窄成当前阶段那个分支，所以只有 `tick` 里能访问 `.n`。

## 建任务

```ts
await conversation.commit((tx) => tx.createTask(Ticker, { to: 5 }, { ownership: { kind: "conversation" } }), ctx);
```

- 建任务和写检查点在**一次提交**里完成：任务记录带 `input` 和 `initial` 结果。
- `ownership`：`conversation`（顶层任务）或 `task`（某个任务的子任务）。子任务随父任务的生命周期走。

## 推进只能靠提交

阶段处理器推进状态的唯一方式，是提交一个新的检查点：

| 写法 | 含义 |
|---|---|
| `runtime.commit(() => newState, ctx)` | 换检查点；返回 `undefined` 表示不改 |
| `runtime.commit(() => ({ status: "terminal", outcome }), ctx)` | 结束任务 |
| `runtime.sleepUntil(until, newState, ctx)` | 睡到某个时刻再从这个检查点继续 |
| 直接 return | 阶段结束但状态不变（下次还会从同一检查点重跑） |

**没提交的东西就不存在。** 打印、发请求、写文件这些副作用不在存储里；进程死在副作用之后、检查点之前，重启后这段会重跑一遍。

## memo：把“已经做过”记下来

`memo(name)` 读，`memo(name, candidate)` 写，**首次写入胜出**，返回存下来的那个值。于是副作用可以做成幂等：

```ts
if ((await runtime.memo(`printed-${n}`, ctx)) === undefined) {
  await runtime.memo(`printed-${n}`, true, ctx);   // 先记意图（提交）
  console.log(`tick ${n}`);                        // 再做副作用
}
```

顺序很重要：**先记意图，再做副作用**。崩在两者之间，重启后 memo 说“做过了”，就不再做；崩在记意图之前，副作用也没发生，重做是对的。

memo 是任务级的持久映射，不用自己造表，也不会被检查点覆盖。

## sleep：不占调用

`sleepUntil(until, checkpoint)` 提交一个“睡到某时刻”的检查点，然后**这个任务就不再持有任何调用**——进程可以退出。存储里留着 `wake: { reason: "time" }`，之后 Harness 打开（或 `resume()`）时，到点就继续。

对应地，宿主自己管进程时用 `harness.wake()` 问“下一个该醒的是什么时候”，用 `onWake` 在需要时把进程叫起来（Durable Object alarm 这类场景）。

`sleepUntil` 只解决“等时间”。等外部事件用信号（`sleep` + `defineSignal`），等别的任务用 `commit` 返回带 `on` 的等待状态。

## 关掉再打开

```ts
const firstRun = await open();       // 同一个存储
firstRun.resume();                   // 开调度
await tickTwo;                       // 等到第 2 次
await firstRun.close(context);       // 等正在跑的代码返回，然后关

const reader = await open();         // 只读地看记录，不 resume，所以什么都不会跑
const saved = await reader.getTask(tickerId, context);
console.log(saved.state, saved.memos);
```

关掉时正在跑的阶段会被打断：它没提交的检查点不存在，所以存储里留着的是上一个检查点。实际跑出来：

```
状态 pending，checkpoint { phase: 'tick', n: 2 }，wake { reason: 'time' }
memos { 'printed-1': true, 'printed-2': true }
```

再打开、`waitForTask(tickerId)`：这个等待本身会开启调度（`submit`/`wait`/`waitForTask`/`waitForIdle` 都会），任务从 `n: 2` 重跑——memo 说 tick 2 打印过了，所以静默跳过，接着 3、4、5。

**“重新开始”不需要任何手工操作。** 状态在存储里，调度器打开后自己会捡起来。

## 重启后靠什么对上代码

- `kind`（`name`）：找到注册表里哪个定义能跑它。没注册 → `blocked: missing_task`。
- `version`：决定是否需要 `migrate`；迁移失败同样阻塞。阻塞的任务可以被中止（记为 `orphaned`）。
- 检查点：结构与阶段名必须和新代码对得上（`migrate` 负责旧结构的转换）。

所以“存的是名字和状态，代码是每次重新装进来的”——这也是为什么升级任务定义需要版本号和迁移，而不是直接改字段。

## 类型

- `defineTask<I, S, R>`：`S` 要带字面量 `phase`（如 `{ phase: "tick"; n: number }`）；阶段表要覆盖 `S["phase"]` 的全部取值；`R` 是终结结果的类型。
- 阶段处理器里 `task.state.checkpoint` 被 `Extract` 到当前阶段，别的阶段的字段访问不到。
- `task.input` 是 `I`（原始输入，永远不变），`task.state.checkpoint` 是可推进的那部分。
- `memo` 是重载：两个参数读、三个参数写。

## TS / JS 语法

- **占位函数变量**：`let reachedTick = (_n: number): void => {}`，先给个空实现，测试里再替换成真正回调。比可选调用（`reachedTick?.(n)`）更能表达“一定存在”。
- **手动 Promise 当信号**：`new Promise<void>((resolve) => { reachedTick = (n) => { if (n === 2) resolve(); }; })`，用它把“跑到第 2 步”变成可 await 的事件。
- **下划线前缀**：`_task`、`_n` 表示故意不用的参数。
- **`!` 非空断言**：`(await reader.getTask(id, ctx))!`，调用方知道记录存在。
- **对象字面量当函数体**：`() => ({ status: "terminal", outcome: ... })`——箭头函数直接返回对象要加括号。
- **`rm(dir, { recursive: true, force: true })`**：递归删目录，不存在也不报错。
