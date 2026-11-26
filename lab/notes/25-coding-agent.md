# 组装一个小编码 agent

前面所有零件在这里拼成一个能跑的东西：编码工具的扩展、知道工作目录的提示词、外部可改的设置、跟随会话目录的环境。两个问题之后换目录、改设置，立刻生效。

## 五块零件

```ts
const Coding = defineExtension({
  name: "coding",
  sections: [
    section("preamble", () => "You are a coding agent. Use the tools to inspect the project.", { tag: false }),
    section("cwd", (input) => input.env?.cwd),
  ],
});
registry.install(CodingTools);   // read / write / edit / bash
registry.install(Coding);        // 提示词
```

| 零件 | 作用 | 失效会怎样 |
|---|---|---|
| `CodingTools` | 提供 read/write/edit/bash | 模型没有工具可调，只能空谈 |
| `preamble` 段落 | 角色说明 | 模型不知道自己该动手 |
| `cwd` 段落 | 告诉模型当前目录 | 它要用 `pwd` 探路，多花一轮 |
| `settings` getter | 应用自己的设置对象 | 改设置要重开 Harness |
| `env` 工厂 | 按会话 cwd 建环境 | 换目录要重建工具或会话 |

## 设置为什么要写成 getter

```ts
const userSettings = { parallelTools: true, maxRetries: 3 };
const settings: HarnessSettings = {
  get toolExecution() { return userSettings.parallelTools ? "parallel" : "sequential"; },
  get retry() { return { maxRetries: userSettings.maxRetries }; },
};
```

Harness 对 `settings` 的每个字段都是**每次使用时读**。所以 getter 把“应用里的可变对象”接进来，改 `userSettings.parallelTools = false` 立刻影响下一次决策——不需要重开 Harness，也不需要通知谁。

这就是“用户改了设置文件”的正确接法：宿主监听文件变化写进 `userSettings`，其余什么都不用做。反过来，如果把 `settings` 写成一次性算好的死对象，就得自己重建 Harness。

## 环境为什么是工厂

```ts
const env = ({ cwd = workspace }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd });
```

Harness 每次需要环境时调用它，`cwd` 来自会话 agent。于是：

```ts
await root.configure({ cwd: join(workspace, "app") }, context);
```

改会话目录之后，**下一次工具调用就用新目录**，不用重建工具、不用重开会话。实测两行输出：

```
bash ran in: /tmp/pi-durable-agent-QEhidY
bash ran in: /tmp/pi-durable-agent-QEhidY/app
```

## 怎么验证“环境真的跟着走”

让模型跑 `bash pwd`，再从工具结果里读文本：

```ts
const page = await root.entries({}, 10, undefined, context);
const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
result.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join("");
```

`entries({}, 10)` 默认最新在前，所以 `find` 拿到的就是最近一条工具结果。这是最短的“自检回路”：模型的意图 → 工具执行 → 条目 → 断言。

## 还缺什么（产品化的差距）

这个示例已经是“agent 的骨架”，但离产品还差这些——也正是自己搭 agent 时要补的部分：

| 缺的 | 说明 |
|---|---|
| 持久存储 | 这里 `MemoryStorage`，进程结束就没了；要换 JSONL/SQLite |
| 界面与传输 | 没有流式打印、没有 steer、没有 abort；接 `pi.live` 或 ops/state 流 |
| prompt 的真实内容 | 只有角色和 cwd；真实 agent 要给 git 状态、文件树、AGENTS.md 等段落 |
| 压缩配置 | 没设 `compaction`，长会话会撞上下文 |
| 成本与用量 | 没读 `pi.usage`，也没设预算 |
| 重试与失败策略 | `retry` 给了但只用于设置演示；`afterFailedRun` 没配 |
| 安全边界 | `NodeExecutionEnv` 直连本机文件系统和 shell，没有沙箱 |
| 观测 | 没接 `onReport` / telemetry |

按这些缺口逐条补，就是“从头造一个 agent”的路线。

## 类型

- `HarnessSettings` 是部分可选对象，只写你关心的字段即可（其余取默认）。
- `env` 的参数类型是 `EnvTarget` 的结构子集：`{ conversationId, cwd?, read }`，只声明用到的字段就够了。
- `ToolResultEntry.is(entry)` 之后 `entry.model!` 仍是消息数组，取具体形状要 `as ToolResultMessage`。
- `settings` 里的 `toolExecution` 类型是 `"parallel" | "sequential"`，getter 的返回类型由对象字面量推断，无需标注。

## TS / JS 语法

- **对象里的 getter**：`get toolExecution() { … }`，与普通属性同形，但每次读取都执行。
- **参数解构默认值**：`({ cwd = workspace }: { readonly cwd?: string }) => …`。
- **`ToolResultMessage`**：`content` 是 `(TextContent | ImageContent)[]`，取文本要判 `part.type`。
- **`find(guard)`**：`page.items.find((entry) => ToolResultEntry.is(entry))`，配合谓词类型守卫使用时注意它返回联合成员，需要再断言。
- **临时目录**：`mkdtemp` / `mkdir` / `rm(..., { recursive: true, force: true })`，示例结束自己清理。
