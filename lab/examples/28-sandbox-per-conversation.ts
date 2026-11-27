import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createRegistry,
  defineDoc,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const context = BACKGROUND_CONTEXT;

// 沙箱记录在文档里
// Which sandbox a conversation runs in. `fork: "initial"`:
// a fork gets no sandbox until the app assigns one.
const Sandbox = defineDoc<{ path?: string }>({
  checkpointWhen: () => false,
  kind: "app.sandbox",
  version: 1,
  scope: "conversation",
  history: "latest", // 当前文档，不要历史
  fork: "initial", // fork不继承父会话的沙箱，等app分配
  initial: () => ({}),
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const note = (text: string) =>
  fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: text }), {
    stopReason: "toolUse",
  });
faux.setResponses([
  note("from alice"),
  fauxAssistantMessage("Saved."),
  note("from bob"),
  fauxAssistantMessage("Saved."),
]);

const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(
  new MemoryStorage(),
  {
    models,
    registry,
    // env 是每次使用都调用的函数
    // Committed reads only; a conversation without a sandbox gets no environment,
    // so its tools fail cleanly.
    env: async ({ conversationId, read }, envContext) => {
      const sandbox = await read.snapshot(Sandbox, conversationId, envContext);
      return sandbox?.path === undefined
        ? undefined
        : new NodeExecutionEnv({ cwd: sandbox.path });
    },
  },
  context,
);

// Each user's conversation gets a fresh sandbox in the creating commit.
const model = { provider: "faux", modelId: "faux-1" };
async function conversationFor(user: string) {
  const path = await mkdtemp(join(tmpdir(), `pi-durable-sandbox-${user}-`));
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model },
      // 在创建对话时初始化沙箱
      init: async (tx, id) => {
        (await tx.doc(Sandbox, id)).path = path;
      },
    },
    context,
  );
  return { conversation, path };
}

const alice = await conversationFor("alice");
const bob = await conversationFor("bob");
await (
  await alice.conversation.submit({ type: "input", content: "Leave a note." }, context)
).wait(context);
await (
  await bob.conversation.submit({ type: "input", content: "Leave a note." }, context)
).wait(context);
console.log("alice's sandbox:", await readFile(join(alice.path, "note.txt"), "utf8"));
console.log("bob's sandbox:", await readFile(join(bob.path, "note.txt"), "utf8"));

await harness.close(context);
await rm(alice.path, { recursive: true, force: true });
await rm(bob.path, { recursive: true, force: true });

/*
预期输出：
alice's sandbox: from alice
bob's sandbox: from bob
*/
