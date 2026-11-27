# Durable 坐在 Chord 的 store 上

一个 Chord 宿主有自己的 store（这里 SQLite）和事务模型。durable 可以作为**一个 storage 实现**挂上去：Chord 对象自己的表和 durable 的条目/文档共用一个提交队列、一个 id 分配器、一次导出。

## 装配

```ts
const Chat = local("example.chat", { version: 1, params: {}, members: { note: method(str()), say: method(str()) } });

const facet = defineFacet((host) => {
  host.serve(Chat, (_, self) => {
    const notes = self.table(Notes);                       // ① 对象自己的表
    const harness = self.open(                          // ② 宿主生命周期资源
      async (open) => {
        const opened = await Harness.open(
          await StoreStorage.open(store, Chat.name, open),  // ③ durable 的 storage 挂在 store 上
          { models: createModels(), registry: createRegistry() },
          open,
        );
        await opened.root(open);
        return opened;
      },
      (h, _reason, close) => h.close(close),
    );
    return {
      note: async (text, ctx) => { await self.tx((tx) => tx.put(notes, { id, text }), ctx); return null; },
      say: async (text, ctx) => {
        const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
        await root!.submit({ type: "write", entry: { kind: "example.said", data: { text } } }, ctx);
        return null;
      },
    };
  });
});
```

四层结构：

| 层 | 是什么 |
|---|---|
| `local("example.chat", { params: {} })` | 对象类型：空参数 = 每宿主一个实例，活得和宿主一样久 |
| `defineFacet(host => host.serve(type, factory))` | 插件声明：只声明，由宿主激活 |
| `self.table` / `self.tx` | 对象自己的表与提交 |
| `StoreStorage.open(store, Chat.name, ctx)` | durable 的 `Storage` 实现在 store 之上，**按 owner 名归属** |

`self.open(factory, close)` 是关键：它在宿主启动时打开一次、宿主关闭时关闭，所以 Harness 是“宿主级资源”，不需要每个调用去建。

## 一个队列、一个 id 分配器

```
seqs taken: 2
```

`chat.note(...)`（Chord 的表写入）一次提交占一个 seq；`chat.say(...)`（durable 的 write submission）也是一次提交占一个 seq。两者在**同一个 store 的提交队列**里排队，所以顺序一致、不会交错。

id 也一样：`manifest` 里的 `nextId` 由 store 统一分配，Chord 的对象和 durable 的条目用同一套。

## 一次导出带走两边

```ts
for await (const part of store.export(context)) { … }
```

```
manifest: { lastSeq: 5, nextId: 9 }
parts by owner and kind: {
  'example.chat table': 7,
  'example.chat put': 12,
  'example.chat document.create': 5
}
```

`export` 把 store 里的一切按 owner 名分组吐出来：Chord 的表行（`table`/`put`）、durable 的文档（`document.create`）都在 `example.chat` 这个 owner 名下——因为 `StoreStorage.open(store, Chat.name, …)` 用的就是这个名字。备份/迁移/跨机器搬运只需要这一个流。

## 重开之后

```ts
const reopened = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
const storage = await StoreStorage.open(reopened, Chat.name, context);
```

```
Durable entries after reopen: [ 'example.said' ]
```

durable 的条目还在，因为它从来就存在 store 里，而不是某个进程内存里。

## 什么时候需要这一套

- 你的应用已经在 Chord 上跑（多进程、多端、插件热更新），想把 agent 塞进其中一个对象。
- 你需要**业务数据和对话在同一个事务边界里**（下一节的 36 会把这个能力用在“对象 follow 一个对话视图”上）。
- 你需要一次导出就包含全部状态。

只用 durable、不碰 Chord 的话，用 JSONL/SQLite 的独立 storage 更简单。

## 类型与语法

- `local(name, { version, params, members })`：`params: {}` 表示空参数；`method(schema)` 声明方法签名。
- `defineTable(name, { version, columns, key })`：列用 pi-schema 的 builder（`str()`）。
- `defineFacet((host) => …)`：`host.serve(type, (params, self) => members)`，`self` 上有 `table`、`tx`、`open`。
- `self.open(factory, close)`：宿主生命周期资源；`harness.value` 是打开后的值。
- `StoreStorage.open(store, ownerName, ctx)`：返回 `Storage`；`ownerName` 决定表和文档的命名空间。
- `ROOT_CONVERSATION_ID`：保留的根会话 id，不需要自己记。
- `store.export(ctx)` 是异步迭代器，`part.kind` 决定怎么读。
