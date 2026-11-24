# 3. 部署：远程执行与跨机通信

> durable 的运行时可以留在本地，把工具执行放到别的机器（`pi-env`）；而跨机器 agent 通信不在 durable 里，需要你自己补"传输 + 路由 + 幂等 + 死信"。

版本：pi-durable **v1.6.0**；`pi-env` **1.6.0**。

## 你会学到

- `pi-env` 到底是什么、能做什么、不是什么
- 远程执行、`listFiles`、PTY、`openProcess` 分别补哪个缺口
- 跨会话通信的三层：同 Harness / 同机多进程 / 多机
- outbox + gateway + correlation + 幂等 + 死信的最小实现
- 各部分的工作量

---

# 第一部分：pi-env

## 1. 定位

> 它是 durable 的"执行环境层"：把"工具在哪台机器上跑"变成可替换的实现，并保证远程行为与本地 `NodeExecutionEnv` 一致。

组成：

```text
pi-env
├─ daemon/   Rust 程序，跑在目标机器上，通过 stdin/stdout 的帧协议通信
└─ client    TS：RemoteExecutionEnv / LocalExecutionEnv / openTerminal / openProcess
```

它直接依赖 `@earendil-works/pi-durable@1.6.0`。

---

## 2. 它能做什么

### ① 远程执行

```typescript
import { connectSsh, RemoteExecutionEnv } from "@earendil-works/pi-env";

const { connection } = await connectSsh({ host: "gpu-box", knownHostsFile, hostKeyAlias });
const env = new RemoteExecutionEnv({ connection, id: "pi-env:gpu", cwd: "/home/me/project" });

await Harness.open(storage, { models, registry, env: () => env }, context);
```

从此 `read/write/edit/bash` 和你自己的工具都在那台机器上执行。存储、模型密钥、会话留在本地。

### ② 惰性连接

```typescript
const lazy = sshConnection(target);        // 不立即连接
const env = new RemoteExecutionEnv({ connection: lazy.connection, id, cwd });
```

第一次操作才检测、部署 daemon、连接；失败就是那次操作的错误，下一次重试。

### ③ `listFiles`：给本地环境也补上

```typescript
const connection = new Connection({ command: [localDaemon()] });
const env = new LocalExecutionEnv({ cwd, connection });
const listing = await env.listFiles(".", { exclude: ["node_modules"] }, context);
```

语义像 `fd --hidden --exclude .git`：

- 递归、不跟随符号链接；
- git 工作区里跳过忽略文件；
- `maxEntries` / `maxBytes` / `timeoutMs` 有界，返回 `truncated`；
- 老 daemon 返回 `not_supported`，调用方回退。

这直接补上了自己写 `grep/find/ls` 时"没有高效目录遍历"的缺口。

### ④ PTY

```typescript
const term = await openTerminal(connection, { cwd });
```

默认登录 shell；raw 输出、输入、resize、退出码。用于真正需要 TTY 的命令，或给用户一个"在 agent 环境里开终端"的能力。

**Windows 暂不支持终端。**

### ⑤ `openProcess`：带管道的后台程序

```typescript
const server = await openProcess(connection, {
  cwd,
  argv: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
  onStdout, onStderr,
});
server.write(...); server.closeStdin();
// close() 杀掉整个进程组；server.exited 拿退出码
```

用于 MCP server、需要 stdin/stdout 的长运行程序。`pi-mcp` 的 `PipeTransport` 直接接受这个 handle。

### ⑥ 看远程文件变化

`ExecutionEnv.watch` 由 daemon 实现：原生事件触发 debounce 重扫，变化 = 快照差异 + 事件路径；网络盘/FUSE 退化为轮询；连接断开后重开会报告 `overflow`。

---

## 3. 一致性保证

`docs/semantics.md` 把差异都列了：

| 关注点 | 谁负责 |
|---|---|
| 路径解析（`~`、`file://`、Windows 盘符） | 客户端，按远端规则 |
| 错误码映射（`ENOENT` → `not_found`） | 客户端，同 `NodeExecutionEnv` |
| 读取大小、BOM、解码 | 客户端 |
| 写入（512 KiB 分块、每块前检查 abort） | 客户端 |
| 超时、abort、spill 优先级 | 客户端 |
| 系统调用、进程、spill 文件 | daemon |
| 输出解码（每流独立、WHATWG UTF-8） | daemon |

测试方式是 env conformance suite + 与本地 `NodeExecutionEnv` 的差分比较；设置 `PI_ENV_SSH_HOST` 时跑真实 SSH。

---

## 4. 安全与限制

它做了什么：

- 凭据留在本地；
- SSH `BatchMode`、严格 host key、不转发、不复用连接、不执行配置命令、不转发 locale；
- daemon 按 SHA-256 命名，**每次启动前校验**。

它**不是**：

- 不是容器/VM 隔离；
- 没有网络出口策略；
- 没有秘密管理；
- 不校验命令内容（那是你的 `beforeTool` 策略）。

限制：

| 限制 | 说明 |
|---|---|
| 不是沙箱 | 权限 = SSH 用户 |
| 进程不跨重启 | PTY / `openProcess` 句柄属于连接 |
| Windows 无 PTY | 仅 Linux/macOS/Termux |
| 需要部署 daemon | 目标机器要可写、可执行 |
| 版本偏差 | 老 daemon 缺功能 → `not_supported` |
| 单连接 | 一个 connection 上操作排队 |

> 定位：**它是"执行位置"的抽象，不是"安全沙箱"。**

---

## 5. 什么时候值得用

| 情况 | 建议 |
|---|---|
| 纯本地、单人 CLI | 可以不用；自己写 `listFiles` 也行 |
| 需要远程开发机/GPU | 用 `RemoteExecutionEnv` |
| 多租户、每会话容器 | 用，每容器一个 env |
| 需要 PTY | 用 `openTerminal` |
| 接 MCP server | 用 `openProcess` + `pi-mcp` |
| 想省掉自己写 `listFiles` | 用 `LocalExecutionEnv` |
| 需要不可信代码沙箱 | 不够，要容器/VM + 网络策略 |

---

# 第二部分：跨会话通信

## 6. 先分清三个"session"

```text
Conversation   一个会话/一条 agent 线程
Harness        一个进程 + 一个 storage
Deployment     一台机器 / 一个容器
```

durable 原生只覆盖第一层。

---

## 7. 同一个 Harness：原生就能做

### 直接 submit

```typescript
await worker.submit({
  type: "input",
  content: "查一下订单 ACME-1234",
  entry: { kind: "agent.request", data: { from: "planner", id: messageId } },
  requestId: `agent:planner:${messageId}`,
}, context);
```

### 请求-响应：`notify`

```typescript
// A 的 task 先 park
return { status: "sleeping", signals: [AgentReply.key(correlation)], until: now + 5 * 60_000, checkpoint: {} };

// A 提交给 B，让 B 的 settle 结果直接唤醒 A 的 task
await worker.submit({
  type: "input",
  content,
  requestId: `req:${correlation}`,
  notify: { taskId: api.taskId, key: correlation },
}, context);
```

同一个 Harness 内 taskId 是全局的，所以跨会话也能用。这是 subagent-waits 的机制。

### 定向 signal

```typescript
await harness.signal(workerTaskId, OrderEvent, "order-1234", { status: "shipped" }, context);
```

适合"通知一个正在等的事件"。需要知道 `taskId`。

### session 文档

```typescript
const Agents = defineDoc<{ byId: Record<string, { conversationId: string }> }>({
  kind: "app.agents", version: 1, scope: "session",
  initial: () => ({ byId: {} }), checkpointWhen: () => false,
});
```

整个 Harness 共享，适合注册表、配置、广播状态。不适合高频消息（消息进 entry/inbox）。

---

## 8. 同机多进程：加一个 gateway

两个独立 Harness 各有 storage，互相看不见。需要 IPC。

```text
Process A                          Process B
┌─────────────────┐   Unix socket  ┌─────────────────┐
│ Harness A       │ <────────────> │ Gateway B       │
│ storage A       │   / HTTP       │  → Harness B    │
│ outbox doc      │                │    .submit      │
│ waiting task    │                │    .signal      │
└─────────────────┘                └─────────────────┘
```

要点：

1. 注册表：`agentId → { socket/URL, conversationId }`。
2. 每个进程一个 gateway：入站 → `submit`/`signal` → commit 后 ack；出站从 outbox 发送。
3. outbox：发前先 commit pending，避免"状态写了、消息没发"。
4. 去重：消息 id + `requestId`。
5. 超时：等待方 park 带 `until`。

如果两个 agent 不需要独立部署，**合并成一个 Harness 最省事**。

---

## 9. 多机：broker + gateway + outbox

```text
Agent A 机器                          Broker                        Agent B 机器
┌──────────────────┐    publish     ┌──────────────┐   deliver   ┌──────────────────┐
│ Harness A        │ ─────────────> │ NATS/Redis/  │ ──────────> │ Gateway B        │
│  storage A       │                │ SQS/Kafka    │             │  → harness B     │
│  outbox doc      │ <───────────── │ at-least-once│ <────────── │    .submit/      │
│  waiting task    │    reply       │              │   publish   │    .signal       │
└──────────────────┘                └──────────────┘             └──────────────────┘
```

### 消息格式

```json
{
  "v": 1,
  "id": "msg-uuid",
  "from": "agent-a",
  "to": "agent-b",
  "conversation": "conv-b-123",
  "correlation": "req-42",
  "kind": "request",
  "payload": { "content": "..." },
  "replyTo": "agent-a.inbox",
  "deadline": "2026-11-23T12:00:00Z"
}
```

### 发送方：事务性 outbox

```text
1. commit：写 outbox（pending, correlation, payload）
2. sender task：publish → 收到 ack → commit sent
3. 等待 task：park 在 Reply.key(correlation)，带 until
```

| 崩在哪 | 结果 |
|---|---|
| commit 之前 | 什么都没发生 |
| commit 后、publish 前 | outbox 还在，重启重发 |
| publish 后、mark sent 前 | 重复投递，接收方去重 |
| 等待 task 重启 | park 状态还在 |

### 接收方 gateway

```typescript
onMessage(async (m) => {
  if (await seen(m.id)) return ack();
  const conv = await harness.conversation(m.conversation);
  const sub = await conv!.submit({
    type: "input",
    content: m.payload.content,
    entry: { kind: "agent.request", data: { from: m.from, id: m.id } },
    requestId: `remote:${m.from}:${m.id}`,
  }, context);

  const settled = await sub.wait(context);
  await publish(m.replyTo, { kind: "reply", correlation: m.correlation, payload: settled });
  await markSeen(m.id);
  ack(); // 必须在 commit 之后
});
```

### 回复方 gateway

```typescript
const wait = await lookupWait(m.correlation);   // session doc: correlation → { taskId, key }
const r = await harness.signal(wait.taskId, AgentReply, wait.key, m.payload, context);
if (r === "not_found" || r === "closed") deadLetter(m);
```

早到的回复不会丢（early signal）；task 已结束 → `closed` → 死信。

---

## 10. 可靠性清单

| 问题 | 做法 |
|---|---|
| 至少一次投递 | 接收方按 `id` + `requestId` 去重 |
| 发送方崩溃 | outbox + 重发 |
| 接收方崩溃 | commit 后再 ack |
| 回复丢失 | `until` 超时 + 发送方 outbox |
| 顺序 | 每 conversation FIFO；跨机不保证全局顺序 |
| 背压 | pending outbox 上限、`whenBusy: "reject"` |
| 认证 | mTLS/JWT；消息签名 |
| 授权 | 谁能发给谁；conversation ACL |
| 死信 | `not_found`/`closed`/超时进 DLQ，人工重放 |

---

## 11. 哪些是自建、哪些是 durable

| 能力 | durable |
|---|---|
| 持久 inbox / 排队 / steer | ✅ |
| `requestId` 幂等 | ✅ |
| signal + early signal + 结果码 | ✅ |
| `notify` / `SubmissionSettled`（同 Harness） | ✅ |
| session 文档做注册表 | ✅ |
| sleep/until 超时 | ✅ |
| 审计 | ✅ |
| 跨进程传输 | ❌ |
| 发现/路由 | ❌ |
| 认证/授权 | ❌ |
| outbox / DLQ | ❌（模式） |
| 分布式锁/全局顺序 | ❌ |

---

## 12. 工作量（一人，经验值）

| 模块 | MVP（天） | 生产（天） |
|---|---|---|
| 信封/版本/校验 | 0.5 | 1 |
| 路由表 | 0.5 | 3 |
| outbox + sender | 1 | 4 |
| gateway + 去重 | 1 | 4 |
| 等待/相关表/超时 | 1 | 3 |
| 鉴权 | 0.5 | 4 |
| 死信 + 重放 | 0.5 | 3 |
| 指标/日志 | 0.5 | 3 |
| 顺序/背压 | 0 | 4 |
| 崩溃/重复/乱序测试 | 1 | 5 |
| 部署/运维 | 0.5 | 3 |
| **合计** | **~7 天** | **~7–8 周** |

用托管 broker 可省掉 ack/重投/分区，生产级约 4–5 周。

---

## 13. 结论

> **`pi-env` 把"在哪跑"做完了；跨机通信把"怎么找、怎么送、怎么算数"留给你。**
>
> durable 提供可靠的本地状态机；传输和运营规则仍然是应用层的事。

---

## 14. 相关

- [1-durable-vs-pi.md](1-durable-vs-pi.md)
- [4-building-an-agent.md](4-building-an-agent.md)
- 上游：`pi-env` 的 README、`docs/semantics.md`
- durable：[1-foundations.md](../1-core/1-foundations.md) 的 Signals 一节
