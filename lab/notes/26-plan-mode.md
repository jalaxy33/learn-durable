# plan mode：用 `configure()` 切换工具集和提示词

“只读规划模式”没有专门的开关——它就是**改会话的 agent**：加一个扩展、把工具列表换成只读集合、再切回来。切换在模型眼里就是一条系统提示词变更。

## 三块东西

```ts
const PlanDoc = defineDoc<{ steps: string[] }>({ scope: "conversation", history: "rewindable", fork: "asOf", … });
const submitPlan = defineTool({ name: "submit_plan", …, execute: … });   // 写文档 + terminate
const Plan = defineExtension({
  name: "plan",
  tools: [submitPlan],
  sections: [section("plan_mode", () => "You are in plan mode. … Change nothing.")],
});
```

- **计划存在扩展自己的文档里**（10 的模式），所以切回普通模式之后计划还在，随时能读。
- `submit_plan` 返回 `control: { terminate: true }`：这一轮工具跑完就结束 run，模型不会再往下改代码。
- 段落是提示词层面的约束（“只读、先读代码、然后提交计划”）。

## 切换就是 configure

```ts
const enterPlanMode = { extensions: { add: [Plan] }, tools: [read, submitPlan] };
const leavePlanMode  = { extensions: null, tools: null };

await root.configure(enterPlanMode, context);
await root.configure(leavePlanMode, context);
```

- `extensions: { add: [Plan] }` 在宿主默认选择上追加；`null` = 清回宿主默认。
- `tools: [read, submitPlan]` 是**绝对列表**——plan 模式只提供这两个；`null` = 清回默认（全部）。
- 一次 `configure` 是一次提交，下一次请求立刻生效，不用重开会话。

实测工具集变化：

```
tools:            [ 'read', 'write', 'edit', 'bash' ]
plan mode tools:  [ 'read', 'submit_plan' ]
tools again:      [ 'read', 'write', 'edit', 'bash' ]
```

宿主配置里的 `settings: { extensions: [CodingTools] }` 是“默认选中谁”：`Plan` 安装在注册表里但默认不选，所以会话是**主动 opt-in** 进 plan 模式的。

## 模型看到了什么

切换在 transcript 里落成两条 `pi.system`（提示词补丁，14 的机制）：

```
{ sections: { plan_mode: "<plan_mode>…Change nothing.</plan_mode>" },
  added: [ 'read', 'submit_plan' ] }

{ sections: { plan_mode: null },               ← null 表示移除这一段
  added: [ 'write', 'edit', 'bash' ], removed: [ 'submit_plan' ] }
```

所以“模式切换”对模型来说不是隐形的：它看到段落出现、工具增删。这也是为什么 provider 的 prompt cache 只在小范围内失效——只有变化的部分被追加。

## 计划本身

```
plan: [ 'Read PORT from the environment', 'Default to 3000' ]
```

`submit_plan` 写进 `PlanDoc`，宿主用 `harness.snapshot(PlanDoc, root.id, ctx)` 读。`fork: "asOf"` 让分叉会话继承分叉点那一刻的计划（和 10 的 todo 一样）。

## 这套做法能推广到哪些“模式”

- 只读 / 可写
- 只给工具的子集（`modelTools` 还能进一步只让模型看到、但仍允许工具间调用）
- 换模型（`model`）、换 thinking level、换 cwd、加 `instructions`
- 加/减扩展（例如“审计模式”只加 wrap 扩展）

都是同一个入口：`configure(change, context)`，一次提交。

## 类型与语法

- `AgentChange` 的字段与 `root()` 的 `agent` 参数同形：`model`、`tools`、`modelTools`、`extensions`、`instructions`、`cwd`、`maxTurns`、`compaction`。
- `extensions: { add: [...] }` / `{ remove: [...] }` / 数组 / `null` 四种写法分别对应“加”“减”“精确指定”“清回默认”。
- `section` 的值在后续补丁里用 `null` 表示删除（`sections: { plan_mode: null }`）。
- `control: { terminate: true }` 是工具结果的控制字段：这一轮结束就收尾。
- `arr(str())` 声明字符串数组参数。
