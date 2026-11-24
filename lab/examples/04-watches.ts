// 对应官方示例 04-watches.ts（v1.6.0）；机制见 docs/1-core/5-runtime.md §7、README「Watching a Conversation」
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const Notes = defineDoc<{ items: string[] }>({
  kind: "example.notes",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: () => false,
});

const harness = await Harness.open(
  new MemoryStorage(),
  { models: createModels(), registry: createRegistry() },
  context,
);
const root = await harness.root(context);

const watch = await root.watch(context);
console.log(
  "Initial entries:",
  watch.value.entries.length,
  "docs:",
  Object.keys(watch.value.docs).sort().join(","),
);

let calls = 0;
watch.start(async (call) => {
  if (call.kind !== "value") return;
  calls += 1;
  console.log(
    `call ${calls}: entries=${call.value.entries.length} ops=${call.ops.length}`,
  );
});

for (const item of ["one", "two"]) {
  await root.commit(async (tx) => {
    (await tx.doc(Notes, root.id)).items.push(item);
    await tx.appendEntry(root.id, { kind: "example.mark", data: item });
  }, context);
  await delay(10);
}

const end = await watch.stop();
console.log(
  "calls:",
  calls,
  "end:",
  end.kind,
  "entries:",
  watch.value.entries.length
);
console.log("notes:", await harness.snapshot(Notes, root.id, context));

await harness.close(context);

/*
预期输出：
initial entries: 0 docs: pi.agent,pi.inbox,pi.live,pi.provider,pi.usage
call 1: entries=1 ops=<数字>
call 2: entries=2 ops=<数字>
calls: 2 end: stopped entries: 2
notes: { items: [ 'one', 'two' ] }

讲解：
- watch.value 是挂上那一刻的视图，之后每次提交来一次回调；
  视图 = conversation 记录 + entries 窗口（默认最新 50、上限 100）+ docs。
- 投递串行且折叠：回调没跑完时来的提交合并进下一次，所以“调用次数 ≠ 提交次数”。
  delay(10) 只是给回调时间跑完。
- stop() 后 value 保留最后值，句柄不再引用 Harness。
*/
