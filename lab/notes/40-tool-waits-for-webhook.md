# 等 webhook 的工具：park、幂等、取消

工具启动外部任务（CI），然后 park 住等回调。等待期间不占进程；崩溃后重跑不会重复启动；被 Stop 时能清理外部工作。这是“工具等外部世界”的完整模板。

## 工具必须写成三段式

```ts
async execute({ ref }, api, ctx) {
  const state = await api.readSignal(CiResult, "done", ctx);
  if (state?.kind === "value") return { output: [...], isError: status !== "passed" };   // ① 结果到了
  if (state !== undefined) return { output: [...never reported...], isError: true };      // ② 超时了
  const runId = await api.memo("ci.run", crypto.randomUUID(), ctx);                       // ③ 还没开始/重跑
  await webhooks.expect(runId, api.taskId, CiResult, "done", ctx);
  const build = await ci.trigger({ ref, idempotencyKey: runId });
  await api.details({ buildId: build.id }, ctx);
  return { kind: "sleep", checkpoint: { buildId: build.id }, signals: [CiResult.key("done")], until: api.now() + 2 * HOUR };
}
```

因为 **park 醒来后 `execute()` 从第一行重跑**，这个顺序不能变：先看结果到没到，再看是不是超时，最后才做“启动”这类副作用。把触发写在最前面，每次唤醒都会再启动一次 CI。

## 幂等键放 memo

```ts
const runId = await api.memo("ci.run", crypto.randomUUID(), ctx);
```

- `memo` 首次写入胜出：第一次生成的 UUID 被持久化，重跑拿回同一个。
- 外部服务用这个键去重：`ci.trigger({ idempotencyKey: runId })` 用同一个键触发两次只起一个 build。实测重跑后 `builds` 里仍然只有 `build-1`。
- 工具声明 `replay: "safe"`，框架才允许崩溃后重跑；默认 `unsafe` 会记成 `interrupted` 不再执行。

两者缺一不可：`replay: "safe"` 决定“允不允许重跑”，memo 决定“重跑不会重复副作用”。

## 注册回调要早于触发

```ts
await webhooks.expect(runId, api.taskId, CiResult, "done", ctx);   // 先登记
const build = await ci.trigger({ ref, idempotencyKey: runId });    // 再触发
```

如果反了，一个很快的回调可能先到，宿主不知道要把值投给谁。示例里的 `webhooks.expect` 是内存 Map，真实宿主必须持久化（否则崩溃后回调无处投递，只能等 deadline）。

## park 之后谁持有进程

```
parked slot: { callId, name: 'run_ci', taskId: 12, status: 'sleeping', details: { buildId: 'build-1' } }
wake while parked: { active: false, at: 1795697302912 } deadline in 2 h
```

- `pi.live.tools[0]` 里能看到这次调用的状态和 `details`，界面据此显示“等 CI”。
- `wake()` 给出 `{ active: false, at }`：不用跑，但两小时后没回调就来收尸（超时 → 错误结果）。
- 只有回调到达或 deadline 到，才会有下一次调用。

## 回调到达

```ts
await harness.signal(taskId, CiResult, "done", { status: "passed", logUrl: "https://ci/1" }, context);
```

- 第一次 `delivered`，重试 `duplicate`（键已占用）——webhook 重投递天然幂等。
- 值到达后任务被唤醒，`execute()` 重跑，第一段就读到 `{ kind: "value" }` 直接返回结果。

## 崩溃与取消

模拟崩溃：第一次尝试触发 build 之后既不 park 也不提交，进程等于卡死。另一个 Harness 打开同一份 SQLite：

1. 任务是 `running` 但没人推进 → 恢复后按 `replay: "safe"` 重跑；
2. `execute()` 重跑：`readSignal` 还没有值 → 走到第三段；
3. `memo("ci.run")` 拿回原来的键 → `ci.trigger` 返回**同一个 build**，没有产生 `build-2`；
4. 重新 park，等回调。

取消（park 中被 Stop）：`root.abort(context)` → 工具的 `cancel(args, api, ctx)` 在新调用里跑：

```ts
if (api.checkpoint !== undefined) await ci.cancel(api.checkpoint.buildId);
else await ci.cancelByKey((await api.memo<string>("ci.run", ctx))!);
```

- 有 checkpoint（已经 park 过）→ 直接按 build id 取消。
- 没有 checkpoint（触发完还没 park 就被切断）→ 用 memo 里的幂等键反查。
- `cancel` 可能被调用多次，必须幂等。
- 调用最终以 `<harness>[error] Tool run_ci was aborted` 结束。

## 宿主侧的四个动作

| 时机 | 做什么 |
|---|---|
| 启动/恢复后 | `resume()` |
| 需要知道何时回来 | `wake()` → `{ at }` 设闹钟；`onWake` 收到变化 |
| webhook 进来 | `harness.signal(taskId, token, key, value, ctx)` |
| 进程重启后接着等 | `harness.submission(id, ctx)` 拿回提交再 `wait()` |

## 类型与语法

- `defineTool<TParameters, TDetails, TCheckpoint>`：第三个泛型是 park 的 `checkpoint` 形状，`api.checkpoint?.buildId` 才带类型。
- `SignalToken<T>` 可以当值传（`webhooks.expect` 收一个 token 再投递），不必在投递处写死 token。
- `readSignal` 三态：`undefined`（还没来）/ `{ kind: "value" }` / `{ kind: "expired" }`。
- `crypto.randomUUID()`：Node 全局 `crypto`，不用 import。
- `new Promise((_, reject) => ctx.abortSignal?.addEventListener("abort", reject, { once: true }))`：让这次尝试“一直挂着”，直到进程被中止——模拟崩溃而不真的 `process.exit`。
- `const [match] = expected.keys();` + `match!`：`noUncheckedIndexedAccess` 下要断言。
