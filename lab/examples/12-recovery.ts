import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context = BACKGROUND_CONTEXT;

// 本示例将使用 sqlite 作为存储
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
const databasePath = join(directory, "session.sqlite");

let reachedTick = (_n: number): void => {};
// task是一个状态机，defineTask<input, state, result>
const Ticker = defineTask<{ to: number }, { phase: "tick"; n: number }, string>({
  // 重启靠名字和版本对上代码
  name: "example.ticker",
  version: 1,
  // 初始阶段
  initial: () => ({ phase: "tick", n: 1 }),
  // 任务状态机
  phases: {
    tick: async (task, runtime, taskContext) => {
      const n = task.state.checkpoint.n;
      // memo 会记录创建时的值，未创建时返回 undefined，已创建则返回第一次的值
      // （memo 是幂等工具，首次写入胜出）
      if ((await runtime.memo(`printed-${n}`, taskContext)) === undefined) {
        await runtime.memo(`printed-${n}`, true, taskContext);
        console.log(`tick ${n}`);
      }
      reachedTick(n);
      // 判断是否到末尾状态（`status: "terminal"`），结果由 outcome 字段传出
      if (n === task.input.to) {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: `counted to ${n}` },
          }),
          taskContext,
        );
        return;
      }
      // 如果没结束，进入下一个 phase
      await runtime.sleepUntil(
        runtime.now() + 50,
        { phase: "tick", n: n + 1 },
        taskContext,
      );
    },
  },
  // 定义中止时行为
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(
      () => ({
        status: "terminal",
        outcome: { status: "aborted" },
      }),
      taskContext,
    );
  },
});

const registry = createRegistry();
registry.install(
  defineExtension({
    name: "ticker",
    tasks: [Ticker],
  }),
);
const open = async () =>
  Harness.open(
    // 使用 sqlite 作为存储
    await openNodeSqliteStorage(databasePath),
    { models: createModels(), registry },
    context,
  );

// First run:
//  开始数到 5，当打印完 "tick 2" 后马上关闭 harness，
//  此时刚好处于下一个 checkpoint 要保存之前，模拟做完一件事但是还没保存结果被中断的情况
const firstRun = await open();
const tickerId = await (
  await firstRun.root(context)
).commit(
  (tx) => tx.createTask(Ticker, { to: 5 }, { ownership: { kind: "conversation" } }),
  context,
);
// tickTwo 是一个 Promise 对象
const tickTwo = new Promise<void>((resolve) => {
  reachedTick = (n) => {
    // 当任务跑到 reachedTick(2) 时调用 resolve()，这个 Promise 已完成
    if (n === 2) resolve();
  };
});
// Harness开启后默认不调度，没有代码会执行
// 用 resume() 将调度器打开，否则后面 await tickTwo 会一直等不到（死锁）
firstRun.resume();
await tickTwo;
await firstRun.close(context);
reachedTick = () => {};

// 读取目前保存的记录
const reader = await open();
const saved = (await reader.getTask(tickerId, context))!;
await reader.close(context);
console.log("closed; saved checkpoint:", saved.state, "memos:", saved.memos);

// Second run：
// 用 waitForTask 继续执行未完成的任务，
// 重开无需任何手工操作，调度器会自动把 `pending` 的任务捡起来
// 重开后第 2 步会重跑一遍（从 n=2 的检查点开始），但是因为有 memo 所以没再打印
const secondRun = await open();
// waitForTask会自动开启调度，无需 resume
const counted = await secondRun.waitForTask(tickerId, context);
console.log("after reopen:", counted.state.outcome);
await secondRun.close(context);
await rm(directory, { recursive: true, force: true });

/*
预期输出：
tick 1
tick 2
closed; saved checkpoint: {
  status: 'pending',
  checkpoint: { phase: 'tick', n: 2 },
  wake: { reason: 'time' }
} memos: { 'printed-1': true, 'printed-2': true }
tick 3
tick 4
tick 5
after reopen: { status: 'completed', result: 'counted to 5' }
*/
