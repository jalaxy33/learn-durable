import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineSignal,
  defineTask,
  Harness,
  MemoryStorage,
  type TaskId,
  type Wake,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

const context = BACKGROUND_CONTEXT;
const HOUR = 60 * 60 * 1000;

let clock = Date.UTC(2026, 11, 26, 11);
const Answer = defineSignal({
  name: "example.answer",
  version: 1,
  schema: obj({ text: str() }),
});

const inbox = new Map<TaskId, string>();

const AskPerson = defineTask<
  { question: string },
  { phase: "ask" } | { phase: "answered" },
  { answer: string | null }
>({
  name: "example.ask-person",
  version: 1,
  initial: () => ({ phase: "ask" }),
  phases: {
    ask: async (task, runtime, ctx) => {
      inbox.set(runtime.taskId, task.input.question);
      // Sleep until the answer arrives or four hours pass, whichever comes first.
      await runtime.commit(
        () => ({
          status: "sleeping",
          checkpoint: { phase: "answered" },
          // 激活条件：等到信号 or 过4小时
          signals: [Answer.key("answer")],
          until: runtime.now() + 4 * HOUR,
        }),
        ctx,
      );
    },
    answered: async (task, runtime, ctx) => {
      inbox.delete(runtime.taskId);
      // state取值：回答过->`signal`，超时->`expired`
      const state = await runtime.readSignal(Answer, "answer", ctx);
      const answer = state?.kind === "value" ? state.value.text : null;
      console.log(
        `  [ask] woke: ${task.state.wake?.reason}, read: ${JSON.stringify(state)}`,
      );
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: { answer } },
        }),
        ctx,
      );
    },
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const wakes: Wake[] = []; // onWake 的回调数组
const registry = createRegistry();
registry.install(
  defineExtension({
    name: "ask",
    tasks: [AskPerson],
  }),
);
const harness = await Harness.open(
  new MemoryStorage(),
  {
    models: createModels(),
    registry,
    // 注入可控制的时钟
    now: () => clock,
    // onWake 将回调收集成数组
    onWake: (wake) => wakes.push(wake),
  },
  context,
);
const root = await harness.root(context);
const ask = (question: string) =>
  root.commit(
    (tx) =>
      tx.createTask(AskPerson, { question }, { ownership: { kind: "conversation" } }),
    context,
  );
const asleep = async (id: TaskId) => {
  while ((await harness.getTask(id, context))?.state.status !== "sleeping")
    await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => setTimeout(r, 1));
};

// 1. Answered in time.
const first = await ask("Deploy to production?");
harness.resume();
await asleep(first);
console.log("inbox:", [...inbox.values()]);
// Nothing runs: no process needed until the deadline, four hours from now.
console.log(
  "wake while asleep:",
  harness.wake(),
  "deadline in:",
  (harness.wake().at! - clock) / HOUR,
  "h",
);
console.log(
  "deliver:",
  await harness.signal(first, Answer, "answer", { text: "yes" }, context),
);
console.log("result", (await harness.waitForTask(first, context)).state.outcome);

// 2. Nobody answers. The host's alarm fires at the deadline and resumes the Harness.
const second = await ask("Delete the staging database?");
await asleep(second);
console.log("inbox:", [...inbox.values()]);
// 示例没有真闹钟，下面这句表示“闹钟响了”，假装已经过了 4 小时
// 原理：给 clock 变量重新赋值，harness.resume() 让调度器跑一轮，重新问一遍 now()
clock = harness.wake().at!;
harness.resume();
console.log("result:", (await harness.waitForTask(second, context)).state.outcome);
// The key expired with the deadline: a late answer is refused.
console.log(
  "late deliver:",
  await harness.signal(second, Answer, "answer", { text: "yes" }, context),
);
// onWake runs in a microtask after the commit that changed the value.
await new Promise((r) => setTimeout(r, 1));
console.log("last onWake", wakes.at(-1)); // at(-1) 检查 wakes 回调数组的最后一次

await harness.close(context);

/*
预期输出：
inbox: [ 'Deploy to production?' ]
wake while asleep: { active: false, at: 1798297200000 } deadline in: 4 h
deliver: delivered
  [ask] woke: signal, read: {"kind":"value","value":{"text":"yes"}}
result { status: 'completed', result: { answer: 'yes' } }
inbox: [ 'Delete the staging database?' ]
  [ask] woke: expired, read: {"kind":"expired"}
result: { status: 'completed', result: { answer: null } }
late deliver: closed
last onWake { active: false }
*/
