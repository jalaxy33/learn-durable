import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  Harness,
  hook,
  ToolResultEntry,
  ToolTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools, type BashToolInput } from "@earendil-works/pi-durable/tools";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context = BACKGROUND_CONTEXT;
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
await writeFile(join(directory, "notes.txt"), "hello world\n");

// The faux provider plays the model: four tool-calling answers, then a final answer.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// setResponses预置模型的应答列表，每次生成请求取走一条
const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
faux.setResponses([
  toolCall("read", { path: "notes.txt" }, "r"),
  toolCall(
    "edit",
    { path: "notes.txt", edits: [{ oldText: "world", newText: "durable" }] },
    "e",
  ),
  toolCall("bash", { command: "cat notes.txt" }, "b"),
  toolCall("bash", { command: "cat /tmp/1gb.txt" }, "c"),
  fauxAssistantMessage([fauxText("The file now greets durable.")]),
]);

// 定义 hooks
// Hooks see every call before and after execution; these time the big `cat`.
const isBigCat = (call: { name: string; arguments: unknown }) =>
  call.name === "bash" && (call.arguments as BashToolInput).command.includes("1gb.txt");
let start = 0;
const Timing = defineExtension({
  name: "timing",
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => {
        if (isBigCat(call)) start = Date.now();
        return undefined;
      },
      afterTool: (call) => {
        if (isBigCat(call)) console.log(`cat /tmp/1gb.txt took ${Date.now() - start} ms`);
        return undefined;
      },
    }),
  ],
});

const registry = createRegistry();
// CodingTools 是官方提供的 read, write, edit 和 bash 工具包
registry.install(CodingTools);
registry.install(Timing);

// 这个示例使用 jsonl 作为存储
const storage = await openNodeJsonlStorage(directory, context);
const harness = await Harness.open(
  storage,
  {
    models,
    registry,
    // The environment is built per use and follows the conversation's agent `cwd`.
    env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
  },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory },
});

// 当 generation 收到带 toolCall 的应答后（`stopReason: "toolUse"`），在同一个 submit 做三件事：
//   1) 追加 pi.assistant、2) 为每个 call 建一个 pi.tool 任务、3) 写 pi.live.tools
// 真正执行 toolcall 的是那些 pi.tool 任务
const settled = await (
  await root.submit({ type: "input", content: "Greet durable instead." }, context)
).wait(context);
console.log("status:", settled.status);

// Each tool call runs as a durable pi.tool task owned by the generation,
// which waits for them and continues the run with the next generation.
const transcript = await root.entries({}, 20, undefined, context);
for (const entry of [...transcript.items].reverse()) {
  if (!ToolResultEntry.is(entry)) {
    console.log(entry.kind);
    continue;
  }
  const result = entry.model![0] as ToolResultMessage;
  const text = result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
  console.log(
    `${entry.kind} ${result.toolName}:`,
    JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}...` : text),
  );
}

if (settled.status === "done" && settled.type === "input") {
  const answer = await root.commit(
    (tx) => tx.entry(AssistantEntry, settled.answer),
    context,
  );
  const message = answer?.model?.[0];
  console.log("answer:", message?.role === "assistant" ? message.content : message);
}
console.log(
  "file:",
  JSON.stringify(await readFile(join(directory, "notes.txt"), "utf-8")),
);

await harness.close(context);
console.log("storage:", directory);

/*
预期输出：
cat /tmp/1gb.txt took 3 ms
status: done
pi.user
pi.system
pi.assistant
pi.tool-result read: "hello world\n"
pi.assistant
pi.tool-result edit: "Successfully replaced 1 block(s) in notes.txt."
pi.assistant
pi.tool-result bash: "hello durable\n"
pi.assistant
pi.tool-result bash: "cat: /tmp/1gb.txt: 没有那个文件或目录\n<harness>\n[error] Command exited with code 1\n</harness>"
pi.assistant
answer: [ { type: 'text', text: 'The file now greets durable.' } ]
file: "hello durable\n"
storage: /tmp/pi-durable-example-UizmvQ
*/
