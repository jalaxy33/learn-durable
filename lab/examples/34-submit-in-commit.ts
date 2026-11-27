import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { obj } from "@earendil-works/pi-schema";
import {
  ConversationIdle,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

// The host's own state: who may message this conversation, and what they sent.
const Visitors = defineDoc<{ muted: string[]; sent: { from: string; text: string }[] }>({
  kind: "app.visitors",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ muted: [], sent: [] }),
  checkpointWhen: () => false,
});

// A tool that waits until released, so messages arrive while the run works.
let release!: () => void;
const working = new Promise<void>((resolve) => {
  release = resolve;
});
const build = defineTool({
  name: "build",
  description: "Build the project",
  parameters: obj({}),
  execute: async () => {
    await working;
    return { output: [{ type: "text", text: "built" }] };
  },
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("build", {}), { stopReason: "toolUse" }),
  fauxAssistantMessage("Built, and I added the test Ana asked for."),
]);
const registry = createRegistry();
registry.install(defineExtension({ name: "build", tools: [build] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});
await root.commit(async (tx) => {
  (await tx.doc(Visitors, root.id)).muted.push("bob");
}, context);

/** A visitor's message: checked, admitted as a steer of the current run, and recorded, in one commit or not at all. */
async function message(from: string, text: string, requestId: string): Promise<string> {
  try {
    // 一个提交做三件事：宿主自己的检查（muted）、admit 这条消息、写入自己的 sent
    // 要么全部落地，要么全部不发生。
    return await harness.commit(async (tx) => {
      const visitors = await tx.doc(Visitors, root.id);
      if (visitors.muted.includes(from)) return `${from} is muted`;
      // Before the commit's own table writes; document writes may come before or after.
      //
      // admit在同一次commit写入一些内容，与本次commit同生共死
      // 与submit区别：submit 是“另外记一笔”，admit 是“记在同一笔上”。
      const id = await root.admit(tx, {
        type: "input",
        content: `${from}: ${text}`,
        whenBusy: "steer",
        whenIdle: "reject", // 只能插话，不能自己开run
        requestId,
      });
      visitors.sent.push({ from, text });
      return `${from}'s message is submission ${id}`;
    }, context);
  } catch (error) {
    if (error instanceof ConversationIdle) return `${from}: the agent isn't working now`;
    throw error;
  }
}

console.log(await message("ana", "Add a test for the build.", "ana-1")); // idle: refused, nothing written
const run = await root.submit({ type: "input", content: "Build the project." }, context);
console.log(await message("ana", "Add a test for the build.", "ana-2")); // busy: joins the run as a steer
console.log(await message("bob", "Delete everything.", "bob-1")); // the host's own check refuses it
release();
await run.wait(context);
await root.waitForIdle(context);

const page = await root.entries({ order: "ascending" }, 100, undefined, context);
for (const entry of page.items) {
  const message = entry.model?.[0];
  if (message?.role === "user") console.log(">", message.content);
  if (message?.role === "assistant" && message.stopReason === "stop") {
    console.log(
      "agent:",
      message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(""),
    );
  }
}
console.log("recorded:", (await harness.snapshot(Visitors, root.id, context))?.sent);
await harness.close(context);

/*
预期输出：
ana: the agent isn't working now
ana's message is submission 11
bob is muted
> Build the project.
> ana: Add a test for the build.
agent: Built, and I added the test Ana asked for.
recorded: [ { from: 'ana', text: 'Add a test for the build.' } ]
*/
