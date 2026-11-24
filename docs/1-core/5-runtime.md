# 5. 运行时：状态、观察与运维

> durable 把"事实"（entry）、"状态"（document）和"正在做什么"（task）放在同一个提交里；UI 读已提交的视图，运维读报告和任务图。成本是：任何持久状态都必须能表达成一次 commit。

版本：pi-durable **v1.6.0**。

## 你会学到

- document 的 scope/history/fork/checkpointWhen 分别在决定什么
- 为什么 deferred commit 只适合"掉了也无所谓"的进度
- 存储为什么只能一个写者，以及自定义后端的最小契约
- 错误的三条规则：什么时候只失败一次调用，什么时候整个 Harness 停
- code mode 的重放条件，以及它什么时候拒绝恢复
- watch 的窗口、ops、`ConversationTranscript` 如何拼出 UI
- 线上排障先看什么

---

## 1. 设计问题

一个会运行几小时的 agent，需要同时回答：

1. **发生了什么？**（审计、回放、UI）
2. **现在是什么状态？**（配置、队列、花费、正在跑什么）
3. **怎么观察？**（UI、外部同步、排障）

如果三者各存一份，就会出现"数据库说 A、内存说 B、UI 说 C"。durable 的答案：

> **事实进 entry，状态进 document，执行进 task；三者同一个 commit；外界只看已提交状态。**

---

## 2. Documents：挨着日志的状态

```typescript
const Todos = defineDoc<{ items: string[] }>({
  kind: "app.todos",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: () => false,
});
```

| 字段 | 决定什么 |
|---|---|
| `kind` | 存储里的类型名；改名 = 旧数据读不到 |
| `version` | 结构版本；改结构不升版本 = 误读 |
| `scope` | 地址：`session` / `conversation` / `task` |
| `history` | `latest` 只留最新；`rewindable` 可读旧值 |
| `fork` | fork 时子会话拿什么：`initial` / `current` / `asOf` |
| `checkpointWhen` | 什么时候存完整基线，限制重放长度 |

### `checkpointWhen` 为什么必需

document 的写入是**操作**，读取 = 最近的基线 + 之后的操作重放。

- 变化很少的文档：`() => false` 足够。
- 高频变化的文档：定期返回 `true`，否则读它要重放几千条操作。
- 流式文本不要自己存 document；`pi.live` 已经处理了。

### 作用域

| scope | 适合 |
|---|---|
| `session` | 整个 Harness 共享：注册表、全局配置 |
| `conversation` | 每个会话独立：偏好、配额、待办 |
| `task` | 单个 task 内部：进度、临时结果 |

缺失的文档视为 `initial()` 默认值，所以扩展可以"没初始化也能跑"。

### 写入与读取

```typescript
await root.commit(async (tx) => {
  (await tx.doc(Todos, root.id)).items.push("x");
}, context);

const todos = await harness.snapshot(Todos, root.id, context);
```

`conversationCreated(tx, conversation)` 在**每个创建或 fork** 的提交里跑——包括工具里 raw 的 `tx.createConversation()`。用它给每个会话初始化你自己的文档，这是唯一不会漏掉创建路径的地方。

---

## 3. Deferred commit：唯一允许"先展示后落盘"的地方

```typescript
await root.commit(
  async (tx) => { (await tx.doc(Todos, root.id)).items.push("draft"); },
  context,
  { persistence: { kind: "deferred", withinMs: 1_000 } },
);
```

条件很窄：

- 只改**已存在的 conversation 文档**；
- 且 `history: "latest"`、`fork: "initial"`；
- 提交里不能有 entry、新文档、task 状态、retirement。

一旦有这些，立刻存储。

| 谁 | 什么时候看到 |
|---|---|
| watch / 视图 | 立刻（内存已采用） |
| 存储 / `observeCommits` | 最晚 `withinMs` 后，或下一次读写该文档时 |

崩溃会丢掉未存储的部分。所以：

> **deferred 是缓存，不是账本。** 凡是"错了要赔钱"的状态，都必须走立即存储的 commit。

---

## 4. Storage：一个写者，多个后端

| 后端 | 适用 | 注意 |
|---|---|---|
| Memory | 测试 | 全丢 |
| SQLite | Node 生产 | WAL + `synchronous=NORMAL` |
| JSONL | 本地调试 | 整段历史常驻内存；写者打开会修复文件 |
| IndexedDB | 浏览器 | 单 owner，Web Lock |
| DO SQLite | Cloudflare | commit = storage transaction |

三条跨后端规则：

1. **一个存储一个写者**，没有跨进程锁。
2. 只读查看器用 `readOnly: true`；JSONL 连 open 也要只读。
3. 共享数据库用 `{ prefix: "pi_" }`；改前缀不迁移旧数据。

自定义后端的最小契约是 `commit(batches, receive, context)`：

```text
按顺序存 batches（每个是一个原子提交，带 seq）
全部 durable 之后，同步调用 receive(index, seq)  ← 落盘回执
返回 { stored, refused? }；未知结果就 reject
```

`receive` 让 Session 在"确认落盘"之后才发布，内存和视图不会看到半截日志。写完用 `registerStorageConformance()` 跑共享测试套件。

---

## 5. Errors：三条规则

### 规则 1：存储错误 = Harness 结束

```text
某次存储调用抛错
  → 这次调用 reject
  → 之后所有调用、pending wait 都 SessionFailed
  → watch 以 failed 结束
  → 运行中的 task 收到 abort
  → onReport 一次
  → Harness 自己关闭
```

不重试。瞬断重试是存储适配器自己的责任。

恢复：

```typescript
harness.closed.then((end) => {
  if (end.kind === "failed") reopen(end.error);
});
```

重开后提交是原子的，用同一个 `requestId` 重提能找到已受理的 submission。

### 规则 2：非法读只失败那一次调用

`StorageRequestError`：坏游标、未知会话、文档不保留的历史。

**豁免只覆盖读。** 从 `commit()` / `mintId()` 抛出的任何错误（包括 `StorageRequestError`）都按规则 1 处理——因为写的结果不确定，继续跑会产生不一致。

### 规则 3：你的代码只失败自己的单元

| 你的代码 | 后果 |
|---|---|
| task phase 抛错 | 该 task `faulted` |
| 工具 `execute` 抛错 | 模型收到错误结果 |
| hook 抛错 | 报告并跳过；`beforeTool` 抛错 = 拦下调用 |
| commit 回调抛错 | 整个 commit 回滚 |
| listener 抛错 | 报告，其他 listener 继续 |
| `RegistryReader.snapshot()` 抛错 | **Harness 失败**（调度器没法工作） |

`close()` 会等运行中的 task code 返回，所以忽略 abort 的代码会拖慢关闭。

---

## 6. Code mode：沙箱 + journal

```typescript
registry.install(createCodemodeExtension({
  sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
}));
```

模型写 JS，在 QuickJS 沙箱里跑；`tools.<name>()` 是嵌套调用；**只有脚本输出回到模型**。

### 重启怎么接着跑

```text
脚本执行 → 每个工具结果先写 journal，再交给脚本
崩溃重启 → 重跑脚本，按顺序把 journal 结果交回去
        → 已完成的调用不重新执行
        → 之后的调用按 key 接回嵌套 task
```

确定性来自沙箱：虚拟时钟、带种子的随机数、固定 UTC。

### 三种情况会拒绝恢复

| 情况 | 结果 |
|---|---|
| 脚本这次走了另一条路径 | 整个调用报错 |
| 沙箱指纹或 code mode 版本变了 | 报错 |
| `timeout_ms` 已经过了 | 报错 |

所以：**影响控制流的外部输入都走工具**（时间、随机、外部状态），这样才会进 journal。

### 其他要点

- namespace 把工具分组；提示词段只列命名空间和一行描述，不随工具增长。
- `searchTools()` / `describeTool()` / `describeNamespace()` 在脚本里按需发现。
- 嵌套调用失败会 reject，除非工具声明了 schema 并返回自己的错误值（如 `bash` 的 `exitCode`）。
- 嵌套调用的 usage 记在它自己名下，别在调用者里重复计。
- 脚本里的 `store` / `load` 按会话存；fork 看到 fork 点的值。

### 什么时候不该用

- 模型不擅长写代码。
- 只有 1–2 个工具、每次只调一次（沙箱是纯开销）。
- 内存受限（Cloudflare 小实例）。
- 你需要审计每一次工具调用的完整结果（嵌套结果不长期保存）。

---

## 7. Watching：UI 读的是视图，不是事件流

```typescript
const watch = await root.watch(context);
render(watch.value);
watch.start(async (call) => {
  if (call.kind !== "value") return;
  render(call.value);
  await send(call.ops);
});
```

视图里有：

| 字段 | 内容 |
|---|---|
| `entries` | transcript 的**窗口**，最新在最后 |
| `before` | 窗口之前那条 entry |
| `docs["pi.live"]` | run、流式片段、工具调用、重试、压缩、失败原因 |
| `docs["pi.inbox"]` | 排队中的输入 |
| `docs["pi.usage"]` | token/花费 |
| `docs["pi.agent"]` | 会话配置 |

### 窗口

- 初始最新 50 条；超过 100 条一次 splice 掉最旧，保留最新 50。
- `watch(context, { min, max })` 改边界；`from` 指定起点。
- 客户端必须处理 `before`，否则用户往上滚会觉得历史没了。

`ConversationTranscript` 负责"客户端已看过什么"：

```typescript
const transcript = new ConversationTranscript((q, limit, ctx) => root.entries(q, limit, undefined, ctx));
render(transcript.merge(watch.value));
render(await transcript.loadEarlier(context));
render(await transcript.fillGap(gap, context));
const resumed = await root.watch(context, transcript.resume);
```

entry 不可变，所以 merge 只增不改；没新增时返回同一个数组。

实测（`31`）：

```text
attach                       [load earlier] 191..200
15 more, live                [load earlier] 191..215
load earlier                 [load earlier] 171..215
resume after 40 missed       [load earlier] 171..215 [load more] 246..255
fill gap                     [load earlier] 171..235 [load more] 246..255
fill gap                     [load earlier] 171..255
```

### ops 与合并

- `ops` 是这次提交的 Chord 操作；可以直接发给远程客户端。
- 回调慢时，期间多次提交会在下一次回调里**折叠**：最新视图 + 合并后的 ops。
- 超过 10,000 条待处理操作 → 一次 `[["r", view]]` 整体替换。

### 流式与持久化的差距

- 流式文本/工具输出每 ~100ms 提交一次，watch 立刻看到。
- 存储延迟合并，最晚 `progress.persistWithinMs`（默认 1s）。
- 崩溃最多丢约 1 秒；流在第一秒崩可能连 aborted entry 都没有，那次 usage 也不记录。

所以：**UI 内容不能当审计依据。** 审计读存储或 `observeCommits`。

### watch 与 observer

- `watch`：异步、可以 await，给 UI。
- `observeConversation` / `observeTaskGraph` / `observeDoc`：**同步、不可 await、不可抛**，给必须和内存同步变化的适配器。`advance` 里做慢活会拖慢每一次提交。

---

## 8. 排障顺序

| 症状 | 先看 |
|---|---|
| 模型说没有某个工具 | `root.agent()` 的 `tools` / `modelTools` / `callable` |
| 会话一直不空闲 | `watchTaskGraph`、`pi.live.run`、`run.afterRun` |
| 任务卡住 | `harness.inspect()`（blocked 原因）、`onReport` 的 `task_outdated` |
| run 失败 | `pi.live.runFailure`（reason/detail） |
| 成本异常 | `pi.usage`、`maxTurns`、section 长度、压缩频率 |
| 压缩报错 | `pi.live.compactionFailure`、detail 里的 `Compaction failed:` |
| 崩溃循环 | `onReport` 的 `task_faulted` / `task_interrupted`、`restarts` |
| UI 状态不对 | watch 窗口、`ops` 是否漏、deferred 是否未落盘 |

`onReport` 的 `kind` 决定动作：

- `storage_failed` → 重开进程。
- `task_faulted` → 告警（真 bug）。
- `task_interrupted` → 统计环境稳定性。
- `extension_error` / `host_error` → 修代码。
- `task_outdated` → 部署问题（扩展没装/版本不匹配）。

---

## 9. 设计后果

1. **document 不是免费的**：每次写入都是操作；高频文档要给快照周期。
2. **deferred 只适合可丢的进度**；账本必须立即落盘。
3. **写不确定就停**：存储错误让整个 Harness 结束，而不是带着怀疑继续。
4. **code mode 的恢复依赖确定性**：外部输入不走工具，就可能拒绝恢复。
5. **UI 与审计是两份真相**：视图含未落盘的流式，存储只含已落盘的。
6. **watch 不是事件日志**：慢回调会折叠多次提交。

---

## 10. 自检

1. 一个文档每次流式输出都 push，`checkpointWhen: () => false`。跑了一万次后读它会怎样？怎么改？
2. 你把"剩余配额"存在 deferred 文档里，用它决定是否调用付费工具。崩溃后会发生什么？应该怎么存？
3. `snapshot()` 抛 `StorageRequestError` 和 `commit()` 抛 `StorageRequestError`，后果有什么不同？
4. 脚本里 `await tools.a()` 成功、已 journal，然后崩溃。重启后 `a` 会再执行吗？哪一层仍可能导致重复？
5. UI 只渲染 `watch.value.entries`，用户往上滚看不到历史。为什么？正确做法？

答案：[2-self-checks.md](../3-appendix/2-self-checks.md#5-运行时)。

---

## 11. 相关

- 上一篇：[4-orchestration.md](4-orchestration.md)
- 架构篇：[durable vs Pi](../2-architecture/1-durable-vs-pi.md)
- 术语：[1-glossary.md](../3-appendix/1-glossary.md)
- 原文：Your Own State、Usage and Cost、Storage、Errors、Code Mode、Watching a Conversation
- 对应示例：`18-json`、`20-late-join`、`24-compaction`、`31-transcript`、`35-durable-on-the-store`
