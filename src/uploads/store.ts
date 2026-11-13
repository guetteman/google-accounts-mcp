import { Effect, Schema } from "effect";
import type { Config } from "../config";
import { Unavailable } from "../db";
import { activeWhere } from "../connections/store";
import { FileRef, putFile, type FileData } from "../files/store";
import type { CallContext } from "../mcp/call";
import type { Owner } from "../owner/owner";
import type { ApprovalId } from "../approvals/model";
import { APPROVAL_LIFETIME } from "../approvals/model";
import { open, seal, type Sealed } from "../seal";

export const LINK_LIFETIME = 15 * 60_000;
export type UploadId = string & { readonly __uploadId: unique symbol };
export const parseUploadId = (value: unknown): UploadId | null =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? (value as UploadId)
    : null;
export const UploadRef = Schema.Struct({
  ...FileRef.fields,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type UploadRef = typeof UploadRef.Type;
type LinkContext = { db: D1Database; files: KVNamespace; config: Config; owner: Owner };
const live = (now: string, email: string) => `EXISTS (
  SELECT 1 FROM connections c WHERE c.id = uploads.connection_id AND c.generation = uploads.generation
  AND ${activeWhere({ now, ownerEmail: email })})`;

export const createLink = (ctx: CallContext) =>
  Effect.tryPromise({
    try: async () => {
      const link = crypto.randomUUID();
      const expiresAt = ctx.now() + LINK_LIFETIME;
      const row = await ctx.db
        .prepare(`INSERT INTO uploads (id,link,generation,connection_id,expires_at)
      SELECT ?1,?2,?3,c.id,?4 FROM connections c WHERE c.id = ?5 AND c.generation = ?3
      AND ${activeWhere({ now: "?6", ownerEmail: "?7" })} RETURNING id`)
        .bind(
          crypto.randomUUID(),
          link,
          ctx.owner.generation,
          expiresAt,
          ctx.connection.connectionId,
          ctx.now(),
          ctx.owner.email,
        )
        .first();
      return row ? { link, expiresAt } : null;
    },
    catch: () => new Unavailable(),
  });
export const liveLink = (ctx: LinkContext, link: string, now: number) =>
  Effect.tryPromise({
    try: () =>
      ctx.db
        .prepare(`SELECT expires_at AS expiresAt FROM uploads WHERE link = ?1 AND generation = ?2
    AND file IS NULL AND expires_at > ?3 AND ${live("?3", "?4")}`)
        .bind(link, ctx.owner.generation, now, ctx.owner.email)
        .first<{ expiresAt: number }>(),
    catch: () => new Unavailable(),
  });
export const storeFile = (ctx: LinkContext, link: string, file: FileData, now: number) =>
  Effect.tryPromise({
    try: async () => {
      const row = await ctx.db
        .prepare(`SELECT id,expires_at FROM uploads WHERE link = ?1 AND generation = ?2
      AND file IS NULL AND expires_at > ?3 AND ${live("?3", "?4")}`)
        .bind(link, ctx.owner.generation, now, ctx.owner.email)
        .first<{ id: string; expires_at: number }>();
      if (!row) return null;
      const ref = await Effect.runPromise(
        putFile(ctx.files, file, row.expires_at + APPROVAL_LIFETIME),
      );
      const sealed = await seal(
        ctx.config.tokenKey,
        `${row.id}:upload`,
        JSON.stringify({ ...ref, size: file.bytes.byteLength }),
      );
      const stored = await ctx.db
        .prepare(`UPDATE uploads SET file = ?1 WHERE id = ?2 AND generation = ?3
      AND file IS NULL AND expires_at > ?4 AND ${live("?4", "?5")} RETURNING id`)
        .bind(sealed, row.id, ctx.owner.generation, Date.now(), ctx.owner.email)
        .first<{ id: string }>();
      return stored ? { upload: stored.id as UploadId, expiresAt: row.expires_at } : null;
    },
    catch: () => new Unavailable(),
  });
export const readUploads = (ctx: CallContext, ids: readonly UploadId[]) =>
  Effect.tryPromise({
    try: async (): Promise<ReadonlyMap<string, UploadRef> | null> => {
      if (!ids.length) return new Map();
      const rows = await ctx.db
        .prepare(`SELECT id,file FROM uploads WHERE id IN (SELECT value FROM json_each(?1))
      AND connection_id = ?2 AND generation = ?3 AND expires_at > ?4 AND file IS NOT NULL AND ${live("?4", "?5")}`)
        .bind(
          JSON.stringify(ids),
          ctx.connection.connectionId,
          ctx.owner.generation,
          ctx.now(),
          ctx.owner.email,
        )
        .all<{ id: string; file: string }>();
      if (rows.results.length !== ids.length) return null;
      const refs = await Promise.all(
        rows.results.map(async (row) => {
          const opened = await open(ctx.config.tokenKey, `${row.id}:upload`, row.file as Sealed);
          if (!opened.ok) throw new Unavailable();
          return [row.id, Schema.decodeUnknownSync(UploadRef)(JSON.parse(opened.value))] as const;
        }),
      );
      return new Map(refs);
    },
    catch: () => new Unavailable(),
  });
export const dropUploads = (ctx: CallContext, ids: readonly UploadId[]) =>
  Effect.tryPromise({
    try: () =>
      ctx.db
        .prepare(
          `DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?1)) AND connection_id = ?2 AND generation = ?3`,
        )
        .bind(JSON.stringify(ids), ctx.connection.connectionId, ctx.owner.generation)
        .run(),
    catch: () => new Unavailable(),
  }).pipe(Effect.asVoid);
/** All placeholders come from the approval store, never from request data. */
export const usableUploadsWhere = (p: {
  ids: string;
  count: string;
  connection: string;
  generation: string;
  now: string;
  email: string;
}) =>
  `(SELECT count(*) FROM uploads WHERE id IN (SELECT value FROM json_each(${p.ids})) AND connection_id = ${p.connection}
    AND generation = ${p.generation} AND expires_at > ${p.now} AND file IS NOT NULL AND ${live(p.now, p.email)}) = ${p.count}`;
export const moveUploadsStatement = (
  ctx: CallContext,
  ids: readonly UploadId[],
  approval: ApprovalId,
) =>
  ctx.db
    .prepare(`DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?1)) AND connection_id = ?2 AND generation = ?3
    AND EXISTS (SELECT 1 FROM approvals WHERE id = ?4 AND connection_id = ?2 AND generation = ?3)`)
    .bind(JSON.stringify(ids), ctx.connection.connectionId, ctx.owner.generation, approval);
export const cleanupUploadsStatement = (db: D1Database, now: number) =>
  db.prepare("DELETE FROM uploads WHERE expires_at <= ?1").bind(now);
