# 术语表

> 首次出现用英文，括号里给中文；之后统一用英文，避免同义词混用。

版本：pi-durable **v1.6.1**。

## 核心对象

| 术语 | 中文 | 一句话 | 参见 |
|---|---|---|---|
| Harness / Session | 运行器 / 会话 | 一个打开的存储 + 跑在上面的机器 | [foundations](../1-core/1-foundations.md) |
| Conversation | 会话 | 一段 transcript；句柄无状态，按 `id` 比较 | foundations |
| Entry | 记录 | 不可变的一条事实（`pi.user`、`pi.assistant`…） | foundations |
| Document | 文档 | 带类型的 JSON 状态，只能在 commit 里改 | `1-core/5-runtime.md` |
| Commit | 提交 | 原子写：entry + document + task 状态一起 | foundations |
| Task | 任务 | 持久状态机，每步存 checkpoint | foundations |
| Submission | 提交句柄 | 交给会话的输入，可以 `wait`、`abort` | foundations |
| Turn | 轮 | 一次模型回复 + 它的工具调用 | foundations |
| Run | 运行 | 从一条输入到最终答案之间的所有 turn | foundations |
| Busy | 忙 | 有 run 正在处理输入 | `1-core/3-control.md` |

## 配置与扩展

| 术语 | 中文 | 一句话 | 参见 |
|---|---|---|---|
| Extension | 扩展 | 具名的能力包：tools/sections/hooks/wraps/tasks | `1-core/2-capabilities.md` |
| Registry | 注册表 | **本进程**安装了哪些扩展；不存储 | `1-core/2-capabilities.md` |
| Agent | 代理配置 | 会话运行所需的选择：模型、工具、指令、cwd | `1-core/2-capabilities.md` |
| Settings | 运行策略 | 进程级、每次读、不存储 | `1-core/2-capabilities.md` |
| Section | 提示词片段 | 系统提示词的一段，渲染函数返回文本 | `1-core/2-capabilities.md` |
| Hook | 钩子 | 挂在内置 task 阶段上的逻辑 | `1-core/3-control.md` |
| Wrap | 装饰器 | 按名字装饰一个工具或 section | `1-core/2-capabilities.md` |
| Tool | 工具 | 模型/程序可调用的能力，每次调用是一个 task | `1-core/2-capabilities.md` |
| Namespace | 命名空间 | 把一组工具分组，供 code mode 展示 | `1-core/5-runtime.md` |

## 执行细节

| 术语 | 中文 | 一句话 | 参见 |
|---|---|---|---|
| Phase | 阶段 | task 的一个可重跑步骤；崩溃后从头再跑 | foundations |
| Checkpoint | 检查点 | phase 之间传递的 JSON；重跑的起点 | foundations |
| Ownership | 所有权 | task 属于会话或另一个 task | `1-core/4-orchestration.md` |
| Owner | 所有者 | 创建并拥有某个 task/会话的 task | `1-core/4-orchestration.md` |
| Task Graph | 任务图 | 所有 live task 及其 owner 边 | `1-core/4-orchestration.md` |
| Park | 停放 | 工具主动结束本次调用，等唤醒后重跑 | `1-core/2-capabilities.md` |
| Sleep | 睡眠 | task 等时间/信号，不占进程 | foundations |
| Wait | 等待 | task 等自己拥有的子 task | `1-core/4-orchestration.md` |
| Signal | 信号 | 外部投递给某个 task key 的 JSON 值 | foundations |
| Wake | 唤醒原因 | `time` / `expired` / `signal` / `tasks` | foundations |
| `SubmissionSettled` | 提交结算信号 | submission 结束时投给指定 task 的记录 | foundations |
| Replay | 重放 | 崩溃后按策略重跑工具 | `1-core/2-capabilities.md` |
| `restartLimit` | 重启上限 | 连续崩溃多少次后放弃（默认 5） | foundations |
| `abandonOnRestart` | 重启即放弃 | 重启后 abort 这个 task 及其子树 | `1-core/2-capabilities.md` |

## 状态与存储

| 术语 | 中文 | 一句话 | 参见 |
|---|---|---|---|
| Scope | 作用域 | document 的地址：session / conversation / task | `1-core/5-runtime.md` |
| History | 历史 | `latest` 只留最新；`rewindable` 可读旧值 | `1-core/5-runtime.md` |
| Fork | 分叉 | 从某个 entry 复制出一个独立会话 | `1-core/4-orchestration.md` |
| Retire | 退休 | 文档被删除/结束，watch 收到 `retired` | `1-core/5-runtime.md` |
| Deferred commit | 延迟提交 | 先在内存可见，稍后落盘（有丢失窗口） | `1-core/5-runtime.md` |
| Watch / View | 观察 / 视图 | 已提交状态的当前快照 + 增量 ops | `1-core/5-runtime.md` |
| Observer | 观察者 | 同步、不可 await 的变更回调 | `1-core/5-runtime.md` |
| Compaction | 压缩 | 摘要旧 entry + 保留近期原文 | `1-core/3-control.md` |
| Reset | 重置 | 划一条新上下文边界，旧 entry 仍保留 | `1-core/3-control.md` |
| Handoff | 交接 | 工具写入 reset 文本，但当前 run 继续 | `1-core/3-control.md` |

## 环境与工具

| 术语 | 中文 | 一句话 | 参见 |
|---|---|---|---|
| ExecutionEnv | 执行环境 | 工具接触文件/进程的唯一入口 | `2-architecture/3-deployment.md` |
| Code mode | 代码模式 | 模型写 JS，在沙箱里调工具 | `1-core/5-runtime.md` |
| Tool search | 工具搜索 | 让模型搜索并按需加载 deferred 工具 | `1-core/2-capabilities.md` |
| Deferred tool | 延迟工具 | 不默认出现在模型菜单里 | `1-core/2-capabilities.md` |
| `callers` | 调用者限制 | 工具允许谁调：`model` / `tools` | `1-core/2-capabilities.md` |
| `modelTools` | 模型工具集 | 只收窄模型能看见的工具 | `1-core/2-capabilities.md` |
| `structuredOutput` | 结构化输出 | 给程序调用的返回值，不存 transcript | `1-core/2-capabilities.md` |
| `details` | 详情 | 给 UI 的附加信息，不发给模型 | `1-core/2-capabilities.md` |
| Diagnostics | 诊断 | 工具结果里的结构化错误说明 | `1-core/2-capabilities.md` |

## 最容易混的八组词

| 对比 | 区别 |
|---|---|
| Turn vs Run | turn 是一轮回复；run 是多个 turn 组成的一次完整回答 |
| Submission vs Input | submission 是句柄；input 是它承载的内容/类型 |
| Entry vs Document | entry 不可变、只追加；document 可变、在 commit 里改 |
| Extension vs Registry | extension 是包；registry 是本进程安装了哪些包 |
| Sleep vs Park vs Wait | sleep 等时间/信号；park 是工具主动结束本次调用；wait 等子 task |
| Signal vs Notify | signal 是你投递值；notify 是让 submission 结算时自动投递 `SubmissionSettled` |
| Reset vs Compaction | reset 划新边界；compaction 摘要 + 保留近期原文 |
| Fork vs Reset | fork 是另一个会话、另一个 provider 身份；reset 是同一会话、同一身份 |
