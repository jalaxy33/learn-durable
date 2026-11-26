# 1. 基础：心智模型、Quick Start、持久化与恢复

> durable 的主线只有一条：**先把状态提交到存储，再让外界看到；进程死了，从最后一个 checkpoint 继续。**

版本：pi-durable **v1.6.1**。代码以此为准；版本差异见 `upstream/VERSIONS.md`。

## 你会学到

- durable 的三层结构，以及十个核心术语
- Quick Start 每一行在做什么，`commit` 那次"读"为什么容易误会
- 存储怎么选、启动顺序、为什么只能有一个写者
- `requestId` 幂等、phase 从头重跑、sleep、signal
- 崩溃、重试、`restartLimit`、失败后的队列

---

## 1. 三层图

```text
配置层    Extension ──install──> Registry ──resolve──> Agent
执行层    Harness ─> Task（状态机）  <── Submission（外部输入句柄）
记录层    Conversation ─> Entry（不可变日志） + Document（可变 JSON 状态）
存储层    Storage（Memory / SQLite / JSONL / IndexedDB / DO）
```

一句话记：

- **记录层**：发生了什么（entry）和现在是什么（document）。
- **执行层**：正在做什么（task），以及外部怎么送输入（submission）。
- **配置层**：用什么做（模型、工具、提示词）。

三层在**同一个 commit** 里落盘，所以不会分叉。

---

## 2. 十个术语（速览）

| 术语 | 一句话 | 详见 |
|---|---|---|
| Harness | 一个打开的存储 + 跑在上面的机器 | [术语表](../3-appendix/1-glossary.md) |
| Conversation | 一段 transcript；句柄无状态，按 `id` 比较 | 同上 |
| Entry | 不可变的记录（`pi.user`、`pi.assistant`…） | 同上 |
| Document | 带类型的 JSON 状态，只能在 commit 里改 | `4-runtime.md` |
| Commit | 原子写：entry + document + task 状态一起 | 本页 |
| Task | 持久状态机，每步存 checkpoint | 本页 |
| Submission | 交给会话的输入，可以 `wait` | 本页 |
| Turn / Run | 一轮模型回复 / 一条输入到最终答案 | 本页 |
| Extension / Registry | 能力包 / 本进程安装了哪些 | `2-building.md` |
| Agent | 会话运行所需的选择（模型、工具、指令、cwd） | `2-building.md` |

---

## 3. Quick Start 逐行

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });

const submission = await root.submit({ type: "input", content: "What is the capital of France?" }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log(answer?.model?.[0]);
}
await harness.close(context);
```

### 逐行说明

| 代码 | 作用 |
|---|---|
| `BACKGROUND_CONTEXT` | 永不取消、空 telemetry span 的 Context |
| `createModels()` / `setProvider()` | 依赖注入：模型目录由你创建、配置、再传进去 |
| `Harness.open(storage, host, context)` | 打开存储 + 建 Session；三个参数：存储、宿主服务、context |
| `harness.root(...)` | 第一次调用时创建根会话，`agent` 是它的运行配置 |
| `root.submit(...)` | **持久受理**一条输入，立刻返回句柄，不返回答案 |
| `submission.wait(...)` | 观察结果：`done` 或 `unanswered` |
| `root.commit(...)` | 借事务做一次**一致性读**（见下） |
| `harness.close(...)` | 关闭；运行中的代码要响应 abort，否则会拖慢关闭 |

### 一个容易误会的地方

```typescript
const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
```

这行**不是**把答案再写一遍。

- `settled.answer` 是 **EntryId（一个不透明的 ID；v1.6.1 里是数字）**，不是消息内容。
- 答案是 `pi.generation` task 自己 append 的。
- `commit` 的签名是 `commit<T>(change: (tx) => T | Promise<T>)`，返回 callback 的返回值。
- `tx.entry(token, id)` 是**读**：按 ID 取 entry，类型不符或不存在返回 `undefined`。

所以这里只是"在一个事务里把 entry 读出来打印"。之所以用 `commit` 而不是普通读，是为了拿到一致视图。

### 这段代码里的 TS 语法

- `import { A, B } from "pkg"`：具名导入。
- `{ models, registry: createRegistry() }`：对象字面量；`models` 是 `models: models` 的简写。
- `(tx) => ...`：箭头函数；返回值就是函数体。
- `settled.status === "done" && settled.type === "input"`：判别联合 + 类型收窄；进入分支后 `settled.answer` 才存在。
- `answer?.model?.[0]`：可选链 + 可选下标。
- `commit<T>`：泛型类型参数，编译期存在，运行时没有。

> 语法不熟不影响理解设计；把 `<...>` 当成"类型参数"即可。

---

## 4. 一次回答发生了什么

```text
submit(input) → pi.user
  pi.generation → pi.system (only if the prompt or tools changed), pi.assistant (tool calls)
    pi.tool × n → pi.tool-result × n   (owned by the generation, which waits for them)
  pi.generation → pi.assistant (answer) → submission done
```

两个要点：

1. **`pi.system` 只在变化时写。** 系统提示词是位置性 entry；没变就不重复，provider 的 prompt cache 才能命中。
2. **generation 不循环，而是交接。** 一个 generation 只管一轮；下一轮是新的 task。这样每个 phase 短、可重跑、可单独 abort。

### 设计取舍

| 选择 | 优点 | 代价 |
|---|---|---|
| 不可变 entry + 可变 document | 可审计 + 读得快 | 同一个 commit 要维护两套 |
| 先提交再展示 | UI 和存储不会分叉 | 写路径在关键路径上（后面用 group/deferred commit 缓解） |
| generation 交接而不是循环 | 每个 task 短、可恢复 | 每轮多一个 task 记录 |

---

## 5. 持久化

```typescript
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const storage = await openNodeSqliteStorage("./session.sqlite");
const harness = await Harness.open(storage, { models, registry }, context);
const root = await harness.root(context); // 和上次同一个根会话
harness.resume();                          // 继续上次没跑完的活
```

### 存储选型

| 后端 | 适用 | 注意 |
|---|---|---|
| `MemoryStorage` | 测试、demo | 进程结束全丢 |
| SQLite（Node） | **生产默认** | WAL + `synchronous=NORMAL`：崩溃不丢，断电可能丢最新一笔 |
| JSONL（Node） | 本地调试、看明文 | **整段历史常驻内存**；写者打开时会修复文件 |
| IndexedDB | 浏览器 | 单 owner，用 Web Lock |
| DO SQLite | Cloudflare | commit 就是 DO 的 storage transaction |

### 启动顺序

```text
打开存储 → Harness.open → root() → resume()
```

- `resume()` 启动 task 调度器；`submit()` / `wait()` 也会启动。
- 但 sleep 到期、上次中断的 run 需要有人踢一脚；启动时调用最稳。

### 两个硬约束

1. **一个存储一个写者**，没有跨进程锁。
2. **只读查看器**用 `readOnly: true`；JSONL 还要在 open 时也传 `{ readOnly: true }`，否则它会去"修复"写者正在追加的文件。

### 会话身份

每个 conversation 在 `pi.provider` 里存一个持久 UUIDv7，作为 pi-ai 的 `sessionId`，用于 provider 的 prompt cache 和会话亲和。

- 跨重开、重试、reset、compaction、换模型都**不变**。
- fork / 子会话拿**新**身份。
- 别为了"省上下文"新建 conversation；新建 = 缓存从零。

---

## 6. `requestId`：受理层幂等

```typescript
const s = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// 重启后，或者队列重投了同一条：
const again = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// again.id === s.id
```

语义：这个 ID 已经受理过，就把原来的 submission 还给你，不重复排队、不重复调模型。

什么时候需要：

- 消息队列是 at-least-once。
- 用户双击发送。
- 进程在 `submit()` 返回后、写回自己数据库前崩了。

按 ID 找回：

```typescript
const s = await harness.submission(id, context);
```

两个坑：

1. 去重只看 `requestId`，**不比较内容**。ID 要由业务生成（消息 ID、客户端 UUID）。
2. 第一次提交如果在落盘前崩了，等于没发生；第二次会正常受理。这正是想要的语义。

> 设计：幂等做在"受理"层，而不是"执行"层。执行可以重跑；重复受理才是灾难。

---

## 7. 最重要的规则：phase 不能中途 sleep

> 一个 phase 就是一个函数。进程崩了，重启后**整个函数从头再跑**。

所以不能写：

```typescript
// 错误：重启后前面会重跑，await 也会重来
await sleep(60 * 60 * 1000);
await notify();
```

正确写法：**结束这个 phase，把"睡"存进状态，醒来进下一个 phase**。

```typescript
const Reminder = defineTask<{ text: string; at: number }, { phase: "wait" } | { phase: "deliver" }, null>({
	name: "app.reminder",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		// 睡到任务被存下为止；这个 phase 到此结束
		wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
		deliver: async (task, runtime, context) => {
			await notify(task.input.text);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
```

### 语法提示

- `defineTask<Input, State, Result>`：三个类型参数；`State` 是 phase 联合。
- `{ phase: "wait" } | { phase: "deliver" }`：`phase` 是判别字段。
- `(task, runtime, context) => runtime.sleepUntil(...)`：箭头函数直接返回 Promise。
- `_task`：约定"有这个参数但不用"。

### 三个配套概念

| 概念 | 含义 |
|---|---|
| `checkpoint` | phase 之间传递的数据；必须能 JSON 序列化 |
| `runtime.sleepUntil(until, checkpoint)` | 睡到某个时间，醒来进 checkpoint 指定的 phase |
| `abort` | 任务被中止时的清理入口；必须提交 terminal outcome |

### 时钟

- Session、调度器、task 的定时器走 `setTimer`（默认 `setTimeout`），时间走 `now`（默认 `Date.now`）。
- 测试可以传假时钟，瞬间跳过几小时。
- **sleep 的截止时间按 `now` 存**，所以所有打开同一存储的进程必须用同一个时钟。

### 进程会被随时杀掉时

Node 长驻进程不用管；Cloudflare Durable Object 这类宿主传 `onWake`，harness 不自己设定时器，而是告诉你 `{ active, at }`，由宿主设 alarm，到点调用 `resume()`。细节见 `../2-architecture/3-deployment.md`。

---

## 8. Signals：不占进程地等外部事件

场景：等 CI、等人审批、等 webhook。

```typescript
const Answer = defineSignal({ name: "app.answer", version: 1, schema: obj({ text: str() }) });
```

task 睡在一个 key 上：

```typescript
ask: (_task, runtime, context) =>
	runtime.commit(
		() => ({
			status: "sleeping",
			signals: [Answer.key("answer")],
			until: runtime.now() + 4 * HOUR,
			checkpoint: { phase: "answered" },
		}),
		context,
	),
answered: async (task, runtime, context) => {
	// { kind: "value", value } | { kind: "expired" } | undefined
	const state = await runtime.readSignal(Answer, "answer", context);
	const text = state?.kind === "value" ? state.value.text : null;
	await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: text } }), context);
},
```

外部投递：

```typescript
const result = await harness.signal(taskId, Answer, "answer", { text: "Yes" }, context);
```

结果：

| 结果 | 含义 | 宿主怎么回 |
|---|---|---|
| `delivered` | 已持久保存 | 成功 |
| `duplicate` | key 已有值（webhook 重试） | 当成功 |
| `invalid` | 不符合 schema | 400 |
| `closed` | task 已结束/中止/超时 | 当终态 |
| `not_found` | 没有这个 task | 404 |

必须知道的行为：

- **早到的信号不丢**：值先存下，task 一睡就醒。
- **一个 key 只能等一次**：醒来即消费；第二次等要换 key（`ci-1`、`ci-2`）。
- **值要小**：存在 task 记录里；传引用（文档 ID、CI run ID）。
- **没有身份验证**：`harness.signal()` 不检查发送者；认证在宿主做。
- **submission 也能发信号**：`submit({ ..., notify: { taskId, key } })` 在 settle 时投递 `SubmissionSettled`。

实测（`38-signals`，faux provider）：

```text
early: delivered
retry: duplicate
bad value: invalid
unknown task: not_found
wake: { "reason": "signal", "signal": "example.greeting", "key": "hello" }
after the end: closed
asleep, wake: { active: false }
```

早到的值、重复投递、schema 不匹配、task 已结束，五种结果都能在输出里对上。

---

## 9. 失败与恢复

### 模型请求中断 ≠ 失败

进程在模型回答到一半时死了：

- 半截答案保留成一条 aborted entry。
- 这次算一次失败尝试，按 `settings.retry` 退避重试。
- 重试用完 → run 结束，`runFailure.reason = "interrupted"`。
- 花掉的 token 照算。

**graceful close 不算 crash**：`close()` 停掉的请求，下次直接重发，不消耗重试次数。

### 崩溃循环保护

每次 crash / eviction / reset 切断一个 task，计数 +1；task 提交新状态时清零。到 `settings.restartLimit`（默认 5）就不再重跑：

- 工具调用 → 错误结果，诊断码 `restart_limit`
- run → `runFailure.reason = "restart_limit"`
- 你自己的 task → `faulted`

进程死时**所有在跑的 task 都计数**，不只是"凶手"。

### `onReport`：生产必须接

```typescript
Harness.open(storage, { models, registry, onReport: (report) => { ... } }, context)
```

| kind | 含义 | 动作 |
|---|---|---|
| `storage_failed` | 存储错误，harness 已死 | 重开进程 |
| `task_faulted` | task 崩溃/达到 restartLimit | 告警 |
| `task_interrupted` | crash 导致 task 结束 | 统计 |
| `task_error` | 单个 task 报错 | 记录 |
| `extension_error` | hook/section/tool 抛错 | 修扩展 |
| `host_error` | 你传的回调抛错 | 修 |
| `task_outdated` | 定义缺失/太旧/迁移失败 | 部署问题 |

存储错误**不重试**：harness 结束，之后所有调用抛 `SessionFailed`。重开恢复；用同一个 `requestId` 重提不会重复。

### 失败后的队列

默认（`afterFailedRun: "keep"`）：失败 run 后面的输入**留在 inbox**，直到下一次输入、write 或 `continue`。

可选：

- `"continue"`：自动用排队的输入开下一轮。
- `"withdraw"`：全部 settle `unanswered`，reason `run_failed`。

### 被卡住的 task

定义缺失（`missing_task`）、版本太旧（`task_too_old`）、迁移失败（`migration_failed`）→ blocked。装回扩展会自动解冻，不用轮询。

---

## 10. 和主流方案的取舍

| | Temporal 类 | 会话文件类 | durable |
|---|---|---|---|
| 重放单位 | 整段 workflow 代码 | 无 | **task 的 phase** |
| 你保证什么 | 代码确定性 | 无 | phase 可重跑 + 副作用幂等 |
| 等待 | `await sleep` / signal | 无 | **结束 phase，状态里记 sleep** |
| 崩溃恢复 | 事件历史重放 | 恢复到最后一个 entry | 从 checkpoint 重跑当前 phase |
| 工具调用 | activity | 结果写文件 | **独立 task，有 replay 策略** |

**优点**：崩溃安全、可恢复、UI 和存储一致、可审计、可测试。
**代价**：phase 边界要自己设计、副作用要幂等、写路径重、概念多。

---

## 11. 自检

1. 为什么 `submit()` 返回 `Submission` 而不是答案？
2. `settled.answer` 是什么类型？为什么示例里要用 `commit` 去读它？
3. 进程在模型回答到一半时被杀，重启后会发生什么？哪些东西可能丢？
4. phase 里为什么不能 `await sleep(1h)`？应该怎么写？
5. 一个 webhook 要唤醒等了 20 分钟的工具。有哪几样东西必须由**你**存下来？

答案：[2-self-checks.md](../3-appendix/2-self-checks.md#1-基础)。

---

## 12. 相关

- 下一篇：[2-capabilities.md](2-capabilities.md)
- 术语：[1-glossary.md](../3-appendix/1-glossary.md)
- 原文：`upstream/pi-durable-README.v1.6.1.md` 的 Quick Start、Persist and Resume
- 对应官方示例：`00-conversation`、`13-chat`、`16-coding-tools`、`38-signals`、`39-ask-a-person`
