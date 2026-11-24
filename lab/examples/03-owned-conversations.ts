// 对应官方示例 03-owned-conversations.ts（v1.6.0）；机制见 docs/1-core/4-orchestration.md §2
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type ConversationId,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const Supervisor = defineTask<
  null,
  { phase: "spawn" } | { phase: "report" },
  ConversationId
>({
  name: "example.supervisor",
  version: 1,
  initial: () => ({ phase: "spawn" }),
  phases: {
    spawn: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1))
          .items[0];
        if (existing === undefined) {
          await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
        }
        return { status: "running", checkpoint: { phase: "report" } } as const;
      }, context);
    },
    report: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const child = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
        if (child === undefined) throw new Error("child conversation is missing");
        return {
          status: "terminal",
          outcome: { status: "completed", result: child.id },
        } as const;
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }) as const,
      context,
    );
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "example.supervisor", tasks: [Supervisor] }));

const harness = await Harness.open(
  new MemoryStorage(),
  { models: createModels(), registry },
  context,
);
const root = await harness.root(context);

const taskId = await root.commit(
  (tx) => tx.createTask(Supervisor, null, { ownership: { kind: "conversation" } }),
  context,
);

const settled = await harness.waitForTask(taskId, context);
const outcome = settled.state.outcome;
if (outcome.status !== "completed") throw new Error(`task ended: ${outcome.status}`);

const record = await harness.commit((tx) => tx.conversation(outcome.result), context);
console.log("task:", settled.id, "outcome:", outcome.status, "child:", outcome.result);
console.log("child record:", record);

await harness.close(context);

/*
预期输出：
task: <数字> outcome: completed child: <数字>
child record: { id: <数字>, owner: { conversationId: <根会话 ID>, taskId: <上面的 task 数字> } }
*/
