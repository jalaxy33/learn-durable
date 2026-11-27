import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { obj } from "@earendil-works/pi-schema";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;

// Stand-in for code loaded from disk: each call builds the extension as the file currently reads.
let started = (): void => {};
let gate = Promise.resolve();
// 注册表按扩展名索引：同名 install 是原地替换（位置不变），不同名才追加。
// 这里每次都用 name: "versioned"，所以 install 换的是同扩展的新版本；
// 工具名不变只是结果，真正决定替换的是扩展的 name。
function loadVersioned(version: string) {
  return defineExtension({
    name: "versioned",
    tools: [
      defineTool({
        name: "version",
        description: "Report the tool's code version",
        parameters: obj({}),
        execute: async () => {
          started();
          await gate;
          return { output: [{ type: "text", text: version }] };
        },
      }),
    ],
  });
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const callVersion = () =>
  fauxAssistantMessage(fauxToolCall("version", {}), { stopReason: "toolUse" });
faux.setResponses([
  callVersion(),
  fauxAssistantMessage("Done."),
  callVersion(),
  fauxAssistantMessage("Done."),
]);

const directory = await mkdtemp(join(tmpdir(), "pi-durable-reload-"));
const open = async (registry: ReturnType<typeof createRegistry>) =>
  Harness.open(
    await openNodeSqliteStorage(join(directory, "session.sqlite")),
    { models, registry },
    context,
  );

// First process.
let registry = createRegistry();
registry.install(loadVersioned("v1"));
let harness = await open(registry);
let root = await harness.root(context, {
  // Selected by name. The name is what is stored, never the code.
  agent: {
    model: { provider: "faux", modelId: "faux-1" },
    extensions: [loadVersioned("v1")],
  },
});
// 读最近一条工具结果
const lastResult = async () => {
  const page = await root.entries({}, 10, undefined, context);
  const result = page.items.find((entry) => ToolResultEntry.is(entry))
    ?.model?.[0] as ToolResultMessage;
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

// The file changes while a call runs: the running call finishes on v1, the next call uses v2.
let release = (): void => {};
gate = new Promise((resolve) => {
  release = resolve;
});
const running = new Promise<void>((resolve) => {
  started = resolve;
});
const submission = await root.submit(
  { type: "input", content: "Which version?" },
  context,
);
await running; // 等工具开始跑
registry.install(loadVersioned("v2")); // 此时换工具
release(); // 放行
await submission.wait(context); // 等这一轮结束
console.log("call running during the reload:", await lastResult()); // 读最近一条工具结果 -> v1
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
console.log("next call:", await lastResult()); // 此时打印 v2
await harness.close(context);

// Second process: the conversation still selects "versioned", but this process has not installed it yet.
registry = createRegistry();
harness = await open(registry);
root = await harness.root(context);
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("after restart, before install:", await tools()); // 名字对不上时解析为空
registry.install(loadVersioned("v3"));
console.log("after install:", await tools());

await harness.close(context);
await rm(directory, { recursive: true, force: true });

/*
预期输出：
call running during the reload: v1
next call: v2
after restart, before install: []
after install: [ 'version' ]
*/
