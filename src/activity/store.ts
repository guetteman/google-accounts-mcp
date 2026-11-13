import { Effect, Schema } from "effect";
import type { AccountId } from "../accounts/model";
import type { CallId, Outcome } from "../calls/store";
import { APP_LABELS, type App, type ConnectionId, type ConnectionView } from "../connections/model";
import { Unavailable } from "../db";
import { TOOLS } from "../mcp/tools";
import type { Owner } from "../owner/owner";

export type ActivityFilter =
  | { readonly kind: "connection"; readonly id: ConnectionId }
  | { readonly kind: "account"; readonly id: AccountId }
  | { readonly kind: "outcome"; readonly outcome: Outcome | "unknown" };
export interface ActivityQuery {
  readonly filter: ActivityFilter | null;
  readonly before: CallId | null;
}
export interface ActivityConnection {
  readonly id: ConnectionId;
  readonly name: string;
  readonly appLabel: string;
  readonly status: ConnectionView["status"];
}
export interface ActivityAccount {
  readonly id: AccountId;
  readonly name: string;
  readonly email: string;
  readonly removedOn: string | null;
}
export interface ActivityRecord {
  readonly id: CallId;
  readonly connection: ActivityConnection;
  readonly account: ActivityAccount | null;
  readonly tool: {
    readonly name: string;
    readonly label: string;
    readonly kind: "plain" | "account";
  } | null;
  readonly outcome: Outcome | "unknown";
  readonly also: ReadonlyArray<{
    readonly account: ActivityAccount;
    readonly tool: { readonly name: string; readonly label: string };
  }>;
  readonly time: {
    readonly iso: string;
    readonly short: string;
    readonly full: string;
    readonly today: boolean;
  };
  readonly approval: {
    readonly id: string;
    readonly state: "waiting" | "approved" | "rejected" | "expired" | "refused";
    readonly decidedOn: string | null;
  } | null;
}
export interface ActivityLoad {
  readonly records: ReadonlyArray<ActivityRecord>;
  readonly older: CallId | null;
  readonly connections: ReadonlyArray<ActivityConnection>;
  readonly accounts: ReadonlyArray<ActivityAccount>;
}

interface ConnectionRow {
  id: ConnectionId;
  name: string;
  app: App;
  state: "active" | "revoked";
  expires_at: number;
  revoked_at: number | null;
}
interface AccountRow {
  id: AccountId;
  name: string;
  email: string;
  state: "live" | "removed";
  removed_at: number | null;
}
interface RecordRow {
  id: CallId;
  connection_id: ConnectionId;
  account_id: AccountId | null;
  tool: string | null;
  at: number;
  outcome: Outcome | null;
  also: string | null;
  approval_id: string | null;
  approval_state: NonNullable<ActivityRecord["approval"]>["state"];
  decided_at: number | null;
}

const date = (at: number, now: number) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(new Date(at).getUTCFullYear() === new Date(now).getUTCFullYear()
      ? {}
      : { year: "numeric" }),
  }).format(at);
const clock = (at: number) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(
    at,
  );
const fullTime = (at: number) =>
  `${new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(at)} at ${clock(at)} UTC`;

// These lists hold no credentials or permission summaries, and include ended/removed entries.
const connectionsStatement = (db: D1Database, owner: Owner) =>
  db
    .prepare(`
  SELECT c.id, c.name, c.app, c.state, c.expires_at, c.revoked_at FROM connections c
  WHERE c.generation = ?1 AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1
    AND o.state = 'pinned' AND o.generation = c.generation AND o.email = ?2)
  ORDER BY c.created_at, c.id`)
    .bind(owner.generation, owner.email);
const accountsStatement = (db: D1Database, owner: Owner) =>
  db
    .prepare(`
  SELECT a.id, a.name, a.email, a.state, a.removed_at FROM accounts a
  WHERE a.generation = ?1 AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1
    AND o.state = 'pinned' AND o.generation = a.generation AND o.email = ?2)
  ORDER BY a.created_at, a.id`)
    .bind(owner.generation, owner.email);

function recordsStatement(db: D1Database, query: ActivityQuery) {
  const { filter, before } = query;
  const values: (string | number | null)[] = [];
  let source = "calls c";
  let where = "";
  let order = "c.id";
  switch (filter?.kind) {
    case "connection":
      where = "WHERE c.connection_id = ?1";
      values.push(filter.id);
      break;
    case "outcome":
      where = "WHERE c.outcome IS ?1";
      values.push(filter.outcome === "unknown" ? null : filter.outcome);
      break;
    case "account":
      source = "call_accounts u JOIN calls c ON c.id = u.call_id";
      where = "WHERE u.account_id = ?1";
      order = "u.call_id";
      values.push(filter.id);
      break;
  }
  if (before !== null) {
    values.push(before);
    where += ` ${where ? "AND" : "WHERE"} ${order} < ?${values.length}`;
  }
  return db
    .prepare(`SELECT c.id, c.connection_id, c.account_id, c.tool, c.at, c.outcome, c.also,
    p.id AS approval_id, p.state AS approval_state, p.decided_at
    FROM ${source}
    LEFT JOIN approvals p ON p.call_id = c.id AND p.connection_id = c.connection_id
    ${where}
    ORDER BY ${order} DESC LIMIT 26`)
    .bind(...values);
}

const OtherAccounts = Schema.Array(Schema.Struct({ account: Schema.String, tool: Schema.String }));
const decodeAlso = Schema.decodeUnknownSync(OtherAccounts);
const toolOf = (name: string): NonNullable<ActivityRecord["tool"]> => {
  const tool = TOOLS.find((tool) => tool.name === name);
  return { name, label: tool?.label ?? name, kind: tool?.kind ?? "account" };
};
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing activity name");
  return value;
};

export const readActivity = (
  db: D1Database,
  owner: Owner,
  query: ActivityQuery,
  now: number,
): Effect.Effect<ActivityLoad, Unavailable> =>
  Effect.tryPromise({
    try: async () => {
      const result = await db.batch([
        connectionsStatement(db, owner),
        accountsStatement(db, owner),
        recordsStatement(db, query),
      ]);
      const connections = (result[0]!.results as unknown as ConnectionRow[]).map(
        (row): ActivityConnection => ({
          id: row.id,
          name: row.name,
          appLabel: APP_LABELS[row.app],
          status:
            row.state === "revoked"
              ? { kind: "revoked", on: date(row.revoked_at!, now) }
              : row.expires_at <= now
                ? { kind: "expired", on: date(row.expires_at, now) }
                : { kind: "active" },
        }),
      );
      const accounts = (result[1]!.results as unknown as AccountRow[]).map(
        (row): ActivityAccount => ({
          id: row.id,
          name: row.name,
          email: row.email,
          removedOn: row.state === "removed" ? date(row.removed_at!, now) : null,
        }),
      );
      const connectionById = new Map<string, ActivityConnection>(connections.map((c) => [c.id, c]));
      const accountById = new Map<string, ActivityAccount>(accounts.map((a) => [a.id, a]));
      const rows = result[2]!.results as unknown as RecordRow[];
      const records = rows.slice(0, 25).map((row): ActivityRecord => {
        const iso = new Date(row.at).toISOString();
        const today = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
        return {
          id: row.id,
          connection: required(connectionById.get(row.connection_id)),
          account: row.account_id === null ? null : required(accountById.get(row.account_id)),
          tool: row.tool === null ? null : toolOf(row.tool),
          outcome: row.outcome ?? "unknown",
          also: decodeAlso(row.also === null ? [] : JSON.parse(row.also)).map((use) => ({
            account: required(accountById.get(use.account)),
            tool: toolOf(use.tool),
          })),
          time: {
            iso,
            today,
            short: today ? clock(row.at) : `${date(row.at, now)}, ${clock(row.at)}`,
            full: fullTime(row.at),
          },
          approval:
            row.approval_id === null
              ? null
              : {
                  id: row.approval_id,
                  state: row.approval_state,
                  decidedOn: row.decided_at === null ? null : fullTime(row.decided_at),
                },
        };
      });
      return { records, connections, accounts, older: rows.length > 25 ? records[24]!.id : null };
    },
    catch: () => new Unavailable(),
  });
