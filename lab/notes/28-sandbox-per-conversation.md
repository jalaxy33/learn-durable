# 每会话一个沙箱：环境由文档决定

`HarnessOptions.env` 是“每次使用时调用”的函数，签名里带 `conversationId` 和一个**已提交读**接口。用它查“这个会话该在哪个沙箱里跑”，就是一个会话一个环境的实现。

## env 函数的三件事

```ts
env: async ({ conversationId, read }, envContext) => {
  const sandbox = await read.snapshot(Sandbox, conversationId, envContext);
  return sandbox?.path === undefined ? undefined : new NodeExecutionEnv({ cwd: sandbox.path });
},
```

- **可以返回 Promise**：允许 I/O（起容器、拿租约）。文档明确它不在 Session 主线上跑。
- **参数里给了 `conversationId`**，所以能按会话查东西。
- **`read` 是已提交读**：只能看到 commit 过的状态，不会读到半截写入。
- **返回 `undefined` 表示“这个会话没有环境”**：依赖环境的工具会得到干净的错误结果，而不是崩掉整个运行。

## 记录在文档里

```ts
const Sandbox = defineDoc<{ path?: string }>({
  scope: "conversation", history: "latest", fork: "initial", initial: () => ({}),
});
```

- `history: "latest"`：只保留当前值（沙箱位置是“当前事实”，不需要历史）。
- `fork: "initial"`：分叉出来的会话**没有沙箱**，等 app 分配——这比继承父会话的目录安全得多。
- `path?: string`：缺省就是“还没分配”。

## 在创建提交里初始化

```ts
const conversation = await harness.createConversation({
  ownership: { kind: "ownerless" },
  agent: { model },
  init: async (tx, id) => { (await tx.doc(Sandbox, id)).path = path; },
}, context);
```

`init` 在**创建那次提交**里执行，于是“会话存在”和“沙箱记录存在”是原子的：不会出现“会话建好了但查不到沙箱，第一次工具调用失败”的窗口。

实测两个用户各自写自己的目录：

```
alice's sandbox: from alice
bob's sandbox: from bob
```

同一个 Harness、同一份注册表、同一个模型，只是 `env` 按会话查到不同的目录。

## 换成真实沙箱要改什么

只改 `env` 的返回：

```ts
return new ContainerExecutionEnv({ id: sandbox.containerId });   // 或远程 exec、或 Firecracker 实例
```

工具（`read`/`write`/`edit`/`bash`）一行不动——它们只通过 `input.env` 访问文件与进程。这也是 16 那条结论的具体用法：**隔离的边界在环境实现，不在工具**。

## 关联的两个细节

- **`env` 每次使用都重新调用**，所以改了文档里的沙箱路径，下一次工具调用就换环境，不用重开会话（14 演示过同样的机制）。
- **没有环境时的行为**：工具会返回错误结果（模型看得到），而不是让运行失败。所以“还没分配沙箱”是可用状态，不是异常状态。

## 类型与语法

- `env` 的类型是 `(target: EnvTarget, context) => ExecutionEnv | undefined | Promise<…>`；`EnvTarget` 有 `conversationId`、`cwd?`、`read`。
- `init(tx, conversationId)` 是 `ConversationInit`，与创建同一次提交。
- `read.snapshot(token, conversationId, ctx)` 返回 `T | undefined`。
- 解构参数时只声明用到的字段（`{ conversationId, read }`）即可，类型上兼容更宽的对象。
