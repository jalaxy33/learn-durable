# lab

跑通 `@earendil-works/pi-durable` **v1.6.1** 官方示例的实验目录。代码在 `examples/`，顺序：`13` → `47`，最后是底层的 `00` → `12`。

## 运行

```bash
node examples/13-chat.ts   # Node 26 已默认剥离类型
npm run typecheck          # tsc --noEmit
```

本目录装的是发布包，导入解析到 `dist`，所以用包名导入即可，不需要 `--conditions=source`。

## 进度

状态：`未做` / `在做` / `通过`。关键机制随做随填。备注记本地对示例做过的改动、跑法差异。

| 序 | 文件 | 演示什么 | 关键机制 | 状态 | 备注 | 笔记 |
|---|---|---|---|---|---|---|
| 13 | [`13-chat.ts`](examples/13-chat.ts) | 一问一答 | `submit` / `wait` 的提交与结算；`pi.generation` 运行；sections 系统提示词；条目只追加 | 通过 | | [13-chat](notes/13-chat.md) |
| 14 | [`14-system-prompt.ts`](examples/14-system-prompt.ts) | 系统提示词 | sections + `wrapSection` 装饰；`pi.system` 只存差异补丁；`env` 工厂；每会话 agent | 通过 | | [14-system-prompt](notes/14-system-prompt.md) |
| 15 | [`15-real-model.ts`](examples/15-real-model.ts) | 用 DeepSeek 流式输出答案 | provider / `Models` 目录；`pi.live` 节流的部分回答；`watchDoc` 看文档；补齐差额 | 通过 | 需要 `DEEPSEEK_API_KEY`；模型 `deepseek-flash` | [15-real-model](notes/15-real-model.md) |
| 16 | [`16-coding-tools.ts`](examples/16-coding-tools.ts) | 带工具的一轮对话，JSONL 存储 | `Storage` 接口换实现；`env` 决定文件/进程访问；每个调用一个 `pi.tool` 任务；`beforeTool`/`afterTool`；工具错误是数据 | 通过 | 存储目录 = 工作目录（同一个临时目录）；`cat /tmp/1gb.txt` 要先建文件 | [16-coding-tools](notes/16-coding-tools.md) |
| 17 | `17-print.ts` | print 模式：提交 prompt，打印答案 | — | 未做 | | |
| 18 | [`18-json.ts`](examples/18-json.ts) | JSON 模式：原始 view 操作，或追加 entry + 每次变化触发的 `pi.live`，跑在 SQLite / JSONL / memory 上 | `ConversationView` 的窗口与 docs；ops 补丁 vs state 快照；折叠与积压整体替换；三种存储同构 | 通过 | 用 `DEEPSEEK_API_KEY` 切真模型 | [18-json](notes/18-json.md) |
| 19 | [`19-inbox.ts`](examples/19-inbox.ts) | 忙碌时的 steer、follow-up、write 与撤回 | 忙时提交的四种去向；`pi.inbox` 队列；边界放置顺序；write 不排队；`continue` | 通过 | | [19-inbox](notes/19-inbox.md) |
| 20 | `20-late-join.ts` | 运行中接入 view：先拿到运行中工具的输出，再看流式答案 | — | 未做 | | |
| 21 | [`21-subagent-foreground.ts`](examples/21-subagent-foreground.ts) | 可重放的 subagent 工具，子会话归该调用所有，子 transcript 挂在调用下 | 子会话 `ownership: task`；`replay: "safe"` + owner 扫描 + `requestId` 的幂等三件套；`api.details` 暴露子会话；按条目 ID 读答案 | 通过 | 用 `DEEPSEEK_API_KEY` 切真模型 | [21-subagent-foreground](notes/21-subagent-foreground.md) |
| 22 | [`22-subagent-background.ts`](examples/22-subagent-background.ts) | 常驻 subagent：生成、steer、停止、列出，答案回报给父会话，重启安全 | 文档记名字→会话；Anchor 后台任务让子会话越过主 agent 边界；Reporter 两阶段 + requestId + `reported[]`；`replay: "unsafe"` 的理由 | 通过 | 上游工具结果用 `content`（改成本地 `output`）；`exactOptionalPropertyTypes` 下 checkpoint 省略空字段 | [22-subagent-background](notes/22-subagent-background.md) |
| 23 | [`23-child-tasks.ts`](examples/23-child-tasks.ts) | 一个 checkout 拥有并等待四笔支付：failFast、abort、重启 | 子任务 `ownership: task`；建任务+等待一次提交；三种 join policy；`failFast` 不带走父；abort 先子后父；`watchTaskGraph` 看树 | 通过 | | [23-child-tasks](notes/23-child-tasks.md) |
| 24 | [`24-compaction.ts`](examples/24-compaction.ts) | 长对话压缩：后台、手动、上下文溢出后 | 三条触发路径；摘要是 `pi.compaction` 条目 + `head` 标记；手动压缩排队放置；`entries` 与 `context` 的区别 | 通过 | | [24-compaction](notes/24-compaction.md) |
| 25 | [`25-coding-agent.ts`](examples/25-coding-agent.ts) | CodingTools、settings 对象提供的实时设置、跟随会话目录的 environment | 五块零件的组装；getter 设置每次读取；env 工厂跟随会话 cwd；用 `bash pwd` 做自检回路；产品化缺口清单 | 通过 | | [25-coding-agent](notes/25-coding-agent.md) |
| 26 | [`26-plan-mode.ts`](examples/26-plan-mode.ts) | 只读 plan 模式，作为带自己 document 的扩展，用 `configure()` 切换 | 模式=改 agent（扩展 `add` + 工具绝对列表）；`null` 清回默认；切换落成 `pi.system` 补丁；`submit_plan` 用 `control.terminate` 收尾 | 通过 | | [26-plan-mode](notes/26-plan-mode.md) |
| 27 | `27-reviewer.ts` | 自带 model、扩展、工具、目录的 reviewer 会话与评审循环 | — | 未做 | | |
| 28 | [`28-sandbox-per-conversation.ts`](examples/28-sandbox-per-conversation.ts) | 每会话一个 environment，从 app document 里查 | `env` 可异步、带 `conversationId` + 已提交 `read`；返回 `undefined` = 没有环境（工具干净失败）；`init` 在创建提交里写记录；`fork: initial` 不继承沙箱 | 通过 | | [28-sandbox-per-conversation](notes/28-sandbox-per-conversation.md) |
| 29 | [`29-tool-override.ts`](examples/29-tool-override.ts) | 部分会话换用同名 bash，再包一层给胜出的 bash 计时 | 同名工具按选中顺序替换（后者赢、位置不变）；`wrapTool` 按名字装饰、不捕获对象；包装器必须透传 park | 通过 | | [29-tool-override](notes/29-tool-override.md) |
| 30 | [`30-reload-and-restart.ts`](examples/30-reload-and-restart.ts) | 调用进行中重载扩展；存储的选择跨重启存活 | 扩展身份是名字；快照在阶段边界切换；重启后未安装则解析为空；改名即静默丢失 | 通过 | | [30-reload-and-restart](notes/30-reload-and-restart.md) |
| 31 | [`31-transcript.ts`](examples/31-transcript.ts) | 客户端 transcript 走 windowed view：实时追加、带 gap 的停顿、加载与更早分页、用 `from` 续读 | 窗口 `min`/`max`；`ConversationTranscript.merge` 只增不改；`gap`/`earlier` 两类标记；`resume` 靠 `from` 续上；`fillGap` 一页一页补 | 通过 | | [31-transcript](notes/31-transcript.md) |
| 32 | [`32-tests-after-edits.ts`](examples/32-tests-after-edits.ts) | `afterRun` 钩子在改过文件的 run 之后跑测试，失败则发起修复 run，输入等它们 | `afterRun` 在答案之后、把任务挂进 `run.afterRun`；按 `run.first`/`last` 扫条目判断改动；`hookTask`；提交里 `admit` 修复输入 + `requestId` 幂等；循环刹车 | 通过 | | [32-tests-after-edits](notes/32-tests-after-edits.md) |
| 33 | [`33-turn-limit-and-continue.ts`](examples/33-turn-limit-and-continue.ts) | 每会话 turn 上限、`runFailure`、不带用户消息继续 | `maxTurns` 存会话 agent；`turn_limit` 是可恢复停止；`continue` 重置预算且不排队；`nothing_to_answer` | 通过 | | [33-turn-limit-and-continue](notes/33-turn-limit-and-continue.md) |
| 34 | [`34-submit-in-commit.ts`](examples/34-submit-in-commit.ts) | 用 `admit(tx, draft)` 与 `whenIdle: "reject"` 在宿主自己的 commit 内接纳 visitor 的 steer | 检查+接纳+自有写入原子；拒绝发生在任何写入前；`admit` 必须先于表写入；`requestId` 幂等；`ConversationIdle` | 通过 | | [34-submit-in-commit](notes/34-submit-in-commit.md) |
| 35 | [`35-durable-on-the-store.ts`](examples/35-durable-on-the-store.ts) | Harness 建在 Chord 宿主 store 的 `StoreStorage` 上，与 Chord 对象自己的表并存：一个 commit 队列、一个 id 分配器、一次导出 | `self.open` 宿主级资源；`StoreStorage.open(store, ownerName)` 按 owner 归属；两边的提交各占一个 seq；`store.export()` 一次带走 | 通过 | | [35-durable-on-the-store](notes/35-durable-on-the-store.md) |
| 36 | `36-durable-views.ts` | Chord 对象用 `self.follow` 跟一个 Durable view：帧，以及成员读取跟到的值 | — | 未做 | | |
| 37 | `37-harness-registry.ts` | Harness 放在 Chord 对象里：扩展经 Chord registry 贡献，Harness 关闭时 follower 迁到下一个 | — | 未做 | | |
| 38 | [`38-signals.ts`](examples/38-signals.ts) | `defineSignal()`、`harness.signal()` 的每种结果、提前到的信号立刻唤醒 sleep | 信号的 name/version/schema；五种投递结果；睡在 key 上、唤醒即消费；`wake()` 的宿主视角 | 通过 | | [38-signals](notes/38-signals.md) |
| 39 | [`39-ask-a-person.ts`](examples/39-ask-a-person.ts) | task 睡在一个人的回答上并带 deadline：先答，再过期且迟到回答被拒；睡眠中 `wake()` | 信号 + `until` 同时挂；`reason` 决定走哪条；时钟注入；过期后迟到值 `closed`；问题内容归宿主存 | 通过 | | [39-ask-a-person](notes/39-ask-a-person.md) |
| 40 | [`40-tool-waits-for-webhook.ts`](examples/40-tool-waits-for-webhook.ts) | CI 工具落在自己 webhook 的 signal 上：park 前崩溃（幂等 memo）与 park 中被 Stop（`cancel`） | 工具三段式；`replay: "safe"` + memo 幂等键；先登记回调再触发；park 不占进程；`cancel` 两种情况 | 通过 | | [40-tool-waits-for-webhook](notes/40-tool-waits-for-webhook.md) |
| 41 | `41-tool-polls.ts` | 按时间 park，带退避地轮询一个慢任务 | — | 未做 | | |
| 42 | [`42-parallel-children.ts`](examples/42-parallel-children.ts) | `executeTool(..., { wait: false })` 与 `policy: "any"` 的 park，跨唤醒按 key 收结果 | `executeTool` 不等待 + `{kind:"wait",on,policy:"any"}`；key 跨唤醒重连；累积 `wake.ended`；`nestedTools` 可见；零进程扇出 | 通过 | | [42-parallel-children](notes/42-parallel-children.md) |
| 43 | [`43-subagent-waits.ts`](examples/43-subagent-waits.ts) | subagent 工具 park 在 `SubmissionSettled`（`notify`）上，子会话 park 在人身上 | `notify` 在结算提交里投内建信号；父调用零进程等待；醒来按条目 ID 读答案；失败变成错误结果 | 通过 | | [43-subagent-waits](notes/43-subagent-waits.md) |
| 44 | [`44-approval-gate.ts`](examples/44-approval-gate.ts) | 以参数为 key、deadline 带 memo 的 `beforeTool` 审批闸，加一道每次唤醒都重问的闸，以及拒绝与过期 | 闸门三种返回；`sleep` 重跑 call 阶段；参数摘要当 key；deadline 必须 memo；拒绝/超时都是错误结果 | 通过 | `noUncheckedIndexedAccess` 下 Map 展开要断言 | [44-approval-gate](notes/44-approval-gate.md) |
| 45 | [`45-review-on-yield.ts`](examples/45-review-on-yield.ts) | `onYield` 审查 task，`{ continue }` 把 agent 送回去；排队的用户消息胜出 | 答案先提交、输入保持 `placed`；`run.yield.answer` 供审查；打回重置轮数并再审；`takesContinuation` 让用户输入优先 | 通过 | | [45-review-on-yield](notes/45-review-on-yield.md) |
| 46 | [`46-after-tools-terminate.ts`](examples/46-after-tools-terminate.ts) | `afterTools` task 问人是否继续：一次 steer，然后 `{ terminate: true }` | 轮内检查点；`terminate` 省掉下一次请求；steer 在终结提交里放行；任务睡信号期间零进程；`oneOf` schema | 通过 | | [46-after-tools-terminate](notes/46-after-tools-terminate.md) |
| 47 | [`47-fit-images.ts`](examples/47-fit-images.ts) | 存储前把图片适配模型上限：`fitImage` 附照片、`fit-images` 扩展处理工具截图 | 入库前适配的理由（不可变 + prompt cache）；两个入口；`omitted`/`notes` 结果；`imageLimits(model)`；Photon 在 worker 线程 | 通过 | | [47-fit-images](notes/47-fit-images.md) |

## 之后：底层各层 00–12

| 序 | 文件 | 关键机制 | 状态 | 笔记 |
|---|---|---|---|---|
| 00 | `00-conversation.ts` | — | 未做 | |
| 01 | `01-documents.ts` | — | 未做 | |
| 02 | [`02-forks.ts`](examples/02-forks.ts) | `forkConversation` 从条目分叉；`defineDoc` 的 history/fork 组合决定文档继承哪一刻；条目不复制 | 通过 | [02-forks](notes/02-forks.md) |
| 03 | `03-owned-conversations.ts` | — | 未做 | |
| 04 | `04-watches.ts` | — | 未做 | |
| 05 | `05-harness.ts` | — | 未做 | |
| 06 | `06-configuration.ts` | — | 未做 | |
| 07 | `07-harness-conversations.ts` | — | 未做 | |
| 08 | [`08-context.ts`](examples/08-context.ts) | 条目→请求消息的五条推导规则：`head` 开新上下文、`edits` 替换、中断/报错不发、工具结果按调用顺序、缺结果补合成错误 | 通过 | [08-context](notes/08-context.md) |
| 09 | [`09-registry-reload.ts`](examples/09-registry-reload.ts) | 重载是同名原地替换（一次发布）；`wrapTool` 按名字环绕、随被环绕工具重载仍生效；`uninstall` 静默降级 | 通过 | [09-registry-reload](notes/09-registry-reload.md) |
| 10 | [`10-extension-state.ts`](examples/10-extension-state.ts) | 扩展自有状态用文档；工具 `tx.doc` 首次写即创建；段落 `input.read.snapshot` 缺省当默认；`pi.system` 只追加变化 | 通过 | [10-extension-state](notes/10-extension-state.md) |
| 11 | `11-tasks.ts` | — | 未做 | |
| 12 | [`12-recovery.ts`](examples/12-recovery.ts) | `defineTask` 阶段状态机；检查点 + `memo` 幂等；`sleepUntil`；关掉重开继续 | 通过 | [12-recovery](notes/12-recovery.md) |

## 对应笔记

`../docs/3-appendix/3-source-map.md` 里有文档章节 ↔ 示例的对应表；讲某个示例时可以顺着它的源码入口往下看。
