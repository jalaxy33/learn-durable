import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  createRegistry,
  Harness,
  LiveDoc,
  MemoryStorage,
  type Conversation,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

// A fake model with a tiny 3000-token window.
// It answers chat messages, writes summaries when asked to summarize,
// and once rejects a request as too long, the way real providers report a context overflow.
let overflowOnce = false;
let summaries = 0;
// While set, the next chat answer waits for it, which keeps the conversation busy.
let hold: Promise<void> | undefined;
async function respond(transcript: TranscriptContext): Promise<AssistantMessage> {
  const first = transcript.messages[0];
  if (
    first?.role === "system" &&
    typeof first.content === "string" &&
    first.content.includes("summarization")
  ) {
    summaries++;
    return fauxAssistantMessage(`## Goal\nPlan a week in Lisbon (summary #${summaries})`);
  }
  if (overflowOnce) {
    overflowOnce = false;
    return fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "prompt is too long",
    });
  }
  const held = hold;
  hold = undefined;
  await held;
  const question = transcript.messages.findLast((message) => message.role === "user");
  return fauxAssistantMessage(
    `A detailed answer to "${text(question)}": ${"details ".repeat(200)}`,
  );
}
const faux = fauxProvider({
  models: [
    {
      id: "tiny",
      contextWindow: 3000,
      maxTokens: 1000,
    },
  ],
});
faux.setResponses(Array.from({ length: 100 }, () => respond));
const models = createModels();
models.setProvider(faux.provider);

// Generation blocks to compact above 3000 - 1000 = 2000 tokens
// and starts a background compaction above 2000 - 800.
// Settings are read at every use, so the getter makes `backgroundTokens` live.
let backgroundTokens = 800;
const settings = {
  get compaction() {
    return { reserveTokens: 1000, keepRecentTokens: 400, backgroundTokens };
  },
};
const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry: createRegistry(), settings },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "tiny" } },
});

async function ask(question: string): Promise<void> {
  const submission = await root.submit({ type: "input", content: question }, context);
  const record = await submission.wait(context);
  // Let a background compaction started by this turn finish, so its summary shows below.
  const running = (await harness.snapshot(LiveDoc, root.id, context))?.compactions ?? [];
  for (const { taskId } of running) await harness.waitForTask(taskId, context);
  await show(
    root,
    `after "${question}" (${record.status === "done" ? "answered" : record.reason})`,
  );
}

// 1. A long chat:
// once the context crosses the background threshold, a compaction runs while the chat goes on,
// and its summary lands at once when the conversation is idle, otherwise at the next turn boundary.
for (const question of [
  "Where should we stay?",
  "What should we eat?",
  "Which day trips?",
  "Any museums?",
  "Nightlife?",
]) {
  await ask(question);
}

// 2. A manual compaction while an answer is still being written.
// The summary is ready first, waits in the inbox, and is placed right after the answer.
let finishAnswer!: () => void;
hold = new Promise((r) => {
  finishAnswer = r;
});
const busy = await root.submit(
  { type: "input", content: "How do we get around?" },
  context,
);
const manual = await root.compact("Keep the hotel shortlist", context);
const { state } = await harness.waitForTask(manual, context);
const placement =
  state.outcome.status === "completed" ? state.outcome.result.submissionId : undefined;
const summary = (await harness.submission(placement!, context))!;
console.log(
  "\nmanual compaction finished; its summary is",
  (await summary.status(context)).status,
);
finishAnswer();
await busy.wait(context);
console.log("after the answer, the summary is", (await summary.wait(context)).status);
await show(root, "After compact()");

// 3. The provider rejects a request as too long: generation compacts and retries it once.
// Background compaction is turned off so the summary below is the overflow one.
backgroundTokens = 0;
await ask("What should we pack?");
overflowOnce = true;
await ask("Summarize the plan for my partner");

await harness.close(context);

/** Print the model context: one line per message, and the number of stored entries behind it. */
async function show(conversation: Conversation, label: string): Promise<void> {
  const view = await conversation.context(context);
  const stored = (await conversation.entries({}, 1000, undefined, context)).items.length;
  console.log(
    `\n${label}: ${view.messages.length} messages in context, ${stored} entries stored`,
  );
  const reason = CompactionEntry.is(view.head) ? view.head.data.reason : undefined;
  if (reason !== undefined) console.log(`  (${reason} compaction summary first)`);
  for (const message of view.messages) {
    console.log(
      `  ${message.role.padEnd(9)} ${message.role === "system" ? "(system prompt)" : text(message).slice(0, 70)}`,
    );
  }
}

function text(message: Message | undefined): string {
  if (message === undefined || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  const block = message.content.find((content) => content.type === "text");
  return block?.type === "text" ? block.text.replaceAll("\n", " ") : "";
}

/*
预期输出：
after "Where should we stay?" (answered): 2 messages in context, 2 entries stored
  user      Where should we stay?
  assistant A detailed answer to "Where should we stay?": details details details

after "What should we eat?" (answered): 4 messages in context, 4 entries stored
  user      Where should we stay?
  assistant A detailed answer to "Where should we stay?": details details details
  user      What should we eat?
  assistant A detailed answer to "What should we eat?": details details details de

after "Which day trips?" (answered): 6 messages in context, 6 entries stored
  user      Where should we stay?
  assistant A detailed answer to "Where should we stay?": details details details
  user      What should we eat?
  assistant A detailed answer to "What should we eat?": details details details de
  user      Which day trips?
  assistant A detailed answer to "Which day trips?": details details details detai

after "Any museums?" (answered): 4 messages in context, 9 entries stored
  (threshold compaction summary first)
  user      The conversation history before this point was compacted into the foll
  assistant A detailed answer to "Which day trips?": details details details detai
  user      Any museums?
  assistant A detailed answer to "Any museums?": details details details details d

after "Nightlife?" (answered): 7 messages in context, 12 entries stored
  (threshold compaction summary first)
  system    (system prompt)
  user      The conversation history before this point was compacted into the foll
  assistant A detailed answer to "Which day trips?": details details details detai
  user      Any museums?
  assistant A detailed answer to "Any museums?": details details details details d
  user      Nightlife?
  assistant A detailed answer to "Nightlife?": details details details details det

manual compaction finished; its summary is queued
after the answer, the summary is done

After compact(): 4 messages in context, 15 entries stored
  (manual compaction summary first)
  user      The conversation history before this point was compacted into the foll
  assistant A detailed answer to "Nightlife?": details details details details det
  user      How do we get around?
  assistant A detailed answer to "How do we get around?": details details details

after "What should we pack?" (answered): 7 messages in context, 18 entries stored
  (manual compaction summary first)
  system    (system prompt)
  user      The conversation history before this point was compacted into the foll
  assistant A detailed answer to "Nightlife?": details details details details det
  user      How do we get around?
  assistant A detailed answer to "How do we get around?": details details details
  user      What should we pack?
  assistant A detailed answer to "What should we pack?": details details details d

after "Summarize the plan for my partner" (answered): 5 messages in context, 23 entries stored
  (overflow compaction summary first)
  system    (system prompt)
  user      The conversation history before this point was compacted into the foll
  assistant A detailed answer to "What should we pack?": details details details d
  user      Summarize the plan for my partner
  assistant A detailed answer to "Summarize the plan for my partner": details deta
*/
