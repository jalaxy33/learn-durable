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
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

const context = BACKGROUND_CONTEXT;

// 信号是“带类型的值 + 一个 key”（json value），用于向未结束的 task 传递消息/值
// defineSignal 返回一个 token
const Greeting = defineSignal({
  name: "example.greeting",
  version: 1,
  schema: obj({ text: str() }),
});

const Greeter = defineTask<null, { phase: "work" } | { phase: "greeted" }, string>({
  name: "example.greeter",
  version: 1,
  initial: () => ({ phase: "work" }),
  phases: {
    // 创建后进入work阶段：先 sleep，直到收到 Greeting signal 进入 greeted 阶段
    // signal 先到后到都能工作，值存在任务记录里，work 阶段当 task 提交 sleep 时，发现 key 有值会立刻醒
    work: (_task, runtime, ctx) =>
      // 睡眠不占调用，提交 {status:sleeping, signal[key]} 后任务释放调用，进程可退
      runtime.commit(
        () => ({
          status: "sleeping",
          checkpoint: { phase: "greeted" },
          signals: [Greeting.key("hello")],
        }),
        ctx,
      ),
    greeted: async (task, runtime, ctx) => {
      // The wake names the key
      const wake = task.state.wake;
      // readSignal 读取信号传入的值
      // 一个 key 服务一次等待————唤醒即消费
      // 返回 { kind: "value", value } 或 { kind: "expired" } 或 undefined
      const state = await runtime.readSignal(Greeting, "hello", ctx);
      const text = state?.kind === "value" ? state.value.text : "(none)";
      console.log(`  [greeter] woke by ${JSON.stringify(wake)}, read ${text}`);
      // greet 过一次之后本 task 就结束了
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: text } }),
        ctx,
      );
    },
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const registry = createRegistry();
registry.install(defineExtension({ name: "greeter", tasks: [Greeter] }));
const harness = await Harness.open(
  new MemoryStorage(),
  {
    models: createModels(),
    registry,
    onWake: () => {},
  },
  context,
);
const root = await harness.root(context);
// 创建 task 并获取 taskid
const id = await root.commit(
  (tx) => tx.createTask(Greeter, null, { ownership: { kind: "conversation" } }),
  context,
);

// 1. 在执行 task 前发送，回复 "delivered"，
console.log(
  "early:",
  await harness.signal(id, Greeting, "hello", { text: "hi there" }, context),
);
// 2. 用同个 key 重试，回复 "duplicate"
console.log(
  "retry:",
  await harness.signal(id, Greeting, "hello", { text: "hi again" }, context),
);
// 3. 发送不符合 schema 格式的值，回复 "invalid"，该值不会被保留
console.log(
  "bad value:",
  await harness.signal(id, Greeting, "other", { text: 42 } as never, context), // as never 跳过编译器检查
);
// 4. 没有对应的 taskid，回复 "not_found"
console.log(
  "unknown task:",
  await harness.signal(999_999 as TaskId, Greeting, "hello", { text: "?" }, context),
);

// 执行 task，此时获得 "early" 发送的值
console.log("result:", (await harness.waitForTask(id, context)).state.outcome);
// 5. task 结束之后的回复都是 "closed"
console.log(
  "after the end:",
  await harness.signal(id, Greeting, "hello", { text: "too late" }, context),
);

// 创建第二个 task
const second = await root.commit(
  (tx) => tx.createTask(Greeter, null, { ownership: { kind: "conversation" } }),
  context,
);
harness.resume(); // 打开 harness 调度
// while 轮询，等待 task 真的变成 sleeping，
// 必须先等到这个状态，否则下面 wake() 会回答“有活要跑”（active: true），观察不到休眠状态
while ((await harness.getTask(second, context))?.state.status !== "sleeping") {
  await new Promise((r) => setTimeout(r, 1));
}
// 多等 1ms 避免读到过期答案
await new Promise((r) => setTimeout(r, 1));
// harness.wake() 回答“现在还需要这个进程吗”
// 返回 { active: bool, at: 时刻}，当 active 为 true 时说明还有任务在跑，不能直接关
// 下面这句会返回 {active: false}，说明当前已经没有活动的任务了，
// 第一个任务已结束，第二个任务目前处于休眠等信号的状态，不占进程，现在关掉整个进程也没关系
console.log("asleep, wake:", harness.wake());
console.log(
  "late:",
  await harness.signal(second, Greeting, "hello", { text: "good morning" }, context),
);
console.log("result:", (await harness.waitForTask(second, context)).state.outcome);

await harness.close(context);

/*
预期输出：
early: delivered
retry: duplicate
bad value: invalid
unknown task: not_found
  [greeter] woke by {"reason":"signal","signal":"example.greeting","key":"hello"}, read hi there
result: { status: 'completed', result: 'hi there' }
after the end: closed
asleep, wake: { active: false }
late: delivered
  [greeter] woke by {"reason":"signal","signal":"example.greeting","key":"hello"}, read good morning
result: { status: 'completed', result: 'good morning' }
*/
