# 2. 能力：扩展、工具与可见性

> durable 的核心不写死任何能力。扩展声明"我带什么"，registry 在运行时解析；每次工具调用又是一个持久 task。于是"加能力"和"能力可恢复"是同一套机制。

版本：pi-durable **v1.6.0**。

## 你会学到

- 为什么扩展是声明式的，而不是带生命周期的插件类
- 为什么会话存扩展**名字**，以及这带来的热替换与静默降级
- 为什么一次工具调用是 task，而不是普通函数调用
- 三个输出通道分别在解决什么问题
- `replay`、嵌套调用、park 如何把"等待"移出进程
- `callers` / `modelTools` / deferred 为什么是三层不同的东西

---

## 1. 设计问题

整篇围绕三个问题：

1. **加一个能力，为什么不该改核心？**
2. **工具崩了、等外部事件时，状态放哪？**
3. **模型"看见"的工具和"能调"的工具，为什么不是一回事？**

先看三种常见的坏做法：

| 坏做法 | 问题 |
|---|---|
| fork 核心，在 agent 循环里加分支 | 每次加能力都要合并上游；升级即冲突 |
| 全局单例 + 运行时随意注册 | 多会话互相污染；重启/热替换语义不清 |
| 把工具写死进循环的 `switch` | 工具和调度耦合；无法按会话开关 |

durable 的答案可以压成一句：

> **能力 = 声明式扩展 + 进程级 registry + 名字持久化 + 工具即 task。**

---

## 2. Extension：声明式能力包

```typescript
const Coding = defineExtension({
  name: "coding",
  sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
  hooks: [hook(ToolTask, { beforeTool: (call) => isDangerous(call) ? { block: "Needs approval" } : undefined })],
  tools: [read, write, edit, bash],
  wraps: [wrapTool(createBashTool(), (bash) => ({ ...bash, execute: timed(bash.execute) }))],
  tasks: [RunTests],
});
```

五样东西：

| 字段 | 提供什么 |
|---|---|
| `tools` | 模型/程序可调用的能力 |
| `sections` | 系统提示词片段 |
| `hooks` | 在内置 task 阶段插入逻辑 |
| `wraps` | 按名字装饰工具或 section |
| `tasks` | 自己的持久状态机 |

### 为什么没有生命周期

主流插件系统通常有 `setup()` / `dispose()`、能持有状态、能注册事件监听。durable 故意不给：

- **热替换简单**：`install` 同名扩展就是换一份声明，没有"旧实例还在跑定时器"。
- **没有初始化顺序问题**：不需要 `await extension.setup()`，也不用处理依赖。
- **多会话安全**：一个扩展对象被所有会话共享，天然要求无状态。
- **可移植**：同一套声明可以跑在 Node、Cloudflare、浏览器。

代价：

- 扩展**不能**缓存"每个会话的临时状态"；需要状态就写 document。
- 没有"加载完成"钩子；异步准备放在 `env` 或首次调用里。
- 错误处理是"报告并跳过"（`extension_error`），不会阻止调度。

> 对比 Pi：Pi 的扩展是进程内 TS 模块，有生命周期、能操作 UI、全权限。durable 的扩展是声明式五件套，因为 durable 只拥有运行时，不拥有应用。详见 `../2-architecture/2-extending.md`。

---

## 3. Registry：进程装配表

```text
进程 A: registry = [CodingTools, Coding]     会话里存: ["coding-tools", "coding"]
进程 B: registry = [CodingTools]             会话里存: ["coding-tools", "coding"]
                                              → "coding" 解析不到，静默少一个能力
```

核心不变量：

> **registry 不存储；会话存名字；每次使用时解析。**

这带来一组可预期的行为：

| 行为 | 后果 |
|---|---|
| `install` 同名扩展 | 原地替换；已开始的 phase 用旧代码，下一个 phase 用新代码 |
| `uninstall` | 选中它的会话"少一块"，**不报错** |
| 进程重启 | 必须重新 `install`，否则扩展的 task 变 blocked |
| 改名 | 旧会话解析不到；能力静默消失 |
| 安装顺序 | 同名工具后者覆盖前者；section 顺序影响 prompt 前缀 |
| 默认全选 | 装了就所有会话可用；用 `settings.extensions` 或 `configure` 收窄 |

### 设计取舍

| 选择 | 优点 | 代价 |
|---|---|---|
| 存名字，不存对象 | 代码会变，数据能活；热替换干净 | 解析失败是静默降级 |
| 进程级 registry | 多会话共享、可热替换 | 无法跨进程共享；重启要重装 |
| 安装顺序决定覆盖 | 简单、可预测 | 不能按工具单独选择；同名冲突只能靠拆扩展 |

> 一句话：**存事实和名字，运行时再解析成行为。** 代价是解析可能失败，而且失败是安静的——你必须自己监控能力面。

---

## 4. Tool：能力边界，也是持久化边界

每次工具调用是**独立的 durable task**：

```text
模型请求工具
  → 先提交调用意图（arguments、replay 策略）
  → 执行 execute()
  → 结果写成 pi.tool-result
```

为什么不做成普通函数调用：

| 需求 | 普通函数 | durable task |
|---|---|---|
| 崩溃后继续 | 结果丢失 | 按 replay 策略重跑或给 `interrupted` |
| 单独 abort | 靠外层 | 有自己的 abort 和 owner |
| 审计 | 日志 | task 记录 + entry |
| 等待 | 占着进程 | park |
| 并行/嵌套 | 自己做 | 独立 task，有 key 和 owner |

代价：

- 每次调用多一条 task 记录，简单工具会觉得"重"。
- 必须想清楚 `replay` 策略和副作用幂等。
- 工具的输出上限、截断、spill 都要自己处理。

> 设计的根：**phase 是重试单位**。工具的执行体就是 phase，所以它必须能从头重跑，或者明确声明不能。

---

## 5. 三个输出通道

结果不是一个字符串，而是三条通道：

| 通道 | 给谁 | 存 transcript | 典型内容 |
|---|---|---|---|
| `output` | 模型 | ✅ | 短文本、图片 |
| `structuredOutput` | 调用它的程序 | ❌ | `{ status, total }` |
| `details` | UI | ✅ | 路径、URL、diff、耗时 |

```typescript
return {
  output: [{ type: "text", text: `Order ${id}: shipped, $${total}.` }], // 模型读
  structuredOutput: { status: "shipped", total },                        // 程序读
  details: { orderId: id, url: `/orders/${id}` },                        // UI 读
};
```

### 为什么分开

三个消费者的需求冲突：

- 模型要**短、可读**（token 贵）。
- 程序要**精确、可组合**（不要正则解析自然语言）。
- UI 要**富信息**，而且不能污染模型上下文。

混成一个字符串，只能二选一：要么模型吃 JSON，要么程序解析文案。

### 代价

- `structuredOutput` **不存 transcript**：历史里查不到，需要留痕就放 `details` 或 document。
- 声明了 schema 就必须返回匹配值，否则嵌套调用变 `invalid_structured_output`。
- `afterTool` 脱敏时 **`output` 和 `structuredOutput` 都要脱**。

---

## 6. 生命周期：replay、嵌套、park

### 6.1 `replay` 是承诺，不是开关

| 声明 | 崩溃后 | 模型看到 | 外部世界 |
|---|---|---|---|
| 默认 | 不重跑 | `interrupted` 错误结果 | 可能做了一半 |
| `"safe"` | 从 `execute()` 第一行重跑 | 正常结果（如果这次成功） | 可能执行两次 |

关键：**默认不重跑 ≠ 不会重复**。默认时模型收到 `interrupted`，很可能自己再调一次。所以：

> 只要工具有外部副作用，不管 `replay` 是什么，都需要幂等键。

`replay: "safe"` 是"我保证重复执行没事"，框架不会验证。

### 6.2 嵌套调用：工具调工具

```typescript
const run = await api.executeTool("bash", { command: "npm test" }, context, { progress: false });
const exitCode = (run.structuredOutput as { exitCode: number } | undefined)?.exitCode;
```

- 它是**另一个 tool task**，owner 是调用者。
- 有自己的 schema 校验、hooks、输出限制、replay 策略。
- 返回 `structuredOutput` / `details` / `diagnostics`，**没有 `output`**（那是给模型的）。
- 默认按"第几个调用"做 key；崩溃重跑时按同样顺序接回原来的嵌套调用。

设计含义：**组合性来自 task，不来自函数调用栈**。代价是幂等要逐层保证，不能靠外层 safe 兜底。

### 6.3 Park：把等待移出进程

工具不返回结果，而是返回"我要等"：

```typescript
return { sleep: { signals: [CiResult.key("done")], until: api.now() + 2 * HOUR, checkpoint: { buildId } } };
```

- 进程立刻释放；task 状态是 `sleeping`。
- 醒来后 `execute()` **从第一行重跑**，`api.wake` 说明原因，`api.checkpoint` 带回上次存的东西。
- 所以 `execute()` 要写成三段式：**先读已到的结果 → 再看 checkpoint → 最后才做新工作并 park**。

| 你要等的东西 | 用什么 |
|---|---|
| 毫秒级、必成功 | 普通 `await` |
| 分钟~小时级 | park `sleep` |
| 外部事件（webhook、审批） | park `sleep` + signal |
| 自己启动的子任务 | park `wait` |

判据：**"进程消失一小时，这件事还应不应该继续？"** 应该 → park。

实测（`40` / `41`）：

```text
40: builds after the first attempt: [ 'build-1' ]
    builds after the rerun:        [ 'build-1' ]      ← memo 让重跑不重复触发
    parked slot: status sleeping
41: asleep until 1s / 3s / 7s                         ← 退避轮询
```

---

## 7. 可见性治理：三层不同的东西

| 机制 | 回答的问题 | 作用范围 |
|---|---|---|
| `tools`（agent） | 哪些工具启用了？ | 整个会话 |
| `modelTools`（agent） | 其中哪些给模型**看**？ | 只收窄菜单 |
| `callers`（tool） | 这个工具允许**谁调**？ | 模型 / 工具 / 两者 |
| `deferred` + `tool_search` | 工具太多时怎么按需出现？ | 菜单加载策略 |

最重要的一条：

> **菜单不是权限。** `modelTools` 去掉 `bash`，模型看不见，但脚本/其他工具仍然能调。

要真正拦住，得用 `callers`、`beforeTool` 或 `env`（没有 shell 就没有 shell 能力）。

### 为什么需要分层

- **省 token**：每个工具的 name/description/schema 都进系统提示。
- **减少误选**：菜单越长，模型越容易挑错。
- **最小权限**：客服 agent 不该看见 `bash`。
- **强制流程**：只给一个入口工具，逼模型走设计好的路径。

代价：

- "可见"和"可执行"分离，排查时要分别看三个列表。
- 动态改菜单会写 system entry，破坏 prompt cache。
- deferred 依赖模型主动搜索，不是所有模型都擅长。

---

## 8. 配置也是能力的一部分

- **Agent 存名字**：模型、扩展、工具、指令、cwd。未设置的字段跟随 host；`null` 清回默认。
- **Settings 每次读、不存**：重试、超时、压缩阈值、进度频率。getter 让它热更新，代价是行为不可复现。
- **Sections 是位置性 system entry**：内容不变就不重写，provider 缓存才能命中。
- **易变内容不要放 section**：当前时间、未读数、实时价格会每轮打断缓存；放用户消息或工具结果。
- **请求在准备时固定**：模型、prompt、工具列表从下一次请求生效；工具调用和 hook 在 phase 开始时解析 agent。

---

## 9. 设计后果清单

写 agent 时会反复遇到的六件事：

1. **改扩展名 = 破坏旧会话**。改名要准备别名或迁移。
2. **卸载是静默的**。能力消失不报错；要靠 `root.agent()` 和 `onReport` 监控。
3. **同名工具后者赢**。要可切换，就放不同扩展里。
4. **hook 顺序决定谁能改参数**。gate 可能看到被前一个 hook 改写过的参数。
5. **重启必须重装扩展**，否则 task blocked。
6. **工具描述是搜索语料**，不只是给模型看的说明；`tool_search` 和脚本发现都靠它。

---

## 10. 自检

1. 为什么扩展不能持有会话状态？如果确实需要状态，应该放哪？
2. 什么情况下必须声明 `replay: "safe"`？什么情况下**不能**声明？
3. `modelTools` 去掉了 `bash`，模型还能执行 shell 吗？为什么？
4. 为什么 `output` / `structuredOutput` / `details` 要分三个通道？

答案：[2-self-checks.md](../3-appendix/2-self-checks.md#2-能力)。

---

## 11. 相关

- 上一篇：[1-foundations.md](1-foundations.md)
- 下一篇：[3-control.md](3-control.md)
- 术语：[1-glossary.md](../3-appendix/1-glossary.md)
- 原文：`upstream/pi-durable-README.v1.6.0.md` 的 Extensions、Tools、System Prompt、Per-Conversation Agent、Settings、Environment
- 对应示例：`16-coding-tools`、`25-coding-agent`、`29-tool-override`、`38-signals`、`40-tool-waits-for-webhook`、`47-fit-images`
