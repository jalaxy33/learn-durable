# 源码与示例索引

> 不锁行号：行号会随版本漂移。用章节名、示例编号、源码文件名定位。

版本：pi-durable **v1.6.1**。

## 1. 文档 ↔ README 章节

| 文档 | 主要对应的 README 章节 |
|---|---|
| `1-core/1-foundations` | Concepts、Persist and Resume、Failures and Recovery、Signals |
| `1-core/2-capabilities` | Extensions、Tools、Code Mode、System Prompt、Per-Conversation Agent、Settings、Environment |
| `1-core/3-control` | Busy Conversations、Reset and Handoff、Compaction、Hooks |
| `1-core/4-orchestration` | More Conversations and Forks、Abort and Subagents、Child Tasks、Task Graph |
| `1-core/5-runtime` | Your Own State、Usage and Cost、Storage、Errors、Watching a Conversation |
| `2-architecture/1-durable-vs-pi` | 无（对照 Pi 文档） |
| `2-architecture/2-extending` | Extensions（结合 Pi 的 extensions.md） |
| `2-architecture/3-deployment` | Storage、Persist and Resume（结合 pi-env 文档） |
| `2-architecture/4-building-an-agent` | Examples、Tools、Environment |

## 2. 文档 ↔ 官方示例

| 文档 | 示例 |
|---|---|
| `1-foundations` | `00-conversation`、`13-chat`、`16-coding-tools`、`38-signals`、`39-ask-a-person` |
| `2-capabilities` | `16-coding-tools`、`25-coding-agent`、`29-tool-override`、`38-signals`、`40-tool-waits-for-webhook`、`47-fit-images` |
| `3-control` | `19-inbox`、`24-compaction`、`32-tests-after-edits`、`33-turn-limit-and-continue`、`44-approval-gate`、`45-review-on-yield`、`46-after-tools-terminate` |
| `4-orchestration` | `21-subagent-foreground`、`22-subagent-background`、`23-child-tasks`、`42-parallel-children`、`43-subagent-waits` |
| `5-runtime` | `18-json`、`20-late-join`、`24-compaction`、`31-transcript`、`35-durable-on-the-store` |

运行方式（在 pi 仓库的 `packages/durable` 下）：

```bash
node --conditions=source --experimental-strip-types test/examples/13-chat.ts
```

大多数示例用 faux provider；需要真模型的示例要 `OPENAI_API_KEY`。

## 3. 文档 ↔ 源码入口

| 主题 | 源码 |
|---|---|
| Harness / Session / 提交 | `packages/durable/src/harness/harness.ts`、`session/` |
| 生成 / run 状态机 | `packages/durable/src/harness/generation.ts` |
| 工具 task / 嵌套调用 / park | `packages/durable/src/harness/tool.ts` |
| 输入 / inbox / submission | `packages/durable/src/harness/submissions.ts`、`inbox.ts` |
| 压缩 | `packages/durable/src/harness/compaction.ts` |
| 提示词 / section | `packages/durable/src/harness/prompt.ts` |
| 视图 / watch | `packages/durable/src/harness/view.ts` |
| 任务定义 / 状态机 | `packages/durable/src/tasks.ts` |
| entry 类型 | `packages/durable/src/entries.ts` |
| 文档定义 | `packages/durable/src/documents.ts` |
| signal | `packages/durable/src/signals.ts` |
| 存储 | `packages/durable/src/storage/` |
| 执行环境 | `packages/durable/src/env/` |
| 内置工具 | `packages/durable/src/tools/` |
| code mode 扩展 | `packages/durable/src/codemode/` |

## 4. v1.6.0 与 v1.6.1 的差异

v1.6.1（2026-11-25）把原先在 main 上的 "Unreleased" 改动作了发布。全部是**返回值形状**：隐式联合改成带 `kind` 的标签联合，没有机制变化。

| 位置 | v1.6.0 | v1.6.1 |
|---|---|---|
| park 返回值 | `{ sleep: {...} }` / `{ wait: {...} }` | `{ kind: "sleep", ... }` / `{ kind: "wait", ... }` |
| signal 状态 | `{ value }` / `{ expired: true }` | `{ kind: "value", value }` / `{ kind: "expired" }` |
| `onYield` 结果 | `{ continue: "..." }` | `{ kind: "continue", continue }` |
| 事务内受理 | `submit(tx, draft)` | `admit(tx, draft)`（`submit(draft, context)` 不变） |
| `beforeCompact` | `{ decline: true }` / `{ summary }` | `{ kind: "decline" }` / `{ kind: "summary", summary }` |
| `Wrap` | 无标签 | `{ kind: "tool" }` / `{ kind: "section" }`（用 `wrapTool()` / `wrapSection()` 构造） |
| `Storage.commit()` 结果 | `{ stored, refused? }` | `{ kind: "stored", stored }` / `{ kind: "refused", stored, refused }` |
| 事务内会话受理 | `handle.submit(tx, draft)` | `handle.admit(tx, draft)` |

判定方式跟着变：`state?.kind === "value"`、`returned.kind === "sleep"`、`result.kind === "refused"`。别再用 `"value" in state` 这类形状探测。

v1.6.1 同时带两个与接口无关的修复：`NodeExecutionEnv` 在 Windows 上通过 `PATH` 的 `git.exe`（`git var GIT_SHELL_PATH`，Git 2.47+）找 Git Bash；Node 环境的行读取器不再对每个 chunk 重扫未完成行（长行从平方降到线性）。

写代码时以 v1.6.1 为准；读 v1.6.0 时代的代码时按上表对照。

## 5. 文档怎么维护

README 变化时：

1. 先更新 `upstream/` 快照和 `VERSIONS.md`；
2. 只改受影响的章节，不重写整篇；
3. 代码块检查版本标注（v1.6.1 / v1.6.0）；
4. 自检题和答案同步改；
5. 不引入行号；需要精确定位时更新本文件的表格。

## 6. 官方示例验证

### 6.1 方法

- 示例源码取自 v1.6.0 的 `packages/durable/test/examples`（`lab/` 里按 v1.6.1 重跑过 12–19）。
- 用 npm 安装 `pi-durable@1.6.1`、`pi-ai@1.6.1`、`chord@1.6.1`、`pi-schema@1.6.1`、`@silvia-odwyer/photon-node@0.3.4`。
- 只把 `../../src/...` 改成包路径（根、`/tools`、`/env/node`、`/storage/...`、`/images/...`），其余代码不动。
- Node 26.13.1，`node --experimental-strip-types`，每个示例 45 秒超时，cwd 是临时目录。
- 结果：**48 个示例中 47 个实际跑通；示例 15 因未设置 `OPENAI_API_KEY` 主动跳过**。

这不是仓库的测试套件，只是“文档里的说法在发布版上成立”的冒烟验证。

### 6.2 覆盖表

| 示例 | 覆盖 | 结果摘要 |
|---|---|---|
| 00-conversation | Session + 创建会话 | 输出 `standalone conversation: { id }` |
| 01-documents | 文档、`snapshotAsOf` | latest / 两个历史值都对上 |
| 02-forks | fork 的文档策略 | fork 独立，父会话不变 |
| 03-owned-conversations | 会话归属 + 注册表 | 子会话 owner 指向 supervisor task |
| 04-watches | watch 的初始值/折叠 | 两次更新，listener 调用 2 次 |
| 05-harness | Harness 根会话、agent 解析 | root notes / stored agent / resolved |
| 06-configuration | `configure` + 默认工具 | 工具列表随配置变化 |
| 07-harness-conversations | 多会话、agent 继承 | fork 的 thinking 独立 |
| 08-context | 上下文编辑/omit | 原始 entries 与请求消息不同 |
| 09-registry-reload | 同名替换、卸载 | reload 后描述变化，卸载后恢复 |
| 10-extension-state | 扩展文档 | todo 状态进 system section |
| 11-tasks | 自定义 task | `completed` + result |
| 12-recovery | 关闭/恢复/checkpoint | tick 2 的 checkpoint 恢复后继续 tick 3 |
| 13-chat | Quick Start | `Paris.`，transcript 含 `pi.system` |
| 14-system-prompt | sections/instructions | root 与子会话的 system sections 不同 |
| 15-real-model | OpenAI 流式 | **skipped：无 `OPENAI_API_KEY`** |
| 16-coding-tools | read/write/edit/bash | 读取、编辑、缺失文件错误都出现 |
| 17-print | print 模式 | 输出最终答案 |
| 18-json | 视图 + ops | 逐条 JSON 输出 view/ops |
| 19-inbox | follow-up/steer/write/撤回 | inbox 只排 followUp/steer；note 立刻出现 |
| 20-late-join | 中途 attach | 工具输出与流式文本逐步可见 |
| 21-subagent-foreground | 前台 subagent | 子会话回答 `2, 3, and 5` |
| 22-subagent-background | 后台 subagent | spawn 后父会话继续，答案回投 |
| 23-child-tasks | child tasks + failFast | `aborted, failed, aborted, aborted` |
| 24-compaction | 后台/手动/溢出压缩 | 上下文消息数与存储 entry 数分离 |
| 25-coding-agent | CodingTools + cwd | 切目录后 bash 在新目录跑 |
| 26-plan-mode | 扩展 + 文档 + configure | 工具集在 plan mode 收窄后恢复 |
| 27-reviewer | 独立 reviewer 会话 | 两轮 review 循环 |
| 28-sandbox-per-conversation | 每会话 env | alice/bob 各自沙箱 |
| 29-tool-override | 同名工具 + wrap | 会话选择不同 bash；计时器生效 |
| 30-reload-and-restart | 热替换 + 重启 | 运行中 v1，下一次 v2；重启后需重装 |
| 31-transcript | 窗口/缺口/补页 | `load earlier` / `load more` 出现并补齐 |
| 32-tests-after-edits | `afterRun` | `wait` 先 done，测试任务后跑，再触发 fix run |
| 33-turn-limit-and-continue | `maxTurns` + continue | `turn_limit` 后 continue 可完成 |
| 34-submit-in-commit | 事务内受理 | 禁言检查、入队、日志同一提交 |
| 35-durable-on-the-store | StoreStorage + Chord 表 | 同一 seq/manifest，两种数据共存 |
| 36-durable-views | Chord 跟随 view | frames 与 member value 更新 |
| 37-harness-registry | Chord registry + 冲突 | `registry_conflict` 被报告，正常 greet 完成 |
| 38-signals | 信号五种结果 | delivered/duplicate/invalid/not_found/closed |
| 39-ask-a-person | 等人 + 超时 | `wake` 显示截止时间，超时后拒绝迟到答案 |
| 40-tool-waits-for-webhook | 工具 park + memo | 崩溃前/后都只有 `build-1`；slot 是 sleeping |
| 41-tool-polls | 时间 park + 退避 | `asleep until 1s/3s/7s` |
| 42-parallel-children | `wait:false` + `policy:any` | 两个嵌套调用同时 sleeping，按 key 收结果 |
| 43-subagent-waits | `notify` + 子会话 park | 父/子都 sleeping，`wake active:false`，答复后 done |
| 44-approval-gate | `beforeTool` gate | 批准执行；拒绝/超时变 blocked；gate 重跑 2 次 |
| 45-review-on-yield | `onYield` 审查 | 打回一次，通过后输入 done |
| 46-after-tools-terminate | `afterTools` + terminate | 两轮询问，run 在第二轮后结束 |
| 47-fit-images | `fitImage` + fit-images 扩展 | 4000x3000→1000x750，3000x1000→1000x333 |

### 6.3 其他观察

- `ConversationId` / `SubmissionId` / `EntryId` 都是**数字**，不是字符串。
- `harness.commit(tx => root.admit(tx, draft))` 可用；`harness.submission(id)` 能找回。
- `watch().value` 顶层是 `conversation` / `entries` / `docs`；`docs` 含 `pi.agent`、`pi.live`、`pi.inbox`、`pi.provider`、`pi.usage`。
- 未装 section 时没有 `pi.system`（13 装了 section，所以有）。
- 示例 16/18 的输出会受运行目录影响（读不到 `/tmp/1gb.txt`、`ls` 列出临时目录），这是环境差异，不是失败。

未覆盖：真实 OpenAI 流式、Cloudflare/IndexedDB 后端、分布式多机通信。仍以 README 和源码为准。
