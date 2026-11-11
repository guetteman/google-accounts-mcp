import { Effect } from "effect";
import { ToolFailure, type CallContext } from "../mcp/call";
import { parseApprovalId, isoSeconds } from "./model";
import { readApproval } from "./store";
import { storedPayload } from "./view";
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
          expires_at: isoSeconds(row.expires_at),
          message:
            "The owner has not decided yet. Give the owner this link in your reply and end your turn.",
        };
      case "approved": {
        if (row.outcome === null)
          return {
            status: "running",
            message:
              "The owner approved the call and it is still running. Call get_approval again in a few seconds.",
          };
        const payload = yield* Effect.tryPromise({
          try: () => storedPayload(row, ctx.config.tokenKey),
          catch: () => new ToolFailure({ code: "server_unavailable" }),
        });
        return {
          status: row.outcome,
          ...payload,
          ...(row.result_too_large && row.outcome === "success"
            ? {
                message: "The call succeeded, but its result was too large for the server to keep.",
              }
            : {}),
        };
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
