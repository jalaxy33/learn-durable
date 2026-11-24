// 对应官方示例 02-forks.ts（v1.6.0）；机制见 docs/1-core/4-orchestration.md §6、README「More Conversations and Forks」
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const Live = defineDoc<{ value: number }>({
  kind: "example.live",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ value: 0 }),
  checkpointWhen: () => false,
});

const At = defineDoc<{ value: number }>({
  kind: "example.at",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ value: 0 }),
  checkpointWhen: () => false,
});

const Fresh = defineDoc<{ value: number }>({
  kind: "example.fresh",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ value: 0 }),
  checkpointWhen: () => false,
});

const harness = await Harness.open(
  new MemoryStorage(),
  { models: createModels(), registry: createRegistry() },
  context,
);
const root = await harness.root(context);

await root.commit(async (tx) => {
  (await tx.doc(Live, root.id)).value = 1;
  (await tx.doc(At, root.id)).value = 1;
  (await tx.doc(Fresh, root.id)).value = 1;
}, context);

const at = await root.commit(
  async (tx) => (await tx.appendEntry(root.id, { kind: "example.mark", data: 1 })).id,
  context,
);

await root.commit(async (tx) => {
  (await tx.doc(Live, root.id)).value = 2;
  (await tx.doc(At, root.id)).value = 2;
  (await tx.doc(Fresh, root.id)).value = 2;
}, context);

const child = await root.fork(at, { ownership: { kind: "ownerless" } }, context);

console.log(
  "parent:",
  await harness.snapshot(Live, root.id, context),
  await harness.snapshot(At, root.id, context),
  await harness.snapshot(Fresh, root.id, context),
);

await child.commit(async (tx) => {
  (await tx.doc(Live, child.id)).value = 99;
}, context);

console.log(
  "child:",
  await harness.snapshot(Live, child.id, context),
  await harness.snapshot(At, child.id, context),
  await harness.snapshot(Fresh, child.id, context),
);
console.log("parent after child write:", await harness.snapshot(Live, root.id, context));

await harness.close(context);

/*
预期输出：
parent: { value: 2 } { value: 2 } { value: 2 }
child: { value: 99 } { value: 1 } undefined
parent after child write: { value: 2 }

讲解
- fork 只复制两种策略：current 拿父会话此刻的值，asOf 拿 at 那个提交时的值。
  initial 的文档不复制，子会话里不存在，读出来是 undefined（约定：缺文档 = 用 initial()）。
- 最后一行说明两边独立：fork 不是子 agent，没有归属，也不跟着父会话 abort。
*/
