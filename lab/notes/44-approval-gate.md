# 审批闸：在工具执行前停住，等人点头

`beforeTool` 钩子能在工具执行前**park 这次调用**：返回 `{ sleep: { signals, until } }`，调用进入 `sleeping`，进程释放，等人投信号或 deadline 到。醒来时**整个 `call` 阶段从头重跑**，所以闸门必须设计成可重入的。

## 闸门的三种返回

```ts
beforeTool: async (call, api, ctx) => {
  if (call.name !== "bash" || !isRisky(call.arguments)) return undefined;   // 不管
  const key = canonicalDigest(call.arguments);
  const state = await api.readSignal(Approval, key, ctx);
  const until = await api.memo(`approvals.until.${key}`, api.now() + DAY, ctx);
  if (state === undefined) return { sleep: { signals: [Approval.key(key)], until } };  // 停住等
  if (state.kind === "expired") return { block: "No approval within a day" };          // 超时
  return state.value.allow ? undefined : { block: "Not approved" };                    // 放行 / 拒绝
}
```

| 返回 | 效果 |
|---|---|
| `undefined` | 放行，继续执行 |
| `{ block: "原因" }` | 拒绝，调用变成 `blocked` 错误结果 |
| `{ sleep: { signals?, until? } }` | 停住，等信号或 deadline，醒来重跑本阶段 |
| 抛错 | 等同 block |

注意：这里 `sleep` **不带 `kind` 标签**。1.6.1 把“工具自己返回的 park”（`execute()` 的返回值）改成了 `{ kind: "sleep" }`，但 `beforeTool` 的闸门结果是 `GateSleep`，形状没变。两处别混。

## key 为什么是参数摘要

```ts
const key = canonicalDigest(call.arguments);   // JSON → base64url
```

- 审批绑定在**具体参数**上：`rm -rf build` 的批准不能放行 `rm -rf dist`（实测三组问题各自独立）。
- 多参数工具要把 map 的键排序再序列化，否则同样的参数换个顺序就成了另一个 key（示例只有一个参数，所以省略了）。
- 同一 key 重复投递是 `duplicate`，天然挡住重复审批。

## deadline 必须 memo

```ts
const until = await api.memo(`approvals.until.${key}`, api.now() + DAY, ctx);
```

`sleep` 醒来后整个 `call` 阶段重跑，如果每次都算 `now() + DAY`，deadline 会一直往后推，永远不过期。`api.memo` 首次写入胜出，所以第一次算出来的那个时刻被钉住。

同理，`readSignal` 的结果决定这次走哪条分支——这就是“可重入闸门”的写法：**同一个函数，按已提交状态决定放行/拒绝/继续等**。

## 第二个闸门与顺序

`QuietHours` 在 `Approvals` **之前**安装（实测 `quiet-hours gate asked 2 times`）：钩子按扩展安装顺序跑，第一个 `block`/`sleep` 终止链条。所以夜里执行危险命令会在“问人”之前就被拦下——省一次打扰。

它每次被唤醒都会重新检查（`new Date(api.now()).getUTCHours()`），因为整个 `call` 阶段重跑；这也是为什么示例说“asked again on every wake”。

## 三条路的实测结果

```
asked to approve "rm -rf build"; the call is sleeping; wake: { active: false, at: … }
  approve: delivered
  result: ran: rm -rf build (quiet-hours gate asked 2 times)

asked to approve "rm -rf dist"; …
  deny: delivered
  result: <harness> [error] Tool call blocked: Not approved </harness>

asked to approve "rm -rf cache"; …
  result: <harness> [error] Tool call blocked: No approval within a day </harness>
```

- 调用中途的状态是 `sleeping`，在 `pi.live.tools[i].status` 里能看到——界面据此显示“等待审批”。
- `wake()` 给出 `{ active: false, at }`：没人要跑，但到 `at` 要回来（deadline）。宿主据此设闹钟。
- 拒绝和超时都是**错误结果**，不是抛错：模型看到 `<harness> [error] Tool call blocked: …`，可以自己换方案。

## 与其它机制的对照

| 需求 | 用什么 |
|---|---|
| 执行前审批 / 停住 | `beforeTool` + `sleep`（本示例） |
| 结果改一改 | `afterTool` |
| 每轮工具后问一句 | `afterTools`（46） |
| 答案过审才发布 | `onYield`（45） |
| 工具自己等外部事件 | `execute()` 返回 `{ kind: "sleep" }`（40） |

## 工程注意

`questions` 这个 `Map` 又是“给人看的问题记录”，只活在进程里。生产同样要落文档（taskId + key + 命令 + 谁批），否则重启后界面不知道在等什么；`readSignal` 仍能从存储里恢复判断，缺的只是“问题描述”。

## 类型与语法

- `beforeTool(call, api, ctx)` 的 `call.arguments` 是宽泛 JSON，判断内容要断言成工具参数类型。
- `api.readSignal(token, key, ctx)` 返回 `{ kind: "value", value } | { kind: "expired" } | undefined`，三种含义分别是“已批/超时/还没来”。
- `api.memo(name, candidate, ctx)` 返回持久层里的赢家（首次写入胜出）。
- `api.now()` 是 Harness 时钟，和注入的 `now` 一致；`new Date(api.now()).getUTCHours()` 读小时。
- `Buffer.from(json).toString("base64url")` 造短摘要（Node 内置）。
- `const [[key, question]] = [...questions];`：Map 展开后解构第一对。
