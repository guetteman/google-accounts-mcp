import { Effect, Result, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { notFound, ToolFailure } from "../mcp/failures";
import { viewDate, type ViewNote, type ViewValue } from "../approvals/model";
import { change, changeEach, listLabels, REQUESTS_AT_ONCE, threadSummary } from "./gmail";
import { shorten } from "./bounds";

export const MAX_LABELS = 100;
/** Labels that the arguments alone refuse: the trash tools own two, and Gmail sets two itself. */
export const REFUSED: ReadonlySet<string> = new Set(["TRASH", "SPAM", "SENT", "DRAFT"]);
/** What `add` and `remove` must be, for invalid_arguments from the schema and from the run. */
export const LABELS_EXPECT = `a list of at most ${MAX_LABELS} label IDs that list_labels returned. Of the system labels, only INBOX, UNREAD, STARRED, IMPORTANT, and the five CATEGORY_ labels are accepted. A label cannot be in both add and remove, and the two lists together need at least one label`;

interface LabelChange {
  threads: readonly string[];
  add: readonly string[];
  remove: readonly string[];
}
interface Named {
  id: string;
  name: string | null;
}
interface ChangeResult {
  account: string;
  threads: Array<{ thread: string; labels: string[] }>;
  not_found?: string[];
  unconfirmed?: string[];
}
const ACCEPTED: ReadonlySet<string> = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

const named = (send: Send, change: LabelChange) =>
  Effect.gen(function* () {
    const labels = yield* listLabels(send);
    const byId = new Map(labels.map((label) => [label.id, label] as const));
    for (const field of ["add", "remove"] as const) {
      if (change[field].some((id) => byId.get(id)?.type === "system" && !ACCEPTED.has(id)))
        return yield* Effect.fail(
          new ToolFailure({
            code: "invalid_arguments",
            field: { name: field, expects: LABELS_EXPECT },
          }),
        );
    }
    const names = (ids: readonly string[]): Named[] =>
      ids.map((id) => ({ id, name: byId.get(id)?.name ?? null }));
    return { add: names(change.add), remove: names(change.remove) };
  });

const Modified = Schema.Struct({
  messages: Schema.NonEmptyArray(
    Schema.Struct({ labelIds: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
});
const modify = (send: Send, thread: string, input: LabelChange) =>
  change(
    send,
    "POST",
    `threads/${encodeURIComponent(thread)}/modify`,
    Modified,
    (status) =>
      status === 404 || status === 400
        ? notFound("thread", thread)
        : new ToolFailure({ code: "google_unavailable" }),
    {
      ...(input.add.length ? { addLabelIds: input.add } : {}),
      ...(input.remove.length ? { removeLabelIds: input.remove } : {}),
    },
  ).pipe(
    Effect.map((answer) => ({
      thread,
      labels: [...new Set(answer.messages.flatMap((message) => message.labelIds ?? []))],
    })),
  );

export const changeLabels = (
  send: Send,
  input: LabelChange & { account: string },
): Effect.Effect<ChangeResult, ToolFailure> =>
  Effect.gen(function* () {
    const labels = yield* named(send, input);
    const missing = [...labels.add, ...labels.remove].find((label) => label.name === null);
    if (missing) return yield* Effect.fail(notFound("label", missing.id));
    const { changed, not_found, unconfirmed } = yield* changeEach(
      "thread",
      input.threads,
      (thread) => modify(send, thread, input),
    );
    return {
      account: input.account,
      threads: changed,
      ...(not_found.length ? { not_found } : {}),
      ...(unconfirmed.length ? { unconfirmed } : {}),
    };
  });

export const labelChangeNotes = (change: LabelChange): ReadonlyArray<ViewNote> => {
  const singular = change.threads.length === 1;
  const threads = singular ? "this thread" : "these threads";
  const notes: ViewNote[] = [];
  if (change.remove.includes("INBOX"))
    notes.push({
      text: `This call archives ${threads}: ${singular ? "it leaves" : "they leave"} the inbox.`,
      warning: false,
    });
  if (change.add.includes("INBOX"))
    notes.push({ text: `This call moves ${threads} to the inbox.`, warning: false });
  if (change.remove.includes("UNREAD"))
    notes.push({ text: `This call marks ${threads} as read.`, warning: false });
  if (change.add.includes("UNREAD"))
    notes.push({ text: `This call marks ${threads} as unread.`, warning: false });
  return notes;
};

export const labelChangeValues = (
  send: Send,
  change: LabelChange,
): Effect.Effect<ReadonlyArray<ViewValue>, ToolFailure> =>
  Effect.gen(function* () {
    const labels = yield* named(send, change);
    const values: ViewValue[] = [];
    for (const field of ["add", "remove"] as const) {
      const found = labels[field].flatMap((label) => (label.name === null ? [] : [label.name]));
      const missing = labels[field].filter((label) => label.name === null).map((label) => label.id);
      if (found.length)
        values.push({ name: `Labels to ${field}`, text: found.join("\n"), from: "gmail" });
      if (missing.length)
        values.push({
          name: `Label IDs to ${field}, not found in this account`,
          text: missing.join("\n"),
          from: "agent",
        });
    }
    const threads = yield* Effect.forEach(
      change.threads,
      (thread, index) =>
        Effect.gen(function* () {
          const prefix = change.threads.length === 1 ? "Thread" : `Thread ${index + 1}`;
          const result = yield* Effect.result(threadSummary(send, thread));
          if (Result.isFailure(result)) {
            if (result.failure.code === "not_found")
              return [
                {
                  name: `${prefix} ID, not found in this account`,
                  text: thread,
                  from: "agent" as const,
                },
              ];
            return yield* Effect.fail(result.failure);
          }
          const summary = result.success;
          return [
            {
              name: `${prefix} subject`,
              text: shorten(summary.subject, 500),
              from: "gmail" as const,
            },
            {
              name: `${prefix} messages`,
              text: String(summary.messages.length),
              from: "gmail" as const,
            },
            {
              name: `${prefix} last from`,
              text: shorten(summary.from, 500),
              from: "gmail" as const,
            },
            { name: `${prefix} last date`, text: viewDate(summary.date), from: "gmail" as const },
          ];
        }),
      { concurrency: REQUESTS_AT_ONCE },
    );
    return [...values, ...threads.flat()];
  });
