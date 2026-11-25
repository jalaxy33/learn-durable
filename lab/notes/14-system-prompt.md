# 系统提示词：段落、装饰、只存差异

系统提示词不是每轮拼一次然后整段发出去的字符串。它是**按 key 管理的段落集合**，每次请求重新渲染，只把与模型已看到的内容**不同的部分**追加进 transcript。

## 段落

```ts
section(key, render, { tag })   // render: (input, context) => string | undefined
```

- `key` 是段落在整份提示词里的身份，也是补丁的单位。
- `tag` 默认 `true`，渲染成 `<key>\n文本\n</key>`；`tag: false` 原样输出，适合开场白这类不需要标签的段落。
- `render` 返回 `undefined` 表示这一轮不要这个段落（不是空字符串）。
- 段落抛错时保留模型已看到的旧文本并上报，请求继续。

段落顺序 = 选中扩展的安装顺序，对话自己的 `instructions` 最后渲染（key 就是 `instructions`）。

`render` 拿到的 `input` 有五个字段：`conversationId`、`agent`（本次请求的解析结果，含 `tools`）、`env`（本次请求按会话 `cwd` 建出来的环境，没配就是 `undefined`）、`shown`（重放 transcript 后已经在生效的段落文本，key → 文本）、`read`（已提交文档的只读访问）。

**约束**：段落函数每次请求都会跑，但结果必须稳定。返回每次都变的值（时间戳、随机数、每次都不同的排序）会让提示词每轮都“变”，补丁失去意义，provider 的 prompt cache 也全废。

## 装饰段落

`wraps` + `wrapSection(key, wrap)` 是**装饰**，不是替换：拿到目标段落后返回一个新段落，原段落照常被调用。

```ts
wraps: [
  wrapSection("preamble", (preamble) => ({
    ...preamble,
    render: async (input, ctx) => `${await preamble.render(input, ctx)} Be terse.`,
  })),
]
```

要点：`...preamble` 复制 `key`、`tag` 等，只覆盖 `render`；包装器必须是纯函数（同样的输入同样的输出），因为它会在每次请求里随段落一起跑。注册表里同一个 key 只有一个最终段落，多个扩展可以叠加装饰。

## 只存差异

每次准备请求：

1. 从 transcript 里的 `pi.system` 条目重放出“模型已看到的段落”（按顺序应用每个条目的 `sections` 记录，`null` 表示删除）。
2. 渲染当前 agent 的全部段落，得到期望集合。
3. 比较两者，写入最小补丁：变了的 key 写新值，没了的 key 写 `null`。

结果：一次 cwd 变化只产生一条只含 `cwd` 的条目，前面的条目一个字节不动。

```ts
{ role: "system", content: "", sections: { cwd: "<cwd>\n/repo/packages\n</cwd>" } }
```

如果补丁会改变段落顺序（不只是值），就退化成“全部删掉 + 按新顺序全部重加”，两条条目一起写。

这么做的理由是 prompt cache：请求前缀必须逐字节一致，变化只能追加在末尾。整段提示词每轮重发会让缓存每次都失效。

## 工具声明的变化走同一个通道

工具增删也是提示词的一部分，跟着 `pi.system` 条目一起写（`toolsRemoved` / `toolsAdded`）。保留的工具不重发、新增的追加；只有当顺序无法靠增删保持时，才全部移除再按新顺序重加。

## 条目形状

`SystemEntry` 的 `model` 是 `[{ role: "system", content: "", sections: {...}, timestamp }]`：

- `content` 是空字符串——提示词在 transcript 里**不是一段文本**，而是按 key 的补丁记录。
- `sections` 是 key → 渲染好的文本（已含标签）。

所以想“看提示词长什么样”，要读 `sections` 并把补丁按顺序叠起来，不能只读最后一条。

## 环境

`Harness.open(...)` 的 `env` 选项是**每次使用都重新调用**的工厂，不是实例：

```ts
env?: (target: { conversationId, cwd?, read }, context) => ExecutionEnv | undefined | Promise<...>
```

`target.cwd` 是会话 agent 里配的 `cwd`。环境每次按需建，所以一个 Harness 下多个会话可以有不同工作目录。`NodeExecutionEnv` 是 Node 实现（文件系统、shell 等，后续的工具示例用到），这里只用到 `cwd`。

## 每会话 agent

会话存自己的 agent 状态，`createConversation()` / `root()` 的 `agent` 参数在**创建那一次 commit** 里写入：

- `extensions: { remove: [X] }` 在宿主默认集合上做增删；给数组则是“只用这些，按顺序”。
- `instructions` 单独渲染成最后的 `instructions` 段落（也会被 JSON 之外的消费方当作会话说明）。
- `cwd` 决定这个会话的环境。
- `ownership` 只有两种：`ownerless`（顶层会话）或 `task`（归某个任务所有，随任务结束）。

同一个 Harness、同一个 registry，两个会话拿到的提示词可以完全不同——差异都在各自的 agent 状态里，不在代码里。

## 类型

`SystemEntry.is(entry)` 是 token 自带的类型守卫：判断 `kind` 并把 `EntryRecord` 收窄成 `TypedEntry`。不用它就得自己比较 `entry.kind` 再手动收窄。

读一整页再按时间正序：

```ts
const page = await conversation.entries({}, 20, undefined, ctx); // 默认最新在前
const chronological = [...page.items].reverse();                  // reverse 原地改，先复制
```

## TS / JS 语法

- **内联类型导入**：`import { type Conversation, Harness } from "..."`，`verbatimModuleSyntax` 下类型必须标出来，不然运行时导入会真的去找这个值。
- **参数里解构 + 默认值**：`({ cwd = "/" }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd })`。类型写在解构后面，`=` 给的是解构默认值（`cwd` 为 `undefined` 时生效），不是可选属性。
- **对象展开覆盖单个方法**：`{ ...preamble, render: ... }`。
- **模板字符串里 await**：`` `${await preamble.render(input, ctx)} Be terse.` ``。
- **可选链取值**：`input.env?.cwd`，没有环境时得到 `undefined`，段落被跳过。
- **`flatMap` 拍平**：`entries.flatMap((entry) => (SystemEntry.is(entry) ? (entry.model ?? []) : []))`，一边过滤一边展开。
- **嵌套 await**：`await (await root.submit(...)).wait(ctx)`——先等句柄，再等结算。
- **守卫函数的收窄作用域**：`SystemEntry.is(entry)` 为真之后，`entry.model` 才有 assistant/system 消息的类型。
