# 工具调用：存储、环境、任务、钩子

一次带工具的对话不再是“一次模型请求”，而是一条链：生成 → 工具任务 → 下一次生成 → …，每一步都是独立的提交，崩在任何一步都能接着走。

## 存储换成真磁盘

```ts
const storage = await openNodeJsonlStorage(directory, context);
const harness = await Harness.open(storage, { models, registry, env }, context);
```

`Storage` 是一个接口，`MemoryStorage` / JSONL / SQLite 都实现它。换了实现，Harness 之上的代码一行不用改。

JSONL 实现在目录里放两类文件：

- `main.jsonl`：提交日志，一行一次提交（`seq` + 写入列表）。
- `doc-N.jsonl`：每个文档的旁挂文件（`doc-2.jsonl` 这种），一次提交写一批。

打开时靠重放恢复；撕裂的最后一行会被截断/跳过。选项里 `fsync: true` 在追加主标记前刷旁挂文件，`readOnly: true` 用于只读查看方。

一次这样的对话大约是几十行提交记录（这个示例 37 次提交）。

## 环境

```ts
env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() })
```

- 每次使用都重新建，`target.cwd` 来自会话的 agent 配置。
- **工具只通过环境碰文件和进程**：`read`/`write`/`edit` 走环境的文件系统，`bash` 走环境的 shell。想隔离（容器、远程、只读沙箱），换一个 `env` 实现即可，工具代码不动。
- 没配环境时 `input.env` 是 `undefined`，依赖环境的工具会以错误结果告知模型。

## 工具

`CodingTools` 是内置扩展，提供 `read`、`write`、`edit`、`bash`；没有任何东西会自动安装它，`registry.install(CodingTools)` 才生效。

每个工具有 `pi-schema` 声明的参数 schema，调用前校验；校验失败的调用不会执行，模型拿到 `invalid_arguments` 的错误结果（`call.arguments` 是模型原样发的）。

## 每个调用是一个任务

模型返回的每个工具调用都会变成一个 `pi.tool` 任务：

- 归这次生成任务所有（`owner` 指向上层），生成任务等它们全部结束，再用结果继续下一轮生成。
- 并行调用是多个平级任务，等待策略决定“全等”还是“任一”。
- 轮数上限由 agent 的 `maxTurns` 控制，超过就以 `turn_limit` 结束。

崩溃恢复的粒度因此是“这次工具调用”，不是“整轮对话”；具体分界见下面的时序。

## 一次调用的时序

模型不执行任何东西：它返回的 assistant 消息里带 `{ id, name, arguments }`，这串东西先成为数据，再由任务去执行。

```
pi.generation
  ├─ prepare：渲染 sections，写 pi.system 补丁，提交 checkpoint{request}
  ├─ request：调模型
  └─ 一次提交里：
       ① 追加 pi.assistant（带 tool calls）
       ② 每个 call 建一个 pi.tool 任务（owner = 本 generation）
       ③ 写 pi.live.tools 槽位，checkpoint{phase:"tools"}
     然后 waiting / allSettled —— generation 挂起，不再跑任何代码

pi.tool（每个调用一个，可并行）
  ├─ call：解析工具 → 准备并校验参数 → beforeTool → 提交 intent → execute()
  ├─ execute：env = 工厂建的环境；读文件、写文件、spawn 子进程都在这
  └─ 收尾：输出限界 + 诊断 → afterTool → 一次提交：追加 pi.tool-result + 任务结束

任务全部结束 → 唤醒 generation → 重新读上下文（已含工具结果）→ 下一次 request → ……
```

最后一轮模型返回不带 tool calls 的应答：generation 追加 `pi.assistant`，把输入结算成 `done`（`answer` 指向该条目），跑完 `afterRun` 钩子结束。

### 任务内部（`call` 阶段）

1. **解析工具**：在会话当时的 agent 工具集合里按名字找。找不到 → 结果 `tool_unavailable`。
2. **准备 + 校验**：`prepareArguments` 修模型常见手滑，再用 schema 校验；不过就 `invalid_arguments`，`execute()` 不会跑。
3. **`beforeTool`**：换参数、拦截、或停在门口睡。
4. **提交 intent**：记下 `phase: "execute"`、最终参数、工具的 `replay` 策略（默认 `unsafe`）。**在 `execute()` 之前**——崩溃后才判断得出这个调用到底跑没跑。
5. **`execute(args, api, ctx)`**：真正干活。一切对外访问都经过 `api.env`。
6. **收尾**：输出限界、诊断块、`afterTool` 可替换结果。
7. **提交结果**：追加 `pi.tool-result`（`byTaskId` 记着哪个任务写的），任务结算 completed。

### 崩溃点在链上的后果

| 崩在 | 重启后 |
|---|---|
| 提交 intent 之前 | 当作没发生，重跑整个 `call` 阶段 |
| intent 之后、结果提交之前 | `replay: "unsafe"`（默认）不重跑，结果记 `interrupted`，从已提交的部分输出重建；`replay: "safe"` 才重跑 |
| 结果提交之后 | 直接用已提交的结果，不重跑 |

所以重放的粒度是**单次调用**，不是整轮对话。

### 并行还是串行

默认并行：一次给每个 call 建任务，generation 等 `allSettled`。串行有两种来源：`settings.toolExecution === "sequential"`，或某个工具的 `executionMode === "sequential"`——后者会让整轮按顺序走，先只建第一个任务，其余留在 checkpoint 的 `pending` 里。

并行时结果顺序取决于谁先结束，但每个结果都按 call id 配回去，所以 assistant 与 result 的交错顺序不影响语义。

### 谁在什么时候做什么

| 环节 | 谁 | 落成什么 |
|---|---|---|
| 决策 | 模型 | assistant 条目里的 tool calls（纯数据） |
| 调度 | 调度器 | 把任务排上、唤醒依赖它的任务 |
| 执行 | `pi.tool` 任务（harness 进程内） | 通过 env 读写文件、起子进程 |
| 事实 | 提交 | 意图、结果、进度都提交后才算数 |

## 工具错误是数据

工具失败不会抛到运行外面，而是变成一条 `pi.tool-result` 条目，内容里带上 Harness 的诊断块：

```
cat: /tmp/1gb.txt: 没有那个文件或目录
<harness>
[error] Command exited with code 1
</harness>
```

运行继续，模型自己决定怎么处理。只有运行级的失败（没模型、连续重启超限、被中止）才让这次输入 `unanswered`。

Hooks 看到的结果里，错误结果用**诊断码**区分来源：`tool_unavailable`、`invalid_arguments`、`blocked`、`interrupted`、`restart_limit`、`aborted`。

## 钩子

```ts
hook(ToolTask, { beforeTool, afterTool })
```

两次介入：

- `beforeTool(call, api, ctx)`：可以**替换参数**、**拦截**（返回 `block` 说明）、**停在门口睡觉**（`sleep`，等 deadline 或信号）。抛错等于拦截。返回 `undefined` 表示不改。`sleep` 之后每次唤醒都会把 call 阶段整个重跑一遍，所以门禁要读自己等的那个 key 来决定是放行、拦截还是继续睡。
- `afterTool(call, result, api, ctx)`：结果提交前调用，可以替换结果。所有写进 transcript 的结果都会经过它——包括 Harness 自己写的错误结果（中断、超限、中止）。

`HookResult<T> = T | undefined | Promise<T | undefined>`，所以同步返回、异步返回、返回“不改”都合法。

钩子在任务自己的上下文里跑，不在 Session 主线上，所以钩子里能读已提交状态，但不要指望它在提交中间看到更早的写入。

## 假模型演戏

`fauxProvider` 可以按脚本返回工具调用：

```ts
fauxAssistantMessage([fauxToolCall("bash", { command: "cat notes.txt" }, { id: "b" })], { stopReason: "toolUse" })
```

- 应答队列一次消耗一条：一条工具调用应答 = 一次生成；最后一条普通应答结束运行。
- `id` 是调用 id，工具结果按它回填；手写时保证唯一。
- `stopReason: "toolUse"` 才让运行进入工具轮；普通应答就地结束。

## 读 transcript

条目顺序就是事实顺序：`pi.user`、`pi.system`、`pi.assistant`、`pi.tool-result`、`pi.assistant`、……

工具结果的 `model` 是 `[ToolResultMessage]`，里面有 `toolName` 和 `content`。展示时长文本要自己截断。

## 类型

- `ToolResultEntry.is(entry)` 收窄到工具结果条目；`entry.model` 的静态类型仍是消息数组，取具体形状要 `as ToolResultMessage`。
- `Parameters<typeof fauxToolCall>[1]` 从函数签名里取第 2 个参数类型，省得手写一遍工具参数类型。
- `BashToolInput` 是 `bash` 工具的参数类型，钩子里判断命令内容时用它断言 `call.arguments`。
- `call.arguments` 在钩子里的静态类型是宽泛的 JSON，因为钩子对任何工具都生效。

## TS / JS 语法

- **`import type`**：`import type { ToolResultMessage } from "@earendil-works/pi-ai"`，纯类型进不来运行时。
- **参数类型提取**：`Parameters<typeof fn>[1]`。
- **函数式工具类型**：把 `isBigCat` 写成 `(call: { name: string; arguments: unknown }) => boolean`，比手写完整的 `ToolHookCall` 窄，够用即可。
- **`??` 兜底**：`target.cwd ?? process.cwd()`，`cwd` 是 `string | undefined`。
- **非空断言 + 断言**：`entry.model![0] as ToolResultMessage`——先告诉编译器“有值”，再告诉它“是这种消息”。
- **`mkdtemp(join(tmpdir(), "前缀-"))`**：建临时目录，返回路径；`join` 处理分隔符。
- **截断展示**：`text.length > 200 ? \`${text.slice(0, 200)}…\``。
- **钩子返回 `undefined`**：`HookResult` 允许，语义是“不修改”。
- **`hook(ToolTask, { ... })`**：`ToolTask` 是内置任务 token，用它当键；handlers 是 Partial，只写需要的阶段。
