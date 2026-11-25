# 真模型：provider、流式进度、看文档

和假模型的差别只有两处：模型换成一个真 provider；回答是流式产生的，过程通过会话的 `pi.live` 文档暴露出来。

## 模型从哪来

`Models` 是一个目录，不负责网络；provider 才是。空目录里注册一个 provider，之后每次请求按 `{ provider, modelId }` 在目录里查：

```ts
const models = createModels();
models.setProvider(deepseekProvider());
```

`Harness.open(..., { models })` 收的可以是 `Models`，也可以是返回 `Models` 的函数——每次使用都重新取，所以宿主可以中途换配置而不必重开 Harness。Harness 从不绕过这个目录直接找 provider。

模型条目自带请求细节：`api`（如 `openai-completions`）、`baseUrl`、`contextWindow`、`maxTokens`、`cost`、`input` 能力、`compat`（字段名、是否支持某类消息）、`thinkingLevelMap`。所以换模型只要换 `modelId`，不用改请求代码。

## 认证

`deepseekProvider()` 的 auth 是环境变量读取：用的时候才读 `DEEPSEEK_API_KEY`，不是一个在构造时拷贝进去的字符串。密钥缺失不会在 `Harness.open()` 时抛错，而是让这次运行失败——`wait()` 拿到的记录是 `unanswered`，`pi.live.runFailure` 里带 `reason`（如 `model_error`、`no_model`）和 `detail`。

脚本里习惯先判断，没 key 就跳过，免得跑出一堆失败记录。

## pi.live：过程文档

`pi.live` 是**会话作用域**的文档（`LiveDoc: ConversationDocToken<LiveState>`），生成任务在里面写：

- `run`：这次运行的控制信息（任务 id、输入、已用轮数、是否在等 `afterRun`/`onYield` 任务）。
- `generation`：当前尝试的展示数据——`attempt`、节流后的部分回答 `message`、重试退避 `retry`、provider 侧延迟响应 `deferred`。
- `tools` / `nestedTools`：当前工具轮与嵌套调用。
- `runFailure`：最近一次失败的原因，运行结束后仍保留，给客户端显示。

**部分回答是节流写入的**：不是每个 token 一次提交，而是按时间窗口提交一次累积快照，并且是 **deferred 持久化**——内存里立刻对 watcher 可见，落到存储则等到下一次读写 `pi.live` 的提交，或 `settings.progress.persistWithinMs` 到时。

所以进度有两层含义：

- 从 watch 看到的永远是**已提交的值**，token 级别的中间态看不到；
- 进程崩在窗口中间，最后那段缓存在内存里的部分会丢。

## 看文档

```ts
const watch = await harness.watchDoc(LiveDoc, conversationId, ctx); // 可能 undefined
watch.start(async (call, context) => { ... });
await watch.stop();
```

- `watchDoc` 不创建文档：文档还不存在时返回 `undefined`（所以示例写了 `!`）。
- 回调参数是 `{ kind: "value", value, ops, retired }` 或 `{ kind: "failed", error }`；`failed` 不结束 watch，下个值会重新给全量。
- 回调串行执行：一次只跑一个，期间的多次变化折叠进下一次调用。回调要快，慢回调只是把后续调用往后压，不会丢。
- `stop()` 幂等，返回终止原因（`stopped` / `aborted` / `ended` / `listener_error` / `failed`）。

`pi.live` 是内存里的文档，Watcher 拿到的是**整个文档的快照**，不是增量文本。要打印“新增的部分”，自己记住已经打印到哪。

## 进度不是答案

`wait()` 结算后仍然要读回答条目：

- 最后一次节流窗口可能没提交——它缓存在内存里，等着下一个提交带出去，而运行已经结束了；
- 崩溃恢复时，部分回答会被 `convertPartial` 转成正式的 assistant 条目，进度值本身不作数。

所以客户端正确的收尾是：先按进度打印，结算后用条目的完整文本补齐差额（示例里的 `printText` 用“前缀匹配 + 截掉已打印长度”做这件事）。

## 类型

- `generation.message` 是 `JsonRepresentation<AssistantMessage>`：文档里只能放 JSON，所以消息被判成 JSON 表示，数值、嵌套结构都在，但类型是“可以用 JSON 表达的”。
- `printText` 用前缀校验而不是简单拼接：`text.length <= printed.length || !text.startsWith(printed)` 就忽略。快照可能重复、可能相等，但不会回退长度——真回退了说明状态被替换，直接跳过比拼出乱码好。
- `LiveState` 的字段几乎都是可选的（`run?`、`generation?`、`runFailure?`），所以读取链一路 `?.`。

## 语法

- **没有顶层 `return`**：ESM 模块顶层不能提前返回，所以“没 key 就跳过”只能写成 `if (...) { ... } else { ... }`，或者 `process.exit()`。示例选了 if/else。
- **非空断言 `!`**：`(await harness.watchDoc(...))!`。用在这里是因为“文档一定存在”是调用方知道的、类型表达不了的事实；能 `?.` 的地方别用 `!`。
- **`let` 闭包状态**：`printed` 在外层，回调里累加。回调是异步且串行的，所以不需要锁。
- **`process.stdout.write`**：不带换行，用来逐字输出；结尾自己补 `\n`。
- **`call.kind !== "value"` 提前返回**：先排除 `failed` 分支，后面就不用再判。
- **`find` + 再判类型**：`content.find((c) => c.type === "text")` 返回的是联合成员，再 `block?.type === "text"` 才能取 `text`。
- **`models.getModel(provider, modelId)`**：目录查询，调试“模型 id 到底存不存在”时直接用。
