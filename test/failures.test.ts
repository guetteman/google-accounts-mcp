import { expect, it } from "vite-plus/test";
import { classify, ToolFailure } from "../src/mcp/failures";
import type { ToolAnnotations } from "../src/mcp/tools";
import { parseConnectionId } from "../src/connections/model";
import { PERSONAL, unavailableMessage } from "./support/permissions";

it.each<{
  name: string;
  unknown: boolean;
  annotations?: ToolAnnotations;
  message: string;
}>([
  {
    name: "an unconfirmed change that is not idempotent",
    unknown: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    message: `Google did not confirm the request for ${PERSONAL}. It may have taken effect.`,
  },
  {
    name: "a failure without annotations",
    unknown: true,
    message: unavailableMessage(PERSONAL),
  },
  {
    name: "a read-only tool's lost response",
    unknown: true,
    annotations: { readOnlyHint: true },
    message: unavailableMessage(PERSONAL),
  },
  {
    name: "a refused change",
    unknown: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    message: unavailableMessage(PERSONAL),
  },
])("classifies an unavailable request for $name", ({ unknown, annotations, message }) => {
  expect(
    classify(
      new ToolFailure({ code: "google_unavailable", unknown }),
      { approved: false, aborted: false },
      {
        input: PERSONAL,
        email: PERSONAL,
        origin: "https://mail.example.com",
        tool: "test_tool",
        connection: parseConnectionId("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")!,
        annotations,
      },
    ),
  ).toEqual({ audit: unknown ? null : "failed", error: { code: "google_unavailable", message } });
});

it.each([
  {
    code: "google_unavailable",
    audit: "failed",
    message: `Nothing was sent from ${PERSONAL}. Google did not confirm a step before the send, so a draft of this mail may be left in Drafts. Ask the owner to delete it there, then call again with the same arguments.`,
  },
  {
    code: "server_unavailable",
    audit: "failed",
    message:
      "The server could not complete the call. Try again later. A draft of this mail may be left in Drafts. Ask the owner to delete it there.",
  },
  {
    code: "tool_not_allowed",
    audit: "refused",
    message: `The owner has not allowed send_message on ${PERSONAL} for this connection. The owner can change this at https://mail.example.com/connections/aaaaaaaa-aaaa-4aaa-8aaa-000000000001. A draft of this mail may be left in Drafts. Ask the owner to delete it there.`,
  },
  {
    code: "account_not_available",
    audit: "refused",
    message: `No account "${PERSONAL}" is available to this connection. Call list_accounts to see the accounts you can use. A draft of this mail may be left in Drafts. Ask the owner to delete it there.`,
  },
  {
    code: "message_not_sendable",
    audit: "refused",
    message: `Gmail refused this message from ${PERSONAL}. Check that every address is valid. A draft of this mail may be left in Drafts. Ask the owner to delete it there.`,
  },
] as const)(
  "reports a leftover draft without changing the released $code outcome",
  ({ code, audit, message }) => {
    const failure = new ToolFailure({
      code,
      released: true,
      leftover: true,
      ...(code === "message_not_sendable" ? { unsendable: { draft: null } } : {}),
    });
    for (const approved of [false, true]) {
      expect(
        classify(
          failure,
          { approved, aborted: true },
          {
            input: PERSONAL,
            email: PERSONAL,
            origin: "https://mail.example.com",
            tool: "send_message",
            connection: parseConnectionId("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")!,
          },
        ),
      ).toEqual({ audit, error: { code, message } });
    }
  },
);
