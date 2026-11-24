// 对应官方示例 01-documents.ts（v1.6.0）；机制见 docs/1-core/5-runtime.md §2、README「Your Own State」
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const Counter = defineDoc<{ value: number }>({
  kind: "example.counter",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ value: 0 }),
  checkpointWhen: () => false,
});

const Notes = defineDoc<{ items: string[] }>({
  kind: "example.notes",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [] }),
  checkpointWhen: () => false,
});

const harness = await Harness.open(
  new MemoryStorage(),
  { models: createModels(), registry: createRegistry() },
  context,
);
const root = await harness.root(context);

await root.commit(async (tx) => {
  (await tx.doc(Counter, root.id)).value = 1;
  (await tx.doc(Notes, root.id)).items.push("first");
}, context);

const firstMark = await root.commit(
  async (tx) =>
    (await tx.appendEntry(root.id, { kind: "example.mark", data: "first" })).id,
  context,
);

await root.commit(async (tx) => {
  (await tx.doc(Counter, root.id)).value = 2;
  (await tx.doc(Notes, root.id)).items.push("second");
}, context);

const secondMark = await root.commit(
  async (tx) =>
    (await tx.appendEntry(root.id, { kind: "example.mark", data: "second" })).id,
  context,
);

console.log("counter:", await harness.snapshot(Counter, root.id, context));
console.log("notes now:", await harness.snapshot(Notes, root.id, context));
console.log(
  "notes at first mark:",
  await harness.snapshotAsOf(Notes, root.id, firstMark, context),
);
console.log(
  "notes at second mark:",
  await harness.snapshotAsOf(Notes, root.id, secondMark, context),
);

await harness.close(context);

/*
预期输出：
counter: { value: 2 }
notes now: { items: [ 'first', 'second' ] }
notes at first mark: { items: [ 'first' ] }
notes at second mark: { items: [ 'first', 'second' ] }

讲解：
- tx.doc() 返回可写草稿，改它不需要 save()；文档和 entry 在同一次提交里落盘。
- history: "latest" 只留最新值，"rewindable" 留“基线 + 操作”才能回看。snapshotAsOf 的 entryId 是一个时间点。
- 类型上 snapshotAsOf 只接受 rewindable 的 token，Counter 传不进去——约束在编译期。
*/
