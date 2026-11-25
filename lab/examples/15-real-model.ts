import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  Harness,
  LiveDoc,
  MemoryStorage,
  section,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

if (process.env.DEEPSEEK_API_KEY === undefined) {
  console.log("skipped: DEEPSEEK_API_KEY is not set.");
} else {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "concise",
      sections: [
        section("preamble", () => "You are a concise assistant.", { tag: false }),
      ],
    }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, {
    agent: {
      model: { provider: "deepseek", modelId: "deepseek-flash" },
      thinkingLevel: "high",
    },
  });
  const liveWatch = (await harness.watchDoc(LiveDoc, root.id, context))!; // ! 是 ts 的非空断言
  // Print only what each committed partial adds to the text printed so far.
  let printed = "";
  const printText = (text: string): void => {
    if (text.length <= printed.length || !text.startsWith(printed)) return;
    process.stdout.write(text.slice(printed.length));
    printed = text;
  };
  // 顺序：
  // 1. 先启动 watchDoc
  liveWatch.start(async (call) => {
    if (call.kind !== "value") return;
    const { value } = call;
    const block = value?.generation?.message?.content.find(
      (content) => content.type === "text",
    );
    if (block?.type === "text") printText(block.text);
  });
  // 2. resume harness
  harness.resume();
  process.stdout.write("answer: ");
  // 3. 之后才submit
  const poem = await root.submit(
    { type: "input", content: "Write a long poem" },
    context,
  );
  const settledPoem = await poem.wait(context);
  // 4. 停止 watchDoc
  await liveWatch.stop();
  if (settledPoem.status === "done" && settledPoem.type === "input") {
    const entry = await root.commit(
      (tx) => tx.entry(AssistantEntry, settledPoem.answer),
      context,
    );
    const message = entry?.model?.[0];
    const block =
      message?.role === "assistant"
        ? message.content.find((content) => content.type === "text")
        : undefined;
    if (block?.type === "text") printText(block.text);
    // process.stdout.write 不换行，逐段输出，末尾手动补一个换行符
    // 和 console.log 混用时需要注意顺序（例子先 write("answer: ") 再流式）
    process.stdout.write("\n");
  } else {
    console.log("unanswered:", settledPoem.reason, settledPoem.detail);
  }

  await harness.close(context);
}

/*
预期输出：
```
answer:
// 等待模型输出一首英文长诗...
```
*/
