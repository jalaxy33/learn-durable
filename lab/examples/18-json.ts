// 用法：node examples/18-json.ts [--ops|--state] [--storage sqlite|jsonl|memory] ["prompt"]
//   --ops（默认）  第一行是完整视图，之后每行是自上一帧以来的操作
//   --state        每行是新追加的条目 + 当前的 pi.live
//   --storage      sqlite（默认，临时文件）/ jsonl（临时目录）/ memory
//   有 DEEPSEEK_API_KEY 时用真模型，否则用 faux；sqlite/jsonl 的路径最后输出到 stderr
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  section,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context = BACKGROUND_CONTEXT;
const args = process.argv.slice(2);
const mode = args.includes("--state") ? "state" : "ops";
const storageIndex = args.indexOf("--storage");
const storageKind = storageIndex < 0 ? "sqlite" : args[storageIndex + 1];
const prompt =
  args.find(
    (arg, index) =>
      !arg.startsWith("--") && (storageIndex < 0 || index !== storageIndex + 1),
  ) ?? "What is in this directory?";

let storage: Storage;
let location: string | undefined;
if (storageKind === "sqlite") {
  location = join(tmpdir(), `pi-durable-json-${Date.now()}.sqlite`);
  storage = await openNodeSqliteStorage(location);
} else if (storageKind === "jsonl") {
  location = await mkdtemp(join(tmpdir(), "pi-durable-json-"));
  storage = await openNodeJsonlStorage(location, context);
} else if (storageKind === "memory") {
  storage = new MemoryStorage();
} else {
  throw new Error(`Unknown --storage ${storageKind}; use sqlite, jsonl or memory`);
}
const print = (value: unknown): void =>
  void process.stdout.write(`${JSON.stringify(value)}\n`);

const models = createModels();
let model = { provider: "deepseek", modelId: "deepseek-flash" };
if (process.env.DEEPSEEK_API_KEY !== undefined) {
  models.setProvider(deepseekProvider());
} else {
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  model = { provider: "faux", modelId: "faux-1" };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "call-1" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("This directory holds the durable example codes.")]),
  ]);
}

const registry = createRegistry();
registry.install(
  defineExtension({
    name: "coding",
    tools: [createReadTool(), createBashTool()],
    sections: [
      section("preamble", () => "You are a concise coding assistant.", { tag: false }),
    ],
  }),
);
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const harness = await Harness.open(
  storage,
  { models, registry, env: () => env },
  context,
);
const root = await harness.root(context, { agent: { model } });

// Attach before submitting, so the watch covers the whole run.
const watch = await root.watch(context);
if (mode === "ops") {
  print({ view: watch.value });
  watch.start(async (call) => {
    if (call.kind === "value") print({ ops: call.ops });
  });
} else {
  let newest = watch.value.entries.at(-1)?.id ?? 0;
  print({
    entries: watch.value.entries,
    live: watch.value.docs["pi.live"],
  });
  watch.start(async (call) => {
    if (call.kind !== "value") return;
    const { value } = call;
    const entries = value.entries.filter((entry) => entry.id > newest);
    newest = value.entries.at(-1)?.id ?? newest;
    print({ ...(entries.length === 0 ? {} : { entries }), live: value.docs["pi.live"] });
  });
}

const submission = await root.submit({ type: "input", content: prompt }, context);
// 等这一条输入结算，保证“答案已提交”
await submission.wait(context);
// 等整个会话 idle————没有跑着/等着/睡着的非后台任务
await harness.waitForIdle(context);

// 让出一个宏任务，把 watch 的回调队列排空
await new Promise((r) => setTimeout(r, 0));
await watch.stop();
await harness.close(context);
if (location !== undefined) console.error(`${storageKind} storage: ${location}`);
