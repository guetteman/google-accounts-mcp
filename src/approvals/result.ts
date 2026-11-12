import { Effect } from "effect";
import { type CallContext } from "../mcp/call";
import { getFile } from "../files/store";
import { WithFile } from "../mcp/file";
import { ToolFailure } from "../mcp/failures";
import { parseApprovalId, isoSeconds } from "./model";
import { readApproval } from "./store";
import { openResult } from "./text";
export const PENDING_MESSAGE =
  "The owner must approve this call before it runs. Give the owner this link in your reply and end your turn. After the owner tells you that they decided, call get_approval with this approval ID.";
export const pendingAnswer = (origin: string, id: string, expires: number) => ({
  status: "pending",
  approval: id,
  url: `${origin}/approvals/${id}`,
  expires_at: isoSeconds(expires),
  message: PENDING_MESSAGE,
});
export const getApproval = (ctx: CallContext, args: Record<string, unknown> | undefined) =>
  Effect.gen(function* () {
    const id = parseApprovalId(args?.approval);
    if (!id) return yield* Effect.fail(new ToolFailure({ code: "approval_not_available" }));
    const row = yield* readApproval(ctx, id, ctx.now(), ctx.connection.connectionId).pipe(
      Effect.mapError(() => new ToolFailure({ code: "server_unavailable" })),
    );
    if (!row) return yield* Effect.fail(new ToolFailure({ code: "approval_not_available" }));
    switch (row.state) {
      case "waiting":
        return {
          status: "pending",
          url: `${ctx.origin}/approvals/${id}`,
          expires_at: isoSeconds(row.expiresAt),
          message:
            "The owner has not decided yet. Give the owner this link in your reply and end your turn.",
        };
      case "running":
        return {
          status: "running",
          message:
            "The owner approved the call and it is still running. Call get_approval again in a few seconds.",
        };
      case "finished": {
        const result = row.result;
        const payload =
          result === null
            ? null
            : yield* Effect.tryPromise({
                try: () => openResult(ctx.config.tokenKey, id, result),
                catch: () => new ToolFailure({ code: "server_unavailable" }),
              });
        if (payload && "result" in payload && payload.file) {
          const file = yield* getFile(ctx.files, payload.file);
          if (file === null)
            return {
              status: "running",
              message:
                "The owner approved the call and the file is not ready yet. Call get_approval again in one minute.",
            };
          const value = { status: row.outcome, result: payload.result };
          return new WithFile(value, file);
        }
        return { status: row.outcome, ...payload };
      }
      case "refused":
        return {
          status: "refused",
          message:
            "The owner's settings ended this approval before the call ran. Call the tool again to learn what is allowed now.",
        };
      default:
        return { status: row.state };
    }
  });
