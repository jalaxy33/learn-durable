import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHost,
  defineFacet,
  defineTable,
  local,
  method,
  openStore,
  sqliteBackend,
  str,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";

const context = BACKGROUND_CONTEXT;

// 声明一张表
const Notes = defineTable("notes", {
  version: 1,
  columns: { id: str(), text: str() },
  key: ["id"],
});

// The harness object: local with empty params, so it lives as long as the host and may persist (P3).
// 声明一个对象类型
const Chat = local("example.chat", {
  version: 1,
  params: {},
  members: { note: method(str()), say: method(str()) },
});

// facet是插件清单
const facet = defineFacet((host) => {
  host.serve(Chat, (_, self) => {
    // 拿到自己的表 + 打开durable
    // Its own table, under its type name ...
    const notes = self.table(Notes);
    // ... and Durable's records under the same owner name: claims per table and per document namespace.
    const harness = self.open(
      async (open) => {
        const opened = await Harness.open(
          await StoreStorage.open(store, Chat.name, open),
          { models: createModels(), registry: createRegistry() },
          open,
        );
        await opened.root(open);
        return opened;
      },
      (h, _reason, close) => h.close(close),
    );
    return {
      note: async (text, ctx) => {
        await self.tx(async (tx) => tx.put(notes, { id: `n${text.length}`, text }), ctx);
        return null;
      },
      say: async (text, ctx) => {
        const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
        await root!.submit(
          { type: "write", entry: { kind: "example.said", data: { text } } },
          ctx,
        );
        return null;
      },
    };
  });
});

const directory = await mkdtemp(join(tmpdir(), "chord-example-26-"));
const path = join(directory, "session.sqlite");
// 1. The worker's start code opens the store and gives it to its host.
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
const host = createHost({
  store,
  onError: (error) => console.log("onError", error.kind),
});
await host.load([{ name: "@example/core", facet }], context);
const chat = await host.get(Chat, {}, context);

// 2. Chord's commit and Durable's commit, each one seq of the same store.
const before = store.lastSeq;
await chat.note("hello", context);
await chat.say("hello, Durable", context);
console.log("seqs taken:", store.lastSeq - before);

// 3. One archive holds both: Chord's table, Durable's tables and documents, all under the owner name.
const owners = new Map<string, number>();
for await (const part of store.export(context)) {
  const owner =
    part.kind === "table" || part.kind === "put"
      ? part.table.split(":")[0]
      : part.kind === "document.create"
        ? part.record.owner
        : undefined;
  if (owner !== undefined)
    owners.set(`${owner} ${part.kind}`, (owners.get(`${owner} ${part.kind}`) ?? 0) + 1);
  if (part.kind === "manifest")
    console.log("manifest:", { lastSeq: part.lastSeq, nextId: part.nextId });
}
console.log("parts by owner and kind:", Object.fromEntries(owners));

// 4. The app closes the host, then the store; a reopen finds both.
await host.close(context);
await store.close(context);
const reopened = await openStore(
  sqliteBackend(await openNodeSqliteDatabase(path)),
  context,
);
const storage = await StoreStorage.open(reopened, Chat.name, context);
const page = await storage.scanEntries(
  { conversationId: ROOT_CONVERSATION_ID },
  10,
  undefined,
  context,
);
console.log(
  "Durable entries after reopen:",
  page.items.map((entry) => entry.kind),
);
await storage.close(context);
await reopened.close(context);
await rm(directory, { recursive: true, force: true });

/*
预期输出：
seqs taken: 2
manifest: { lastSeq: 5, nextId: 9 }
parts by owner and kind: {
  'example.chat table': 7,
  'example.chat put': 12,
  'example.chat document.create': 5
}
Durable entries after reopen: [ 'example.said' ]
*/
