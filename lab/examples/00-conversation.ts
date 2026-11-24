// 对应官方示例 00-conversation.ts（v1.6.0）；机制见 docs/1-core/1-foundations.md §3、README「Quick Start」
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Paris.")]);

const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry: createRegistry() },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

const submission = await root.submit(
  { type: "input", content: "What is the capital of France?" },
  context,
);
const settled = await submission.wait(context);
if (settled.status !== "done" || settled.type !== "input")
  throw new Error(`run ended: ${settled.status}`);

const answer = await root.commit(
  (tx) => tx.entry(AssistantEntry, settled.answer),
  context,
);
const message = answer?.model?.[0];
if (message?.role !== "assistant") throw new Error("no assistant message");

console.log("conversation:", root.id);
console.log(
  "answer:",
  message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(""),
);

await harness.close(context);

/*
预期输出：
conversation: 1
answer: Paris.

讲解：
- submit() 只受理，答案在 wait() 之后；两者之间进程被杀掉，工作仍在存储里继续。
- settled.answer 是数字形式的 EntryId，不是文本。
  文本在 pi.assistant 那条 entry 的 model 里，tx.entry() 是一次只读的一致性查。
- 两处 if 不是仪式：settled 是联合类型（done/unanswered × input/write/continue），
  message 是四种消息的联合；不收窄就拿不到字段。
*/
