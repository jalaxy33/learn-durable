import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ToolResultEntry,
  type Wake,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

// The Harness clock, moved by the host's "alarm" below.
let clock = 0;

// A slow job service: starting twice with one idempotency key starts one job, done on its fourth status check.
let checks = 0;
const started = new Map<string, string>();
const jobs = {
  start: async (_name: string, idempotencyKey: string) => {
    if (!started.has(idempotencyKey))
      started.set(idempotencyKey, `job-${started.size + 7}`);
    return started.get(idempotencyKey)!;
  },
  status: async (_id: string) => (++checks >= 4 ? "done" : "running"),
};

const Parameters = obj({ name: str() });
const waitForJob = defineTool<
  typeof Parameters,
  never,
  { id: string; polls: number; delayMs: number }
>({
  name: "wait_for_job",
  description: "Start a job and wait until it is done",
  parameters: Parameters,
  replay: "safe",
  // 一个 execute 反复重跑，状态只能从 checkpoint 读
  async execute({ name }, api, ctx) {
    // The first run starts the job under its own idempotency key, memoized first, so a rerun after a crash before the
    // first park finds the same job.
    const id =
      api.checkpoint?.id ??
      (await jobs.start(name, await api.memo("job.key", crypto.randomUUID(), ctx)));
    const status = await jobs.status(id);
    const polls = (api.checkpoint?.polls ?? 0) + 1;
    console.log(`  [poll ${polls} at ${clock / 1000}s] ${id} is ${status}`);
    if (status === "done")
      return { output: [{ type: "text", text: `${id} done after ${polls} polls` }] };
    // Back off: 1s, 2s, 4s, ... up to a minute.
    const delayMs = Math.min((api.checkpoint?.delayMs ?? 500) * 2, 60_000);
    return {
      kind: "sleep",
      checkpoint: { id, polls, delayMs },
      until: api.now() + delayMs,
    };
  },
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("wait_for_job", { name: "nightly" }), {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("The nightly job is done."),
]);

// The host's alarm: `onWake` says when the Session next needs a process; the "alarm" fires by moving the clock there.
const wakes: Wake[] = [];
const registry = createRegistry();
registry.install(defineExtension({ name: "jobs", tools: [waitForJob] }));
const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry, now: () => clock, onWake: (wake) => wakes.push(wake) },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});
const submission = await root.submit(
  { type: "input", content: "Run the nightly job" },
  context,
);

let settled = false;
void submission.wait(context).then(() => {
  settled = true;
});
while (!settled) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const wake = harness.wake();
  // Parked between polls: nothing runs, only the next poll time is set.
  if (!wake.active && wake.at !== undefined) {
    console.log("asleep until", wake.at / 1000, "s:", wake);
    clock = wake.at;
    harness.resume();
  }
}
const page = await root.entries({}, 10, undefined, context);
const result = page.items.find((entry) => ToolResultEntry.is(entry))
  ?.model?.[0] as ToolResultMessage;
console.log(
  "result:",
  result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
);
console.log("durationMs (first run to result, on the Harness clock):", result.durationMs);
console.log("onWake calls:", wakes.length);
await harness.close(context);

// 工具 park 的四种形态（本示例是第二种：纯时间轮询）
//   { kind: "sleep", signals, until }  信号或超时，谁先到算谁        -> wake() { active: false, at }   （40 webhook）
//   { kind: "sleep", until }           只有时间                      -> wake() { active: false, at }   （本例）
//   { kind: "wait", on, policy }       等子任务（any / allSettled / failFast） -> wake() { active: false }（42 并行子调用）
//   { kind: "sleep", signals }         只等信号（无截止）             -> wake() { active: false }       （43 subagent 结算）
// 共同点：park 期间不持有 invocation；醒来后 execute() 从第一行重跑，状态只能从 api.checkpoint 读。
// 区别只在“谁会叫醒我”：时间要给 at（宿主设闹钟），信号/子任务不需要 at。

/*
预期输出：
[poll 1 at 0s] job-7 is running
asleep until 1 s: { active: false, at: 1000 }
[poll 2 at 1s] job-7 is running
asleep until 3 s: { active: false, at: 3000 }
[poll 3 at 3s] job-7 is running
asleep until 7 s: { active: false, at: 7000 }
[poll 4 at 7s] job-7 is done
result: job-7 done after 4 polls
durationMs (first run to result, on the Harness clock): 7000
onWake calls: 13
*/
