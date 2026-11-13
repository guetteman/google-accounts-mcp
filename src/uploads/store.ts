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
import type { Identity } from "../once/identity";

export const LINK_LIFETIME = 15 * 60_000;
export type UploadId = string & { readonly __uploadId: unique symbol };
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const parseUploadId = (value: unknown): UploadId | null =>
  isUuid(value) ? (value as UploadId) : null;
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
type UploadPlaceholders = {
  connection: string;
  generation: string;
  now: string;
  email: string;
  identity: string;
};
const usableUpload = (p: UploadPlaceholders) =>
  `connection_id = ${p.connection} AND generation = ${p.generation}
   AND expires_at > ${p.now} AND file IS NOT NULL AND ${live(p.now, p.email)}
   AND (identity IS NULL OR identity = ${p.identity})`;
const placeholders = { connection: "?2", generation: "?3", now: "?4", email: "?5", identity: "?6" };
const uploadValues = (ctx: CallContext, ids: readonly UploadId[], identity: Identity | null) =>
  [
    JSON.stringify(ids),
    ctx.connection.connectionId,
    ctx.owner.generation,
    ctx.now(),
    ctx.owner.email,
    identity,
  ] as const;
const openRefs = async (ctx: CallContext, rows: readonly { id: string; file: string }[]) =>
  new Map(
    await Promise.all(
      rows.map(async (row) => {
        const opened = await open(ctx.config.tokenKey, `${row.id}:upload`, row.file as Sealed);
        if (!opened.ok) throw new Unavailable();
        return [row.id, Schema.decodeUnknownSync(UploadRef)(JSON.parse(opened.value))] as const;
      }),
    ),
  );
/** Partial references are only for sealing an approval; its batch decides usability. */
export const readApprovalUploads = (
  ctx: CallContext,
  ids: readonly UploadId[],
  identity: Identity | null,
) =>
  Effect.tryPromise({
    try: async () => {
      if (!ids.length) return new Map<string, UploadRef>();
      const rows = await ctx.db
        .prepare(`SELECT id,file FROM uploads
        WHERE id IN (SELECT value FROM json_each(?1)) AND ${usableUpload(placeholders)}`)
        .bind(...uploadValues(ctx, ids, identity))
        .all<{ id: string; file: string }>();
      return openRefs(ctx, rows.results);
    },
    catch: () => new Unavailable(),
  });
export const missingUploadStatement = (
  ctx: CallContext,
  ids: readonly UploadId[],
  identity: Identity | null,
) =>
  ctx.db
    .prepare(`SELECT wanted.value AS id FROM json_each(?1) wanted
    WHERE NOT EXISTS (SELECT 1 FROM uploads WHERE id = wanted.value AND ${usableUpload(placeholders)})
    ORDER BY wanted.key LIMIT 1`)
    .bind(...uploadValues(ctx, ids, identity));
/** A single UPDATE reserves the complete set, or changes none of it. */
export const holdUploads = (ctx: CallContext, ids: readonly UploadId[], identity: Identity) =>
  Effect.tryPromise({
    try: async () => {
      if (!ids.length) return { refs: new Map<string, UploadRef>(), missing: null };
      const rows = await ctx.db.batch([
        ctx.db
          .prepare(`UPDATE uploads SET identity = ?6 WHERE id IN (SELECT value FROM json_each(?1))
          AND ${usableUploadsWhere({ ...placeholders, ids: "?1", count: "json_array_length(?1)" })} RETURNING id,file`)
          .bind(...uploadValues(ctx, ids, identity)),
        missingUploadStatement(ctx, ids, identity),
      ]);
      return {
        refs: await openRefs(ctx, rows[0]!.results as { id: string; file: string }[]),
        missing: (rows[1]!.results[0] as { id: UploadId } | undefined)?.id ?? null,
      };
    },
    catch: () => new Unavailable(),
  });
export const releaseUploads = (ctx: CallContext, ids: readonly UploadId[], identity: Identity) =>
  Effect.tryPromise({
    try: () =>
      ctx.db
        .prepare(`UPDATE uploads SET identity = NULL WHERE id IN (SELECT value FROM json_each(?1))
      AND connection_id = ?2 AND generation = ?3 AND identity = ?4`)
        .bind(JSON.stringify(ids), ctx.connection.connectionId, ctx.owner.generation, identity)
        .run(),
    catch: () => new Unavailable(),
  }).pipe(Effect.asVoid);
export const dropUploads = (ctx: CallContext, ids: readonly UploadId[], identity: Identity) =>
  Effect.tryPromise({
    try: () =>
      ctx.db
        .prepare(
          `DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?1)) AND connection_id = ?2 AND generation = ?3 AND identity = ?4`,
        )
        .bind(JSON.stringify(ids), ctx.connection.connectionId, ctx.owner.generation, identity)
        .run(),
    catch: () => new Unavailable(),
  }).pipe(Effect.asVoid);
/** All placeholders come from stores, never from request data. */
export const usableUploadsWhere = (
  p: UploadPlaceholders & {
    ids: string;
    count: string;
  },
) =>
  `(SELECT count(*) FROM uploads WHERE id IN (SELECT value FROM json_each(${p.ids})) AND ${usableUpload(p)}) = ${p.count}`;
export const deleteApprovalUploadsStatement = (
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
