# JSON 模式：两种消费视图的方式

同样的会话，客户端可以按两种粒度接收：**操作流（ops）**或者**状态快照（state）**。两者读的是同一个 `ConversationView`，只是一个给增量补丁，一个给可直接绘制的状态。

## 视图长什么样

```ts
type ConversationView = {
  conversation: ConversationRecord;
  entries: EntryRecord[];          // 窗口：默认最新 50，最多保留 100
  docs: Record<string, JsonValue>; // pi.agent / pi.live / pi.inbox / pi.provider / pi.usage
};
```

- `entries` 是**窗口**，不是全量历史。追加新条目会挤掉最老的（超过 100 条时）。要全量就用 `conversation.entries()` 分页。
- `docs` 是内置文档的快照，`pi.live` 在运行中每秒变化多次，`pi.usage` 随每次请求增长。

## ops 模式

```ts
print({ view: watch.value });                 // 第一帧：整个视图
watch.start(async (call) => {
  if (call.kind === "value") print({ ops: call.ops });
});
```

第一行给出视图本体，之后每一行是**自上一帧以来的操作**。操作是紧凑元组：

| op | 含义 |
|---|---|
| `["r", value]` | 整个视图被替换 |
| `["s", path, value]` | 在某路径上设值 |
| `["d", path]` | 删除某路径 |
| `["p", path, index, deleteCount, items]` | 数组 splice（追加、插入、删除） |
| `["a", path, text]` | 字符串追加 |
| `["t", path, length]` | 字符串截断到长度 |
| `["m", path, permutation]` | 数组重排：`new[i] = old[perm[i]]` |

实际一行看起来像：

```json
{"ops":[["s",["docs","pi.live","run","turns"],1],["s",["docs","pi.live","tools"],[...]]]}
```

客户端保留一份副本，按顺序应用这些操作就得到与服务端一致的视图。**bytes 最省，也最精确**——窗口挤出旧条目同样表达为 `p` 操作。代价是客户端要有一份可变副本和补丁逻辑。

## state 模式

```ts
let newest = watch.value.entries.at(-1)?.id ?? 0;
watch.start(async (call) => {
  const { value } = call;
  const entries = value.entries.filter((entry) => entry.id > newest);
  newest = value.entries.at(-1)?.id ?? newest;
  print({ ...(entries.length === 0 ? {} : { entries }), live: value.docs["pi.live"] });
});
```

每次回调给“**自上次以来新追加的条目** + 当前的 `pi.live`”。渲染器拿到就能画，不需要维护镜像。

用 `newest` 记水位线是因为回调给的是整个窗口，条目 id 单调递增，比 id 更简单可靠。

代价：每帧都带完整 `pi.live`（流式时它最大），流量比 ops 多得多。好处是逻辑简单，且**丢帧无害**——下一帧的 `live` 是完整值。

## 悬挂时机与折叠

- **在 `submit` 之前 `watch()`**，否则会漏掉开头几帧。`watch.value` 在 `start()` 之前就能读，是当前视图。
- 回调运行期间落下的多个提交会**折叠**：下一次回调给最新的值和这些提交的全部操作（同一个字符串的多次追加合并等）。积压超过 10,000 个操作时，改成一个 `[["r", view]]` 整体替换，避免无限排队。
- 回调是**串行**的：一次只跑一个。慢回调只是推迟后续调用，不丢数据。
- 结束前 `waitForIdle()`，再让出一次事件循环（`setTimeout(0)`），最后 `stop()`，这样最后一批折叠不会丢。

## 存储与模型

同一段代码跑在三种存储上，只是构造不同：

```ts
storage = await openNodeSqliteStorage(path);          // 文件
storage = await openNodeJsonlStorage(directory, ctx); // 目录
storage = new MemoryStorage();                        // 内存
```

模型同理：有 `OPENAI_API_KEY` 就用真 provider，否则用 `fauxProvider({ tokensPerSecond: 200 })` 模拟流式速度。示例里这两种切换都靠命令行参数和环境变量，没有别的分支。

## 这类输出的用途

每行一个 JSON 对象，就是 `pi --mode json` 的协议：TUI、Web 前端、日志收集器都按这个消费。要接自己的 UI，从这里开始——**先定 ops 还是 state**：

- 已经有自维护状态、要省流量、要严格同步 → ops。
- 每帧重绘、逻辑尽量简单 → state。
- 要翻历史 → 两条路都不够，得用 `entries()` 分页（客户端 transcript 的完整做法在 31）。

## 类型

- `root.watch(context)` 返回 `ConversationWatch`，即 `WatchHandle<ConversationView>`；`watch.value` 是同步可读的当前值。
- `call` 是标签联合，先判 `call.kind === "value"` 再取 `ops` / `value`。
- `entry.id` 是品牌数字，比较大小合法（`entry.id > newest`），窗口为空时 `at(-1)` 是 `undefined`，用 `?? 0` 兜底。
- 打印用 `unknown` 参数，不假设 JSON 结构。

## TS / JS 语法

- **`void` 丢弃返回值**：`const print = (value: unknown): void => void process.stdout.write(...)`，明确“这里不返回 write 的结果”。
- **参数手写解析**：`args.includes("--state")`、`args.indexOf("--storage")`、`args[storageIndex + 1]`；位置参数的判断要跳过 `--storage` 的值。
- **条件展开**：`{ ...(entries.length === 0 ? {} : { entries }), live }`，空数组时不输出这个字段。
- **`env: () => env`**：环境是固定实例时就返回同一个；要按会话目录变，才写成工厂。
- **stderr 放非 JSON 信息**：`console.error(...)` 打印存储路径，保持 stdout 只有协议数据。
- **`??` 给默认 prompt**：`args.find(...) ?? "What is in this directory?"`。
