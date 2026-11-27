# registry reload：换代码、环绕工具、卸载

注册表以**扩展名**为索引。热重载就是“用同一个名字装一个新对象”，它在**一次发布里原地替换**——所以不会有“旧版本已经卸掉、新版本还没装上”的空窗期。

## 一次发布，原地替换

```ts
registry.install(defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files, faster")] }));
```

实测：

```
initial:      [ 'read: Read a file', 'grep: Search files' ]
after reload: [ 'read: Read a file', 'grep: Search files, faster' ]
```

只改了 `grep` 的描述，`read` 保持不变。注意的是**顺序不变**（原地替换，不是删掉再追加）：段落的渲染顺序、钩子的调用顺序都跟着不变。

运行中的任务不受影响：阶段开始时会拍一份注册表快照，**阶段边界**才刷新（30 里详细演示过）。

## 环绕工具（wrapTool）

```ts
const Audit = defineExtension({
  name: "audit",
  wraps: [wrapTool(read, (tool) => ({ ...tool, description: `${tool.description} (audited)` }))],
});
registry.install(Audit);
```

```
with audit:      [ 'read: Read a file (audited)', 'grep: Search files, faster' ]
after uninstall: [ 'read: Read a file', 'grep: Search files, faster' ]
```

三个要点：

- `wrapTool(read, fn)` 按**工具名**匹配，不是按对象身份。所以被环绕的工具换了一版代码，环绕照样生效。
- 环绕只在“安装了环绕扩展、且会话选中了它”的地方生效——这是 `wraps` 的语义（装饰，不是替换）。
- 包装器必须是**纯函数**：同样输入同样输出。它会在每次解析 agent 时跑。

`wrapSection` 是段落版的同一机制（14 的 `Terse` 用它改 preamble）。

## 卸载

`registry.uninstall(Audit)` 按名字移除。会话里对它的选择不会自动清掉——下次解析时“选中的扩展不存在”，它的贡献（环绕、工具、段落）就消失了，不报错。

这就是“静默降级”的另一面：卸载安全，但看不出少了什么。要确认模型到底有什么，读解析后的 agent：

```ts
const tools = async () => (await root.agent(context)).tools.map((t) => `${t.name}: ${t.description}`);
```

`root.agent(ctx)` 是唯一权威视图——它已经合成了“会话选择 + 安装的代码 + 全部环绕”。

## 和 30 的分工

| | 09 | 30 |
|---|---|---|
| 关注点 | 注册表 API：替换、环绕、卸载 | 时间维度：运行中重载、重启后重新安装 |
| 关键结论 | 一次发布、按名字匹配 | 阶段快照、状态里只存名字 |

两个合起来才是完整的热更新模型：**代码替换是原子的、按名字的；运行中的调用用旧快照跑完。**

## 类型与语法

- `wrapTool(read, fn)`：`read` 只用来取名字，`fn` 收 `Tool` 返回 `Tool`。
- `wraps: [...]` 是扩展字段，和 `tools` / `sections` / `tasks` / `hooks` 并列。
- `root.agent(context)` 返回解析后的 `Agent`，`tools` 是最终给模型的列表（`name` + `description` + schema）。
- `Promise` 链：`tools()` 是 `async`，因为 `agent()` 是异步的（要读 `pi.agent`）。
