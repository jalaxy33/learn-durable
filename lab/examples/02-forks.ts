import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

const Notes = defineDoc<{ text: string }>({
  checkpointWhen: () => false,
  kind: "example.notes",
  version: 1,
  // 文档挂在哪一层：conversation / session / task
  scope: "conversation",
  // latest 只留当前值 / rewindable 可按条目查看
  history: "rewindable",
  // asOf 分叉那一刻 / current 当前值 / initial 重置
  fork: "asOf",
  initial: () => ({ text: "" }),
});

const chat = await session.commit(
  // 两种 ownership： ownerless（独立的顶层会话） 和 task（归任务或工具所有）
  (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
  context,
);
const firstEntry = await session.commit(async (tx) => {
  const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
  (await tx.doc(Notes, chat.id)).text = "after hello";
  return entry;
}, context);
await session.commit(async (tx) => {
  await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
  (await tx.doc(Notes, chat.id)).text = "after goodbye";
}, context);

// A fork is a new conversation that continues from one entry of another. It
// sees the parent's transcript up to that entry, and each document follows its
// own `fork` setting. Notes uses "asOf", so the fork starts with the notes
// value from the fork entry.
const branch = await session.commit(
  (tx) =>
    tx.forkConversation(chat.id, firstEntry.id, { ownership: { kind: "ownerless" } }),
  context,
);

// scanEntries() pages through visible entries, newest first. The fork sees
// "hello" (inherited from the parent) but not "goodbye", which came later.
const branchEntries = await session.commit(
  (tx) => tx.scanEntries({ conversationId: branch.id }, 10),
  context,
);
console.log(
  "fork transcript:",
  branchEntries.items.map((entry) => entry.data),
);
console.log("fork notes:", await session.snapshot(Notes, branch.id, context));

// 分叉后互不影响
// The fork's copy is independent: editing it leaves the parent unchanged.
await session.commit(async (tx) => {
  (await tx.doc(Notes, branch.id)).text = "changed only in the fork";
}, context);
console.log("fork notes after edit:", await session.snapshot(Notes, branch.id, context));
console.log("parent notes after edit:", await session.snapshot(Notes, chat.id, context));

await session.close(context);

/*
预期输出：
fork transcript: [ 'hello' ]
fork notes: { text: 'after hello' }
fork notes after edit: { text: 'changed only in the fork' }
parent notes after edit: { text: 'after goodbye' }
*/
