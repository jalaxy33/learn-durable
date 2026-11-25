// a chat turn

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  section,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

// fauxProvider 创建一个假的 API 提供商
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Paris.")]); // 预置应答队列

const registry = createRegistry();
registry.install(
  defineExtension({
    name: "terse",
    sections: [section("preamble", () => "Your answer in one word.", { tag: false })],
  }),
);
// 第一个参数指定用什么存储，MemoryStorage表示存在内存上
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

// submit 提交一条记录，不直接返回回答
const capital = await root.submit(
  { type: "input", content: "Capital of France?" },
  context,
);
const answered = await capital.wait(context); // 回答在 wait 后返回
if (answered.status === "done" && answered.type === "input") {
  const entry = await root.commit(
    // tx.entry 是读不是写
    //   第一个参数是token，带类型（如AssistantEntry，UserEntry）
    //   第二个参数是条目 id（answer不是回答，是一个id）
    (tx) => tx.entry(AssistantEntry, answered.answer),
    context,
  );
  const reply = entry?.model?.[0];
  console.log("answer:", reply?.role === "assistant" ? reply.content : reply);
}

// transcript 记录了用户输出、系统提示词、模型回答
const transcript = await root.entries({}, 10, undefined, context);
console.log(
  "transcript:",
  [...transcript.items].reverse().map((entry) => entry.kind),
);
await harness.close(context);

/*
预期输出：
answer: [ { type: 'text', text: 'Paris.' } ]
transcript: [ 'pi.user', 'pi.system', 'pi.assistant' ]
*/
