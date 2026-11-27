# transcript：客户端怎么把窗口拼成完整对话

会话视图是**窗口**（最新 N 条），客户端要的是**整条对话**，而且连接会断。`ConversationTranscript` 是客户端侧的合并层：吃每一帧视图，吐出“条目 + 缺口标记 + 可继续往前翻”的完整列表。

## 三个角色

```ts
const transcript = new ConversationTranscript(
  (query, limit, ctx) => root.entries(query, limit, undefined, ctx),   // 怎么翻页
  { pageSize: 20 },
);
let watch = await root.watch(context, { min: 10, max: 20 });           // 服务端的窗口
let view = transcript.merge(watch.value);                              // 客户端合并
```

| 角色 | 负责 |
|---|---|
| `conversation.watch(ctx, window)` | 服务端只发窗口内的条目（默认 newest 50，最多保留 100） |
| `ConversationTranscript` | 记住客户端已有的全部条目，合并每一帧 |
| `transcript.loadEarlier()` / `fillGap()` | 缺口和更早历史按需拉 |

## 窗口的 `min` / `max`

`{ min: 10, max: 20 }` 的含义：连上时给最新 10 条；之后按追加增长，最多保留 20 条，超过就丢最老的。

于是“客户端看到的”永远是后缀——完整对话必须由客户端自己累积，这正是 transcript 存在的理由。

## 三类 item

```ts
type TranscriptItem =
  | { kind: "entry"; entry }                      // 一条条目
  | { kind: "gap"; after: EntryId; upTo: EntryId } // 这两条之间缺东西，渲染“加载更多”
  | { kind: "earlier" };                           // 上面还有更早的，永远是第一项
```

渲染器只认这三种，不需要知道窗口或 id 区间。

## 实测的六个阶段

```
attach                       [load earlier] 191..200
15 more, live                [load earlier] 191..215
load earlier                 [load earlier] 171..215
resume after 40 missed       [load earlier] 171..215 [load more] 246..255
fill gap                     [load earlier] 171..235 [load more] 246..255
fill gap                     [load earlier] 171..255
resume after 3 missed        window: 3 entries
                             [load earlier] 171..258
```

- **attach**：会话已有 200 条，窗口给了最新 10 条（191..200），上面标“可以加载更早”。
- **live**：追加 15 条，窗口超过 `max` 后开始丢最老的，但客户端一条不丢（191..215 连续）。
- **load earlier**：往前翻一页（`pageSize: 20`），拿到 171..190。
- **断线重连**：停掉 watch，追加 40 条（超过 `max`），用 `transcript.resume` 重连。窗口从 newest 10 开始（246..255），中间 40 条成缺口 → `[load more]`。
- **fillGap**：一次一页地把缺口填上（很形象：缺口右边界不动，左边界一页页往右推）。
- **短断线**：只错过 3 条时，`resume` 让窗口只返回这 3 条，没有缺口，直接续上。

## `resume` 为什么必须用它

```ts
watch = await root.watch(context, { ...window, ...transcript.resume });
```

`transcript.resume` 是 `{ from: <newest 之后> }`：新窗口从“客户端已有内容的末尾”开始，而不是从最新的 N 条开始。

- 错过的能装进窗口 → 直接补齐，无缺口；
- 错过的超过窗口容量 → 窗口只给最新的那部分，中间成为 gap，需要 `fillGap`。

不用它（照原样 `{min,max}` 重连）也能跑，但你会静默丢掉中间那段：客户端以为是连续的。

## 为什么不用 offset 计数

条目 ID **有空洞**（删除、fork、并发分配都会跳号），所以不能“第 100 到 120 条”这样算。transcript 只用**独占边界**（`after`、`upTo`、`from`）换算成 `EntryQuery` 的包含边界，数量交给存储数。

## 其它语义

- `merge` 只增不改（条目不可变），代价 O(items)，不会重排也不会重新请求；没有新增时返回同一个数组。
- 同一 gap 的并发 `fillGap`、并发 `loadEarlier` 会共享一次加载——占位符一直可见也不会重复请求。
- `transcript.newest` 是它够到的最新条目标识，`resume` 由它算出；“空 transcript”返回 `{}`（从头开始）。
- `pageSize` 默认 50，示例设 20 是为了让翻页在输出里看得见。

## 类型

- `TranscriptView` = `ConversationView` 去掉 `entries`/`before`，换成 `items`。
- `EntryLoader` 签名与 `conversation.entries()` 一致，所以直接包一层就能用。
- 找第一个缺口要收窄：

```ts
view.items.find((item): item is Extract<TranscriptItem, { kind: "gap" }> => item.kind === "gap");
```

- `firstGap(view)` 返回 `undefined` 就是填完了。

## 与 18 的关系

18 讲了两条消费路径：ops（自己维护副本）和 state（每帧重绘）。31 是第三条、也是最完整的一条：**窗口 + 客户端累积 + 缺口**。做真正的聊天界面（无限上翻、断线重连）就用它，ops/state 适合只显示“当前状态”的场景。
