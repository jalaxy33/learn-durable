# 并行子调用：扇出、按任务等待、扇入

一个工具启动两个嵌套调用但不等待，自己 park 在“任一结束”上。每个唤醒把结束的调用记进检查点，最后一个都没了再统一收结果。整个过程不占进程。

## 两个 API 配合

```ts
const a = await api.executeTool("research", { topic: x }, ctx, { key: "a", wait: false });
const b = await api.executeTool("research", { topic: y }, ctx, { key: "b", wait: false });
…
return { kind: "wait", checkpoint: { done: [...done] }, on: open.map((c) => c.taskId), policy: "any" };
```

- `executeTool(..., { wait: false })` 启动嵌套调用就返回 `{ taskId, result(ctx) }`。嵌套调用本身是一个 `pi.tool` 任务，owner 是调用者。
- 返回 park `{ kind: "wait", on, policy }` 表示“睡在这些任务上”。`policy: "any"` 是任一结束就醒；`allSettled` 是全等。

不等待 + 任一结束，就是“并行发出去、谁先回来先处理”。

## `key` 是跨唤醒的名字

```ts
{ key: "a" }
```

同一工具调用重跑时（崩溃恢复、或从 park 醒来后重新执行），`executeTool` 用 key 找回**同一个**嵌套调用，不会重复启动。所以每个并行分支都要有稳定的 key：`"a"`、`"b"`，或者业务 id。

这跟 40 里 memo 幂等键是一个思路，只是这里由框架记录。

## 每次唤醒只告诉你“谁结束了”

```ts
const done = new Set(api.checkpoint?.done ?? []);
if (api.wake?.reason === "tasks") for (const id of api.wake.ended) done.add(id);
console.log(…, `${done.size} of 2 done`);
const open = [a, b].filter((call) => !done.has(call.taskId));
```

`policy: "any"` 只保证“至少一个结束”，所以必须把结束的 id **累积进检查点**，否则第二次醒来会忘掉第一次的结果。实测两次唤醒：

```
run with wake undefined, 0 of 2 done
run with wake {"reason":"tasks","ended":[16]}, 1 of 2 done
run with wake {"reason":"tasks","ended":[14]}, 2 of 2 done
```

第一次是新调用（`wake` 为 `undefined`），后两次各带一个 `ended`。

## 收结果

```ts
const [ra, rb] = await Promise.all([a.result(ctx), b.result(ctx)]);
return { output: [{ type: "text", text: `${String(ra.structuredOutput)}\n${String(rb.structuredOutput)}` }] };
```

`result(ctx)` 取嵌套调用的结果；没有 `structuredOutputSchema` 的工具，`structuredOutput` 就是它的有界输出文本。全部结束之后再统一收，顺序稳定（先 a 后 b），与谁先醒无关。

## 界面上看到什么

```
tool: [ 'research_both waiting' ] nested: [
  'tool:…/a sleeping',
  'tool:…/b sleeping'
]
wake while everything is parked: { active: false }
```

- `pi.live.tools`：外层调用，状态 `waiting`（它 park 在任务上）。
- `pi.live.nestedTools`：两个嵌套调用，各自 `sleeping` 在自己的信号上，`callId` 形如 `tool:<父调用>/a`。
- `wake()` 是 `{ active: false }`：三个东西全在等外部输入，没有任何 deadline，进程可以彻底退掉。

信号是投给**嵌套调用**的任务 id 的（`harness.signal(b.taskId, …)`），不是父调用的。父调用只是在等这些任务。

## 为什么值得这么写

- 扇出：多个独立子任务并行，互不阻塞（对比：串行等待会让总时长相加）。
- 不占进程：等待期间没有 invocation，宿主的计费/容器可以归零。
- 结果稳定：按 key 收集，不受完成顺序影响。
- 幂等：`replay: "safe"` + key，崩溃后重跑接回原来的嵌套调用。

代价是状态要显式记（谁完成了），因为“任一结束”的语义故意不给你“当前都有谁”，只给“这次谁结束了”。

## 类型与语法

- `defineTool<TParameters, TDetails, TCheckpoint>`：第二个泛型是 `details` 的类型，这里用 `never`（不写 details）；第三个是 park 的检查点 `{ done: TaskId[] }`。
- `api.wake` 是标签联合：`reason === "tasks"` 时才有 `ended`。
- `a!.taskId`：`nested()` 返回的槽位可能为空，脚本里断言存在。
- `new Set(api.checkpoint?.done ?? [])`：Set 去重，同时处理“第一次没有检查点”。
- `String(ra.structuredOutput)`：无 schema 时它是文本，但类型上是 JSON，显式转一下。
