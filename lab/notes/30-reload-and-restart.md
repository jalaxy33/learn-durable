# 热重载与重启：代码换，状态不换

运行中的调用用**它启动时的那份代码**跑完；之后的新调用用新代码。重启之后会话仍然记得自己要哪些扩展，因为存的是**名字**，不是代码。

## 扩展的身份是名字

```ts
function loadVersioned(version: string) {
  return defineExtension({ name: "versioned", tools: [ defineTool({ name: "version", … }) ] });
}
```

- `registry.install(loadVersioned("v2"))` 用同名扩展**替换**旧的（`install` 先移除同名再装）。
- 会话里选中的扩展也按名字存（`agent.extensions` 里给的是对象，落盘的只有名字）。所以“代码从磁盘重新加载”这件事对会话完全透明。

实测三条：

```
call running during the reload: v1     ← 进行中的调用用旧代码跑完
next call: v2                          ← 之后的新调用用新代码
after restart, before install: []      ← 新进程还没装，工具解析为空
after install: [ 'version' ]           ← 装上 v3，存储的选择立刻绑定到新代码
```

## 为什么运行中的调用不受影响

工具任务在**阶段开始时**解析工具，用的是那个阶段的 registry 快照（快照每个阶段边界刷新一次）。所以：

- 调用已经在执行 → 用旧代码跑完；
- 下一次调用 / 下一个阶段 → 用新代码。

这就是“热重载”在 durable 里的准确语义：**不是热替换正在跑的函数**，而是“快照切换发生在阶段边界”。

## 重启后会发生什么

新进程打开同一份存储：

- 会话仍然选中 `versioned`（名字在 `pi.agent` 里）；
- 但新进程的 registry 是空的 → `root.agent(context).tools` 是 `[]`，模型没有工具可用；
- `registry.install(loadVersioned("v3"))` 之后立刻恢复，**不需要改会话**。

所以部署流程是：换代码 → 重启 → 装扩展（通常在同一处启动代码里）→ 会话照旧工作。**唯一要保住的是扩展名**。

## 静默降级的代价

`install()` 没有“必须存在”的校验，缺失就是解析不到。带来的现实问题：

- 改名 = 悄悄丢掉这个扩展的段落和工具，模型行为变了但不报错；
- 版本升级如果改了工具参数 schema，老调用重跑时可能校验失败（`invalid_arguments`）；
- 任务定义改名更严重：任务会 `blocked: missing_task`，只能中止（记 `orphaned`）。

实践建议：扩展名当成 API 版本名对待，改名时同步迁移会话的 `pi.agent`（`configure({ extensions: … })` 重新选）。

## 这个示例顺带演示的两件事

1. **registry 是可变的**：同一个 Harness 生命周期里可以反复 `install`，不需要重开。
2. **注册表变化会重新触发闸门**：44 的审批闸在“每次唤醒、每次 registry 发布”时都重跑 `call` 阶段——所以热重载不只影响新调用，也影响停着的闸门判断。

## 类型与语法

- `ReturnType<typeof createRegistry>`：不想写 Registry 具体类型时，从工厂函数反推。
- `let harness` / `let root` 允许重新赋值，模拟“第二个进程”。
- `let started = (): void => {}` + `new Promise<void>((resolve) => { started = resolve; })`：把“工具开始执行”变成可 await 的事件，从而在**调用进行中**做重载。
- `gate = new Promise((resolve) => { release = resolve; });`：让工具卡在 `await gate`，直到外部放行。
- `(await root.agent(context)).tools.map((tool) => tool.name)`：读解析后的 agent，看实际有哪些工具。
