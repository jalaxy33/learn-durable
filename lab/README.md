# lab

跑通 `@earendil-works/pi-durable` **v1.6.1** 官方示例的实验目录。代码在 `examples/`，顺序：`13` → `47`，最后是底层的 `00` → `12`。

## 运行

```bash
node examples/13-chat.ts   # Node 26 已默认剥离类型
npm run typecheck          # tsc --noEmit
```

本目录装的是发布包，导入解析到 `dist`，所以用包名导入即可，不需要 `--conditions=source`。

## 进度

状态：`未做` / `在做` / `通过`；读源码的示例在备注里标「只读源码」。关键机制随做随填。备注记本地对示例做过的改动、跑法差异。

| 序 | 文件 | 演示什么 | 关键机制 | 状态 | 备注 | 笔记 |
|---|---|---|---|---|---|---|
| 13 | `13-chat.ts` | 一问一答 | `submit` / `wait` 的提交与结算；`pi.generation` 运行；sections 系统提示词；条目只追加 | 通过 | | [13-chat](notes/13-chat.md) |
| 14 | `14-system-prompt.ts` | 系统提示词 | sections + `wrapSection` 装饰；`pi.system` 只存差异补丁；`env` 工厂；每会话 agent | 通过 | | [14-system-prompt](notes/14-system-prompt.md) |
| 15 | `15-real-model.ts` | 用 DeepSeek 流式输出答案 | provider / `Models` 目录；`pi.live` 节流的部分回答；`watchDoc` 看文档；补齐差额 | 通过 | 需要 `DEEPSEEK_API_KEY`；模型 `deepseek-flash` | [15-real-model](notes/15-real-model.md) |
| 16 | `16-coding-tools.ts` | 带工具的一轮对话，JSONL 存储 | `Storage` 接口换实现；`env` 决定文件/进程访问；每个调用一个 `pi.tool` 任务；`beforeTool`/`afterTool`；工具错误是数据 | 通过 | 存储目录 = 工作目录（同一个临时目录）；`cat /tmp/1gb.txt` 要先建文件 | [16-coding-tools](notes/16-coding-tools.md) |
| 17 | `17-print.ts` | print 模式：提交 prompt，打印答案 | — | 未做 | | |
| 18 | `18-json.ts` | JSON 模式：原始 view 操作，或追加 entry + 每次变化触发的 `pi.live`，跑在 SQLite / JSONL / memory 上 | — | 未做 | | |
| 19 | `19-inbox.ts` | 忙碌时的 steer、follow-up、write 与撤回 | 忙时提交的四种去向；`pi.inbox` 队列；边界放置顺序；write 不排队；`continue` | 通过 | | [19-inbox](notes/19-inbox.md) |
| 20 | `20-late-join.ts` | 运行中接入 view：先拿到运行中工具的输出，再看流式答案 | — | 未做 | | |
| 21 | `21-subagent-foreground.ts` | 可重放的 subagent 工具，子会话归该调用所有，子 transcript 挂在调用下 | — | 未做 | | |
| 22 | `22-subagent-background.ts` | 常驻 subagent：生成、steer、停止、列出，答案回报给父会话，重启安全 | — | 未做 | | |
| 23 | `23-child-tasks.ts` | 一个 checkout 拥有并等待四笔支付：failFast、abort、重启 | — | 未做 | | |
| 24 | `24-compaction.ts` | 长对话压缩：后台、手动、上下文溢出后 | — | 未做 | | |
| 25 | `25-coding-agent.ts` | CodingTools、settings 对象提供的实时设置、跟随会话目录的 environment | — | 未做 | | |
| 26 | `26-plan-mode.ts` | 只读 plan 模式，作为带自己 document 的扩展，用 `configure()` 切换 | — | 未做 | | |
| 27 | `27-reviewer.ts` | 自带 model、扩展、工具、目录的 reviewer 会话与评审循环 | — | 未做 | | |
| 28 | `28-sandbox-per-conversation.ts` | 每会话一个 environment，从 app document 里查 | — | 未做 | | |
| 29 | `29-tool-override.ts` | 部分会话换用同名 bash，再包一层给胜出的 bash 计时 | — | 未做 | | |
| 30 | `30-reload-and-restart.ts` | 调用进行中重载扩展；存储的选择跨重启存活 | — | 未做 | | |
| 31 | `31-transcript.ts` | 客户端 transcript 走 windowed view：实时追加、带 gap 的停顿、加载与更早分页、用 `from` 续读 | — | 未做 | | |
| 32 | `32-tests-after-edits.ts` | `afterRun` 钩子在改过文件的 run 之后跑测试，失败则发起修复 run，输入等它们 | — | 未做 | | |
| 33 | `33-turn-limit-and-continue.ts` | 每会话 turn 上限、`runFailure`、不带用户消息继续 | — | 未做 | | |
| 34 | `34-submit-in-commit.ts` | 用 `submit(tx, draft)` 与 `whenIdle: "reject"` 在宿主自己的 commit 内接纳 visitor 的 steer | — | 未做 | | |
| 35 | `35-durable-on-the-store.ts` | Harness 建在 Chord 宿主 store 的 `StoreStorage` 上，与 Chord 对象自己的表并存：一个 commit 队列、一个 id 分配器、一次导出 | — | 未做 | | |
| 36 | `36-durable-views.ts` | Chord 对象用 `self.follow` 跟一个 Durable view：帧，以及成员读取跟到的值 | — | 未做 | | |
| 37 | `37-harness-registry.ts` | Harness 放在 Chord 对象里：扩展经 Chord registry 贡献，Harness 关闭时 follower 迁到下一个 | — | 未做 | | |
| 38 | `38-signals.ts` | `defineSignal()`、`harness.signal()` 的每种结果、提前到的信号立刻唤醒 sleep | 信号的 name/version/schema；五种投递结果；睡在 key 上、唤醒即消费；`wake()` 的宿主视角 | 通过 | | [38-signals](notes/38-signals.md) |
| 39 | `39-ask-a-person.ts` | task 睡在一个人的回答上并带 deadline：先答，再过期且迟到回答被拒；睡眠中 `wake()` | 信号 + `until` 同时挂；`reason` 决定走哪条；时钟注入；过期后迟到值 `closed`；问题内容归宿主存 | 通过 | [39-ask-a-person](notes/39-ask-a-person.md) |
| 40 | `40-tool-waits-for-webhook.ts` | CI 工具落在自己 webhook 的 signal 上：park 前崩溃（幂等 memo）与 park 中被 Stop（`cancel`） | — | 未做 | | |
| 41 | `41-tool-polls.ts` | 按时间 park，带退避地轮询一个慢任务 | — | 未做 | | |
| 42 | `42-parallel-children.ts` | `executeTool(..., { wait: false })` 与 `policy: "any"` 的 park，跨唤醒按 key 收结果 | — | 未做 | | |
| 43 | `43-subagent-waits.ts` | subagent 工具 park 在 `SubmissionSettled`（`notify`）上，子会话 park 在人身上 | — | 未做 | | |
| 44 | `44-approval-gate.ts` | 以参数为 key、deadline 带 memo 的 `beforeTool` 审批闸，加一道每次唤醒都重问的闸，以及拒绝与过期 | — | 未做 | | |
| 45 | `45-review-on-yield.ts` | `onYield` 审查 task，`{ continue }` 把 agent 送回去；排队的用户消息胜出 | — | 未做 | | |
| 46 | `46-after-tools-terminate.ts` | `afterTools` task 问人是否继续：一次 steer，然后 `{ terminate: true }` | — | 未做 | | |
| 47 | `47-fit-images.ts` | 存储前把图片适配模型上限：`fitImage` 附照片、`fit-images` 扩展处理工具截图 | — | 未做 | | |

## 之后：底层各层 00–12

| 序 | 文件 | 关键机制 | 状态 | 笔记 |
|---|---|---|---|---|
| 00 | `00-conversation.ts` | — | 未做 | |
| 01 | `01-documents.ts` | — | 未做 | |
| 02 | `02-forks.ts` | — | 未做 | |
| 03 | `03-owned-conversations.ts` | — | 未做 | |
| 04 | `04-watches.ts` | — | 未做 | |
| 05 | `05-harness.ts` | — | 未做 | |
| 06 | `06-configuration.ts` | — | 未做 | |
| 07 | `07-harness-conversations.ts` | — | 未做 | |
| 08 | `08-context.ts` | — | 未做 | |
| 09 | `09-registry-reload.ts` | — | 未做 | |
| 10 | `10-extension-state.ts` | — | 未做 | |
| 11 | `11-tasks.ts` | — | 未做 | |
| 12 | `12-recovery.ts` | `defineTask` 阶段状态机；检查点 + `memo` 幂等；`sleepUntil`；关掉重开继续 | 通过 | [12-recovery](notes/12-recovery.md) |

## 对应笔记

`../docs/3-appendix/3-source-map.md` 里有文档章节 ↔ 示例的对应表；讲某个示例时可以顺着它的源码入口往下看。
