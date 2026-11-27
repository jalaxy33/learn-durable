import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  type TaskGraph,
  type TaskGraphNode,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;

// A fake bank: it declines an expired card at once, and confirms other charges after a moment.
const charged = new Set<string>();

type PaymentInput = { card: string };
type PaymentResult = { card: string };
type PaymentState = { phase: "charge" } | { phase: "confirm" };
const Payment = defineTask<PaymentInput, PaymentState, PaymentResult>({
  name: "example.payment",
  version: 1,
  initial: () => ({ phase: "charge" }),
  phases: {
    charge: async (task, runtime, taskContext) => {
      const card = task.input.card;
      if (card.startsWith("expired")) {
        const error = { message: `${card} declined` };
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "failed", error } }),
          taskContext,
        );
        return;
      }
      charged.add(card);
      // The bank confirms after a moment: wait for it without holding an invocation.
      await runtime.sleepUntil(runtime.now() + 100, { phase: "confirm" }, taskContext);
    },
    confirm: async (task, runtime, taskContext) => {
      const card = task.input.card;
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: { card } },
        }),
        taskContext,
      );
    },
  },
  // Each payment undoes its own effect when aborted.
  abort: async (task, runtime, taskContext) => {
    const refunded = charged.delete(task.input.card);
    console.log(`  payment ${task.input.card} aborted${refunded ? ", refunded" : ""}`);
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    );
  },
});

// The checkout creates its payments as child tasks and waits for all of them.
// With `failFast`, the first payment that fails aborts the others; the checkout
// itself is not aborted and decides its outcome once every payment is done.
type CheckoutState =
  { phase: "pay" } | { phase: "decide"; payments: TaskId<PaymentResult>[] };
const Checkout = defineTask<{ cards: string[] }, CheckoutState, string>({
  name: "example.checkout",
  version: 1,
  initial: () => ({ phase: "pay" }),
  phases: {
    pay: async (task, runtime, taskContext) => {
      await runtime.commit(async (tx) => {
        const payments: TaskId<PaymentResult>[] = [];
        // 创建子任务
        for (const card of task.input.cards) {
          payments.push(
            await tx.createTask(
              Payment,
              { card },
              // 让子任务挂到父任务名下
              { ownership: { kind: "task", taskId: task.id } },
            ),
          );
        }
        // 进入等待
        return {
          status: "waiting",
          checkpoint: { phase: "decide", payments },
          on: payments,
          policy: "failFast",
        };
      }, taskContext);
    },
    decide: async (task, runtime, taskContext) => {
      const outcomes = await runtime.outcomes(
        task.state.checkpoint.payments,
        taskContext,
      );
      console.log(`  payments: ${outcomes.map((outcome) => outcome.status).join(", ")}`);
      const paid = outcomes.every((outcome) => outcome.status === "completed");
      await runtime.commit(
        () =>
          paid
            ? {
                status: "terminal",
                outcome: { status: "completed", result: "order placed" },
              }
            : {
                status: "terminal",
                outcome: { status: "failed", error: { message: "payment failed" } },
              },
        taskContext,
      );
    },
  },
  // Runs only after every payment is done, so the refunds have already happened.
  abort: async (_task, runtime, taskContext) => {
    console.log("  checkout aborted");
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    );
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "checkout", tasks: [Payment, Checkout] }));
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
const databasePath = join(directory, "session.sqlite");
const open = async () =>
  Harness.open(
    await openNodeSqliteStorage(databasePath),
    { models: createModels(), registry },
    context,
  );
/** Print the live tasks as a tree along their owner edges. */
function printGraph(graph: TaskGraph): void {
  const nodes = Object.values(graph.tasks);
  const print = (node: TaskGraphNode, depth: number): void => {
    const state = node.state;
    const status =
      state.status === "waiting" ? `waiting on ${state.on.join(", ")}` : state.status;
    console.log(`  ${"  ".repeat(depth)}${node.kind} ${node.id}: ${status}`);
    for (const child of nodes.filter((candidate) => candidate.owner === node.id))
      print(child, depth + 1);
  };
  for (const node of nodes.filter((candidate) => candidate.owner === undefined))
    print(node, 0);
}
const checkout = (root: Conversation, cards: string[]) =>
  root.commit(
    (tx) => tx.createTask(Checkout, { cards }, { ownership: { kind: "conversation" } }),
    context,
  );

let harness = await open();
let root = await harness.root(context);

console.log("One card is declined:");
let id = await checkout(root, ["visa-1", "expired-2", "visa-3", "visa-4"]);
console.log(
  `  checkout: ${(await harness.waitForTask(id, context)).state.outcome.status}`,
);

console.log("The customer cancels:");
id = await checkout(root, ["visa-5", "visa-6", "visa-7", "visa-8"]);
harness.resume();
await new Promise((resolve) => setTimeout(resolve, 20));
const graph = await harness.watchTaskGraph(context);
printGraph(graph.value);
await graph.stop();
// abortTask 取消任务，顺序是先子后父
await harness.abortTask(id, context);
console.log(
  `  checkout: ${(await harness.waitForTask(id, context)).state.outcome.status}`,
);

console.log("The process stops while the payments run, and a new one continues:");
id = await checkout(root, ["visa-9", "visa-10", "visa-11", "visa-12"]);
await new Promise((resolve) => setTimeout(resolve, 20));
await harness.close(context);
harness = await open();
root = await harness.root(context);
console.log(
  `  checkout: ${(await harness.waitForTask(id, context)).state.outcome.status}`,
);

await harness.close(context);
await rm(directory, { recursive: true, force: true });

/*
预期输出：
One card is declined:
  payment visa-1 aborted, refunded
  payment visa-3 aborted, refunded
  payment visa-4 aborted, refunded
  payments: aborted, failed, aborted, aborted
  checkout: failed
The customer cancels:
  example.checkout 12: waiting on 13, 14, 15, 16
    example.payment 13: sleeping
    example.payment 14: sleeping
    example.payment 15: sleeping
    example.payment 16: sleeping
  payment visa-5 aborted, refunded
  payment visa-6 aborted, refunded
  payment visa-7 aborted, refunded
  payment visa-8 aborted, refunded
  checkout aborted
  checkout: aborted
The process stops while the payments run, and a new one continues:
  payments: completed, completed, completed, completed
  checkout: completed
*/
