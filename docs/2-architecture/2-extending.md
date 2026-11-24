# 2. 扩展：Pi 的插件系统，以及如何在 durable 上复刻

> Pi 之所以"大多数扩展不用改源码"，是因为它把应用里可能需要改变的地方都做成了事件和注册点，并让扩展以完整模块跑在同一个进程里。durable 能复刻这套形态，但它只提供"运行时下半身"，上半身要你自己设计。

版本：Pi **1.6.0**；pi-durable **v1.6.0**。

## 你会学到

- Pi 插件系统的六个设计决定
- 事件、注册、组合规则如何让扩展不用改核心
- 为什么 Pi 能把"几乎所有缝"开出来，而 durable 不能
- 在 durable 上做 PluginContext、事件桥、命令/UI、加载器、热替换
- 三档实现的工作量与代价

---

## 1. Pi 的六个设计决定

```text
┌─────────────────────────────────────────────┐
│ Pi 核心（宿主）                              │
│  - agent 循环 / 会话 / 压缩                   │
│  - 事件总线 + 服务对象                        │
│  - TUI 渲染骨架                              │
└───────────────┬─────────────────────────────┘
                │ 加载（jiti，直接跑 TS）
    ┌───────────┴───────────┐
    │ 扩展 A                 │ 扩展 B
    │ 订阅事件 / 注册工具     │ 注册 provider
    └───────────────────────┘
```

| 决定 | 效果 |
|---|---|
| 核心是宿主，不是一堆硬编码功能 | 核心只负责机制，策略交给扩展 |
| 生命周期有名字 | 每个需要改变的时刻都是事件 |
| 服务对象 `ctx` | UI、session、settings、models 都通过稳定接口访问 |
| 注册而不是打补丁 | 工具、命令、provider、渲染器都是注册 |
| 模块直接加载 | jiti 跑 TS，不用预编译 |
| 资源也是扩展 | skills、prompts、themes 可以零代码 |

---

## 2. 六种扩展方式

### ① 观察

```typescript
pi.on("turn_end", async (event, ctx) => {
  ctx.ui.notify("turn done");
});
```

日志、指标、通知、外部同步。

### ② 变换

```typescript
pi.on("context", async (event) => ({ messages: prune(event.messages) }));
```

改上下文、注入环境、修补参数。

### ③ 拦截

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Dangerous", "Allow rm -rf?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});
```

权限、审批、保护路径、取消危险操作。

### ④ 注册

```typescript
pi.registerTool({ name: "deploy", parameters, async execute(...) { ... } });
pi.registerCommand("deploy", { handler: async (args, ctx) => { ... } });
pi.registerProvider("local-openai", { baseUrl, apiKey, models: [...] });
pi.registerMcpServer("github", { ... });
pi.registerToolRenderer((name, next) => name === "deploy" ? myRenderer : next());
```

新工具、命令、provider、MCP、渲染。

### ⑤ 非代码资源

```text
my-package/
├── skills/pdf-tools/SKILL.md
├── prompts/review.md
├── themes/dark.json
└── extensions/index.ts   # 只有需要代码时才写
```

### ⑥ 打包

```bash
pi install npm:@example/pi-tools@1.0.0
pi install git:github.com/example/pi-tools@v1
pi -e ./local-extension.ts
```

---

## 3. 生命周期与组合规则

Pi 的事件覆盖：

```text
input → before_agent_start → agent_start
  → turn_start
      请求：context / context_with_system / before_provider_*
      工具：tool_execution_start / tool_call / tool_result / tool_execution_end
  → turn_end
  → agent_end → agent_before_settle → agent_settled
会话：session_start / session_before_switch / session_before_fork
      session_before_compact / session_before_tree / session_shutdown
其他：model_select / thinking_level_select / user_bash / ui_prompt_*
```

组合规则（写进文档，不靠猜）：

| 模式 | 行为 |
|---|---|
| Notification | 返回值忽略 |
| In-place mutation | 后面的 handler 看到前面的修改 |
| Chained transformation | 后面的 handler 收到前面返回的值 |
| Gate | 一个 block/cancel 短路 |
| Last override | 最后一个动作生效 |

顺序：**扩展加载顺序 → 扩展内注册顺序**。

没有这套契约，扩展会互相打架，用户只能改源码来保证顺序。

---

## 4. 加载、热替换、信任

- **jiti** 直接加载 TS。
- 自动发现：`~/.pi/agent/extensions/*.ts`、`.pi/extensions/...`（项目信任后）、`settings.json` 的 `packages`/`extensions`、`builtin:<name>`。
- 异步工厂会被 `await`，所以"启动时拉远程模型列表"能在 `session_start` 前完成。
- `/reload` 走 `session_shutdown` → 重建运行时 → `session_start(reason: "reload")`。
- 项目扩展要 **trust**；扩展跑在进程里，拥有完整 OS 权限。

> 这是"扩展是应用的一部分，而不是补丁"的工程体现：加载、卸载、重载都是一等公民。

---

## 5. 为什么这能覆盖"绝大多数"

因为大多数需求是**在已有缝上做策略**，而不是**改机制**：

| 需求 | 机制 |
|---|---|
| 加工具 | `registerTool` |
| 加命令/快捷键 | `registerCommand` / `registerShortcut` |
| 改模型请求 | `before_provider_request` |
| 加 provider | `registerProvider` |
| 拦危险命令 | `tool_call` + block |
| 改压缩 | `session_before_compact` |
| 改展示 | `tool_result` / `registerToolRenderer` |
| 记住状态 | `appendEntry` + `getBranch` |
| 加工作流说明 | `SKILL.md` |
| 换主题 | `themes/*.json` |

甚至 `codemode`、`tool_search` 也是"内置扩展"（`builtin:`），默认关闭、按需启用。这是最强的 dogfooding 证据。

### 什么时候仍要改源码

| 情况 | 原因 |
|---|---|
| 新增一个不存在的生命周期时刻 | 事件没发，扩展无从挂钩 |
| 改 agent 循环本身 | 属于机制，不是缝 |
| 改会话树持久化格式 | 核心数据结构 |
| 新增 `ctx.ui` 没有的 UI 原语 | 服务没提供 |
| 修核心 bug/性能 | 不是扩展能做的 |
| 换一套执行语义（如 durable） | 换底盘，不是加扩展 |

> 边界：**Pi 暴露策略，不暴露机制。** 能表达成"某时刻做某事" → 扩展够；要换时刻/换调度 → 改核心或换框架。

---

## 6. 在 durable 上复刻

### 先分清两层

```text
durable 给：插件运行时（安装、钩子、状态、持久化、生命周期）
你要造：插件 API（插件能看见什么、能注册什么、在哪些时刻被调用）
```

durable 已有的：

- `defineExtension` / `registry.install` / 同名热替换
- `hooks`（tool/generation/compaction 阶段）
- `defineDoc`（session/conversation/task 作用域）
- `defineSignal` + `sleep`
- `watch` / `observe*`（UI 数据）
- `onReport` 的扩展归属

缺的：应用事件、命令、UI/渲染器、发现/版本/信任。

### 6.1 定义 `PluginContext`

不要让插件作者直接写 `defineExtension`；给他更宽的入口：

```typescript
export interface PluginContext {
  readonly apiVersion: 1;
  readonly name: string;

  tools:    { register(tool: ToolRegistration): void };
  sections: { register(section: Section): void };
  hooks:    { register(hook: AnyHook): void };
  wraps:    { register(wrap: AnyWrap): void };
  tasks:    { register(task: TaskDefinition): void };

  docs:  { define<T>(def: DocDefinition<T>): DocToken<T> };
  state: { get<T>(doc, conversationId): Promise<T>; update<T>(doc, conversationId, fn): Promise<void> };

  commands: { register(cmd: Command): void };
  ui:       { toolRenderer(name, spec): void; panel(p): void; notify(msg): void };
  events:   { on(event: string, handler: Handler): void };
  signals:  { define(sig): void; send(...): Promise<SignalResult> };

  log: Logger;
}
```

插件：

```typescript
export default definePlugin({
  name: "acme.crm",
  apiVersion: 1,
  setup(api) {
    api.tools.register(lookupCustomer);
    api.sections.register(section("crm", () => "Customer data comes from the CRM."));
    api.commands.register({ name: "crm:sync", handler: async (ctx) => { ... } });
    api.ui.toolRenderer("lookup_customer", { kind: "component", id: "crm.customer-card" });
    api.events.on("run.ended", async (e) => { ... });
  },
});
```

### 6.2 用 recorder 汇总成一个 durable extension

插件不直接调 `registry.install`；host 收集贡献：

```typescript
async function loadPlugin(mod: PluginModule) {
  const rec = createRecorder();
  const api = makeApi(rec, mod.name);
  await mod.setup(api);

  const ext = defineExtension({
    name: `plugin:${mod.name}`,
    tools: rec.tools,
    sections: rec.sections,
    hooks: rec.hooks,
    wraps: rec.wraps,
    tasks: rec.tasks,
  });
  registry.install(ext);
  return { mod, ext, rec };
}
```

白拿 durable 的四件事：同名热替换、卸载、按会话选择（`configure({ extensions })`）、错误归属（`onReport.extension`）。

### 6.3 应用事件总线

durable 的钩子只覆盖 task 阶段；应用还有自己的时刻：

```text
conversation.created / opened / forked
run.started / ended / failed
turn.started / ended
tool.before / after
message.added
approval.requested / resolved
client.connected / disconnected
command.invoked
webhook.received
```

host 在关键位置 emit；桥接 durable 钩子：

```typescript
registry.install(defineExtension({
  name: "host:events",
  hooks: [
    hook(ToolTask, {
      beforeTool: async (call, api, ctx) => bus.emit("tool.before", { call, api }),
      afterTool: async (result, api, ctx) => {
        await bus.emit("tool.after", { result, api });
        return result;
      },
    }),
    hook(GenerationTask, {
      afterRun: async (run, api, ctx) => { await bus.emit("run.ended", { run }); },
    }),
  ],
}));
```

组合规则照抄 Pi 的五种模式；顺序写死为"插件加载顺序 → 插件内注册顺序"。

### 6.4 命令与 UI

服务端容易：

```typescript
interface CommandRegistry {
  register(cmd: { name: string; description: string; handler: (ctx) => Promise<void> }): void;
  list(): CommandInfo[];
  run(name: string, args: string, ctx): Promise<void>;
}
```

渲染三条路线：

| 路线 | 表达力 | 安全 |
|---|---|---|
| 声明式（JSON schema → 通用渲染） | 有限 | 高 |
| 客户端插件（ESM component） | 强 | 需要沙箱/版本 |
| 服务端渲染（HTML/ANSI） | 中 | 中 |

### 6.5 发现、版本、信任

- 配置里列 `npm:` / `git:` / 本地路径。
- 读 `package.json` 的插件清单，检查 `apiVersion`。
- 动态 `import()`；Worker 部署不能运行时装，必须构建时打包。
- 同进程 = 全权限；只装可信来源，或上进程隔离（VS Code 式 extension host）。

### 6.6 状态与热替换

- 插件状态走 `defineDoc`，`kind` 加插件命名空间。
- 卸载不删数据；重装还能读。
- `registry.install` 同名替换；正在跑的 phase 用旧代码，下一个 phase 用新代码。
- UI 侧要重新注册 renderer，或带版本号强制刷新。

---

## 7. 三档实现

| 档 | 内容 | 工作量 |
|---|---|---|
| L1 | 只用 durable 扩展（tools/sections/hooks/tasks） | 几乎零 host 代码 |
| L2 | `PluginContext` + 事件 + 命令/UI + 加载/热替换 | 1–2 周 |
| L3 | 进程隔离 + RPC + 权限声明（不可信第三方） | 数月 |

大多数人需要 L2。

---

## 8. 坑

| 坑 | 说明 |
|---|---|
| API 没版本 | 第一次改内部结构就破坏所有插件 |
| UI 表达力 | 服务端容易，客户端难；先做声明式 |
| 部署绑定 | Workers 不能运行时装插件 |
| 顺序/冲突 | 同名工具、多个 gate、多个 renderer 要写死规则 |
| 信任 | 同进程 = 全权限；要么只装可信，要么隔离 |
| 状态迁移 | 插件升级改文档结构；`version` + migrate |
| 热重载的客户端 | 服务端换了，浏览器旧 renderer 还在 |

---

## 9. 结论

> **Pi 的插件系统是"应用级插件"：应用是它的，所以它能把所有缝开出来。**
> **durable 的扩展系统是"运行时装配"：UI/会话/交互不是它的，它只开 task 层的缝。**
>
> 你能在 durable 上做出 Pi 式插件系统，但插件 API、事件、命令/UI、加载器要自己设计。durable 提供的是插件系统的下半身。

---

## 10. 相关

- [1-durable-vs-pi.md](1-durable-vs-pi.md)
- [3-deployment.md](3-deployment.md)
- Pi 文档：`docs/extensions.md`、`docs/packages.md`、`docs/skills.md`
- durable：[2-capabilities.md](../1-core/2-capabilities.md)
