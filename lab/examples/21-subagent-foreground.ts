import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type LiveState,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

const context = BACKGROUND_CONTEXT;

// ─── Product code: the subagent extension ───────────────────────────────────

async function answerText(
  api: ToolExecutionApi,
  answer: EntryId,
  callContext: Context,
): Promise<string> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), callContext);
  const message = entry?.model?.[0] as AssistantMessage;
  return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const Subagent: Extension = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description:
        "Delegate a self-contained task to a subagent and get its answer back.",
      parameters: obj({ task: str({ description: "What the subagent should do" }) }),
      replay: "safe",
      execute: async (args, api, callContext) => {
        const { task } = args;
        // The child is owned by this tool call's task, so aborting the call aborts the child
        // and the call finishes only once the child's work is done.
        const child = await api.commit(async (tx) => {
          // 记录 child 的所属权，根据 taskId 识别
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1))
            .items[0];
          if (existing !== undefined) return existing.id;
          // 创建当前 agent 的副本（model, thinking level, cwd, extensions, tools）
          const created = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          });
          // child不能继续创建subagent
          await configure(tx, created.id, { extensions: { remove: [Subagent] } });
          return created.id;
        }, callContext);
        // A UI watching the parent sees this and can attach to the child.
        await api.details({ conversationId: child }, callContext);

        const handle = (await api.conversation(child, callContext))!;
        // request ID 的作用：在崩溃重启后根据 request ID 来拿回原来的提交
        const request = {
          type: "input",
          content: task,
          requestId: `subagent:${api.taskId}`,
        } as const;
        const settled = await (
          await handle.submit(request, callContext)
        ).wait(callContext);
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`Subagent failed: ${settled.status}`);
        }
        const text = await answerText(api, settled.answer, callContext);
        return { output: [{ type: "text", text }], details: { conversationId: child } };
      },
    }),
  ],
});

// ─── Host setup ─────────────────────────────────────────────────────────────

const models = createModels();
let model = { provider: "deepseek", modelId: "deepseek-flash" };
if (process.env.DEEPSEEK_API_KEY !== undefined) {
  models.setProvider(deepseekProvider());
} else {
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  model = { provider: "faux", modelId: "faux-1" };
  const delegate = fauxToolCall(
    "subagent",
    { task: "Name three prime numbers." },
    { id: "call-1" },
  );
  faux.setResponses([
    fauxAssistantMessage([delegate], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("2, 3, and 5.")]),
    fauxAssistantMessage([fauxText("The subagent says: 2, 3, and 5")]),
  ] satisfies FauxResponseStep[]);
}
const registry = createRegistry();
registry.install(Subagent);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model } });

// ─── UI: the parent's transcript, with each subagent's indented under its call ───

/** Print an assistant entry's text and tool calls. */
const print = (indent: string, entry: EntryRecord): void => {
  const message = entry.model?.[0];
  if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return;
  for (const block of (message as AssistantMessage).content) {
    if (block.type === "text" && block.text !== "")
      console.log(`${indent}assistant: ${block.text}`);
    if (block.type === "toolCall")
      console.log(`${indent}tool ${block.name}(${JSON.stringify(block.arguments)})`);
  }
};
const attached = new Set<ConversationId>();
const attach = async (id: ConversationId, indent: string): Promise<void> => {
  attached.add(id);
  const watch = await (await harness.conversation(id, context))!.watch(context);
  let newest = watch.value.entries.at(-1)?.id ?? 0;
  watch.start(async (call) => {
    if (call.kind !== "value") return;
    const { value } = call;
    for (const entry of value.entries) if (entry.id > newest) print(indent, entry);
    newest = value.entries.at(-1)?.id ?? newest;
    // A running subagent call
    for (const slot of (value.docs["pi.live"] as LiveState).tools ?? []) {
      const child = (slot.details as { conversationId?: ConversationId } | undefined)
        ?.conversationId;
      // child 的缩进多两个空格
      if (child !== undefined && !attached.has(child)) await attach(child, `${indent}  `);
    }
  });
};
await attach(root.id, "");

const submission = await root.submit(
  {
    type: "input",
    content:
      "Use the subagent tool to find three prime numbers, then tell me what it said.",
  },
  context,
);
await submission.wait(context);
await harness.waitForIdle(context);
await new Promise((r) => setTimeout(r, 0));
await harness.close(context);

/*
预期输出（未设 DEEPSEEK_API_KEY，走 faux）：
tool subagent({"task":"Name three prime numbers."})
  assistant: 2, 3, and 5.
assistant: The subagent says: 2, 3, and 5

设了 DEEPSEEK_API_KEY 时走真模型，措辞不固定，但结构相同：
父的 tool 行、缩进的子会话 assistant、父的最终回答。
*/
