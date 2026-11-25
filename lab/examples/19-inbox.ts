import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  InboxDoc,
  MemoryStorage,
  type Submission,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

// The first answer waits until we let it go, so the conversation stays busy while we submit more.
let release!: () => void;  // ! 表示“稍后一定赋值”
const held = new Promise<void>((resolve) => {
  release = resolve;
});
// 模拟忙等，让第一条回应直到放行时才出现
const slow: FauxResponseStep = async () => {
  await held; // 等外部放行
  return fauxAssistantMessage("Answer to the first question.");
};

const faux = fauxProvider();
faux.setResponses([slow, fauxAssistantMessage("Answer to the follow-up and the steer.")]);
const models = createModels();
models.setProvider(faux.provider);

const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry: createRegistry(), settings: { followUpMode: "all" } },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

const first = await root.submit({ type: "input", content: "First question" }, context);

// 三种 whenBusy
// 1) 排队，作为 followUp（默认），等这次运行完再开一轮
const followup = await root.submit({ type: "input", content: "A follow-up" }, context);
// 2) 排队，作为 steer，在当前轮后插入
const steer = await root.submit(
  { type: "input", content: "A steer", whenBusy: "steer" },
  context,
);
// 这里的 note 不排队：
//  只有 kind+data 的 write 不改变模型能看到的东西，所以忙时立即追加
//  带 model/head/edits 的 write 会改变模型上下文，按 steer 处理。
const note = await root.submit(
  {
    type: "write",
    entry: { kind: "app.note", data: "noted while busy" },
  },
  context,
);
const withdrawn = await root.submit({ type: "input", content: "Never mind" }, context);
// 3) reject：忙时直接拒绝这条输入（空闲时拒绝用 whenIdle: "reject"）
await root
  .submit({ type: "input", content: "Now or never", whenBusy: "reject" }, context)
  .catch((error: Error) => console.log("rejected:", error.message));
// abort 撤销排队
console.log("withdrawn:", await withdrawn.abort(context));

// InboxDoc 记录排队中的 document，此时有 followUp 和 steer
const inbox = await harness.snapshot(InboxDoc, root.id, context);
console.log(
  "inbox",
  inbox?.items.map((item) => `${item.id} ${item.mode}`),
);

release(); // 直到此时才释放
const status = async (name: string, submission: Submission) => {
  const record = await submission.wait(context);
  console.log(
    `${name}:`,
    record.status,
    record.status === "unanswered" ? record.reason : "",
  );
};
await status("first", first);
await status("follow-up", followup);
await status("steer", steer);
await status("note", note);
await status("withdrawn", withdrawn);

const page = await root.entries({}, 20, undefined, context);
console.log(
  "transcript:",
  [...page.items].reverse().map((entry) => entry.kind),
);

await harness.close(context);

/*
预期输出：
rejected: Conversation 1 is busy
withdrawn: aborted
inbox [ '10 followUp', '11 steer' ]
first: done
follow-up: done
steer: done
note: done
withdrawn: unanswered aborted
transcript: [
  'pi.user',
  'app.note',
  'pi.assistant',
  'pi.user',
  'pi.user',
  'pi.assistant'
]
*/
