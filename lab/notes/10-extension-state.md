# 扩展状态：用文档存，不用内存变量

扩展要记住东西（todo 列表、开关、游标）时，把它放进**文档**：提交才生效、fork 有明确语义、重启不丢。工具写它，段落读它，模型每次请求都能看到。

## 定义

```ts
const Todos = defineDoc<{ items: string[] }>({
  kind: "example.todos",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [] }),
  checkpointWhen: () => false,
});
```

| 字段 | 这里的选择 | 含义 |
|---|---|---|
| `scope` | conversation | 每个会话一份 |
| `history` | rewindable | 可按条目回看历史 |
| `fork` | asOf | 分叉时取分叉点那一刻的值（文档跟着对话走） |
| `initial` | `{ items: [] }` | 新建会话的初值 |
| `checkpointWhen` | 永不为真 | 不合并增量，适合小文档 |

如果这份状态是“当前设置”，用 `latest` + `current`；如果是“随对话推进的过程”，用 `rewindable` + `asOf`。

## 写：工具里的提交

```ts
execute: async (args, api, callContext) => {
  await api.commit(async (tx) => {
    (await tx.doc(Todos, api.conversationId)).items.push(args.item);
  }, callContext);
  return { output: [{ type: "text", text: `added ${args.item}` }] };
}
```

- `tx.doc` 是**可写 draft**：拿到后直接改字段，提交时落盘。
- **首次写就创建**，不需要预先初始化——`initial()` 只在新文档第一次被读/写时作为底值。
- 工具的输出和文档的写入是两次提交（先写文档、返回结果再提交结果）。要一次原子完成，就在同一个 commit 里既改文档又返回结果。

## 读：段落里的快照

```ts
section("todos", async (input, renderContext) => {
  const todos = await input.read.snapshot(Todos, input.conversationId, renderContext);
  return todos === undefined || todos.items.length === 0 ? undefined : todos.items.join("\n");
}),
```

- `input.read` 是已提交状态的只读访问（`snapshot` / `snapshotAsOf`）。
- **文档不存在就返回 `undefined`**——段落返回 `undefined` 表示“这轮不要这一段”，比渲染空字符串好（空字符串也会让提示词变化）。
- 段落默认带标签，所以模型看到的是：

```
<todos>
fix the build
</todos>
```

## 提示词里怎么出现

系统提示词是“段落补丁”（14 讲过），所以实测只有两条 `pi.system`：

```
{ sections: undefined, toolsAdded: [ 'todo' ] }                    ← 第一次请求：只宣告工具
{ sections: { todos: '<todos>\nfix the build\n</todos>' } }        ← 第二次请求：todos 有了内容
```

第一次请求时文档还没写，段落渲染为 `undefined`（不出现）；工具写完文档，第二次请求才出现这个段落——而且**只追加变化的部分**，前面的提示词一个字节没动。

## fork 语义

`fork: "asOf"` 让分叉出的会话继承**分叉条目那一刻**的列表，之后两边各自独立。这是“待办跟着对话走”的正确行为；如果写成 `fork: "initial"`，分叉会得到空列表（像 `pi.live` 那样故意不继承）。

## 为什么不用模块级变量

```ts
let todos: string[] = [];   // 别这么干
```

- 进程重启就丢；
- 多会话共享一份，互相污染；
- 不参与提交，崩在中间无法解释；
- 无法 fork、无法回看、无法被 UI 订阅。

文档把这些都免费给你了——它就是“扩展自己的持久状态”的标准答案。

## 类型与语法

- `defineDoc<T>` 的 `T` 是内容形状；`tx.doc` 返回 draft，可直接 push 数组。
- `api.commit` 只做写入；返回值是回调返回值（这里 `undefined`）。
- `input.read.snapshot(token, conversationId, ctx)` 返回 `T | undefined`。
- 段落函数可以是 `async`：`(input, renderContext) => Promise<string | undefined>`。
- `api.conversationId` 是当前工具调用所属会话，写文档时用它定位。
