# 工具覆盖与环绕：同名替换，按名字装饰

两个模式合起来用：**用同名工具替换内置的**（只对某些会话生效），再用 `wrapTool` **装饰最终胜出的那个**（不关心它是哪一版）。

## 同名即替换

```ts
const Venv = defineExtension({
  name: "venv",
  tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
});
```

工具按**名字**解析。`Venv` 提供的也叫 `bash`，所以在“选中顺序里排在 `CodingTools` 之后”的会话里，它**原地替换**了 `CodingTools` 的 bash——位置不变，只是实现换了。

顺序就是优先级：会话选中的扩展按顺序生效，后面的同名工具赢。宿主默认 `settings.extensions: [CodingTools, Timing]`；Python 会话用 `extensions: { add: [Venv] }` 追加到末尾，于是它的 bash 胜出。

## 环绕按名字匹配

```ts
const Timing = defineExtension({
  name: "timing",
  wraps: [wrapTool(createBashTool(), (bash) => ({ ...bash, execute: async (…) => { … } }))],
});
```

关键点：`wrapTool` 的第一个参数**只用来取名字**（这里随手造了个默认的 `createBashTool()`），不是“我要装饰这个对象”。所以：

- 装饰的是**当前胜出的** `bash`，无论是内置的还是 venv 的；
- 任何一版 bash 被 reload，环绕照样生效；
- 包装器不捕获 base 对象，也就不存在“持有旧实例”的问题。

包装器还必须**透传 park**：如果 base 的 `execute` 返回了 park，包装器要原样返回，不能自己构造 park（否则 `invalid_park`）。

## 实测

```
plain conversation:  venv:                                  ← 内置 bash，环境里没有 VIRTUAL_ENV
python conversation: venv: <project>/.venv                  ← venv bash 先 source 了 activate
timed bash calls: 2                                         ← 两次调用都被 timing 包到
```

三个结论都在里面：默认会话用内置 bash；加了 `Venv` 的会话用替换版；环绕对**两者都生效**（计数 2）。

## 什么时候用这套

- 给某个项目/租户换掉同名工具（沙箱化的 bash、带代理的 read、mock 的 write）。
- 给所有工具加横切逻辑：计时、审计、脱敏、限流（用 `wrapTool`，不要复制工具定义）。
- 灰度：同一份代码，不同会话选不同扩展。

不要用“改工具名”来实现变体——会话的选择、提示词里的工具声明、历史里的调用都按名字对齐，改名等于换了一个工具。

## 类型与语法

- `createBashTool(options)`：内置工厂，`commandPrefix` 之类选项在创建时固定；`createReadTool` / `createEditTool` 同理。
- `wrapTool(base, fn)`：`fn: (tool) => tool`，返回新工具对象；用展开保留 `name`、`description`、`parameters`。
- 包装器的 `execute(args, api, ctx)` 里调 `base.execute(args, api, ctx)`，把结果（或 park）原样返回。
- `timings` 是模块级数组，只为了在脚本里打印次数。
- `result.content.map((part) => (part.type === "text" ? part.text.trim() : ""))`：从工具结果里取文本，再 `.replace(project, "<project>")` 去掉临时路径。
