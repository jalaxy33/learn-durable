# 轮询慢任务：按时间 park + 退避

工具启动一个慢任务，然后**睡一段时间**再看一次，直到完成。等待期间不占进程；每次唤醒把轮次和下一次间隔写进 checkpoint；宿主的“闹钟”只需要知道下一个时刻。

## 一个 execute，反复重跑

```ts
async execute({ name }, api, ctx) {
  const id = api.checkpoint?.id ?? (await jobs.start(name, await api.memo("job.key", crypto.randomUUID(), ctx)));
  const status = await jobs.status(id);
  const polls = (api.checkpoint?.polls ?? 0) + 1;
  if (status === "done") return { output: […] };
  const delayMs = Math.min((api.checkpoint?.delayMs ?? 500) * 2, 60_000);
  return { kind: "sleep", checkpoint: { id, polls, delayMs }, until: api.now() + delayMs };
}
```

三段式（和 40 一样）：

1. **先看已有状态**：`checkpoint.id` 有值说明已经启动过，直接用；没有才启动。
2. **做一次检查**：`jobs.status(id)`。
3. **没完成就 park**，把“下次从哪继续”全部写进 checkpoint：`id`、`polls`、`delayMs`。

`execute` 每次唤醒都**从第一行重跑**，所以这些值必须从 checkpoint 读，不能放模块变量。

## 退避

```ts
Math.min((api.checkpoint?.delayMs ?? 500) * 2, 60_000)
```

500ms 起步、每次翻倍、封顶 60 秒。实测（第一次 park 后间隔 1000ms，然后 2000、4000）：

```
[poll 1 at 0s] job-7 is running
asleep until 1 s: { active: false, at: 1000 }
[poll 2 at 1s] job-7 is running
asleep until 3 s: { active: false, at: 3000 }
[poll 3 at 3s] job-7 is running
asleep until 7 s: { active: false, at: 7000 }
[poll 4 at 7s] job-7 is done
```

绝对时间是 0 → 1 → 3 → 7，差值 1/2/4 秒，就是翻倍。

## 幂等：先 memo，再启动

```ts
await api.memo("job.key", crypto.randomUUID(), ctx)
```

- `memo` 首次写入胜出：第一次的 UUID 被持久化，重跑拿回同一个。
- 外部服务用这个键去重：同一个键启动两次只起一个任务。
- `replay: "safe"` 允许崩溃后重跑；**没有 park 之前崩溃**时（`checkpoint.id` 还没有）就靠 memo 找回同一个任务。

两者缺一不可，和 40 的结论一样。

## 宿主只需要一个时刻

```ts
const wake = harness.wake();
if (!wake.active && wake.at !== undefined) {
  clock = wake.at;       // “闹钟响了”
  harness.resume();
}
```

- 停车期间 `wake()` 是 `{ active: false, at }`：没人要跑，到 `at` 再回来。
- 示例用注入的 `clock`（`now: () => clock`）把“等 4 秒”变成“拨表 + resume”，等价于真实宿主里 alarm 到点。
- 没有 `at` 的情况（等信号）就完全不需要闹钟——那是 38/39/40/43 的场景。

## `durationMs` 是“含停车时间”的

```
durationMs (first run to result, on the Harness clock): 7000
```

它不是“最后一次 execute 跑了多久”，而是**从工具任务第一次运行到结果落盘**，按 Harness 时钟算，停车、崩溃停机、重跑都算在内。所以做耗时统计时要知道这个口径。

## `onWake` 是“值变了就叫你”

```
onWake calls: 13
```

四次轮询里有多次状态切换（active → 不 active、at 变化），每次都通知。所以它不是“一次性闹钟”，宿主应该在回调里**重新读 `wake()` 并重设闹钟**，而不是只设一次。

## 四种 park 的分工

| 示例 | park 形态 | 等什么 | `wake()` |
|---|---|---|---|
| 40 webhook | `{ kind: "sleep", signals, until }` | 外部信号或超时 | `{ active: false, at }` |
| 41 轮询 | `{ kind: "sleep", until }` | 只有时间 | `{ active: false, at }` |
| 42 并行子调用 | `{ kind: "wait", on, policy: "any" }` | 子任务 | `{ active: false }` |
| 43 subagent | `{ kind: "sleep", signals }` | 子会话结算 | `{ active: false }` |

## 类型与语法

- `api.checkpoint?.polls ?? 0`：第一次跑没有 checkpoint。
- `Math.min(x * 2, 60_000)`：退避上限。
- `void submission.wait(ctx).then(() => { settled = true; })`：不 await，只记状态，让主循环能轮询 `wake()`。
- `wake.at !== undefined`：判断“有没有定时唤醒”。
- `result.durationMs` 可选（旧记录没有）。
