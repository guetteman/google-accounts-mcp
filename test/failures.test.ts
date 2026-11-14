import { expect, it } from "vite-plus/test";
import { classify, ToolFailure } from "../src/mcp/failures";
import { parseConnectionId } from "../src/connections/model";
import { PERSONAL } from "./support/permissions";

it.each([
  {
    code: "google_unavailable",
    audit: "failed",
    message: `Nothing was sent from ${PERSONAL}. Google did not confirm a step before the send, so a draft of this mail may be left in Drafts. The owner should delete it there before this call is made again.`,
  },
  {
    code: "server_unavailable",
    audit: "failed",
    message:
      "The server could not complete the call. Try again later. A draft of this mail may be left in Drafts. The owner should delete it there before this call is made again.",
  },
  {
    code: "tool_not_allowed",
    audit: "refused",
    message: `The owner has not allowed send_message on ${PERSONAL} for this connection. The owner can change this at https://mail.example.com/connections/aaaaaaaa-aaaa-4aaa-8aaa-000000000001. A draft of this mail may be left in Drafts. The owner should delete it there before this call is made again.`,
  },
  {
    code: "account_not_available",
    audit: "refused",
    message: `No account "${PERSONAL}" is available to this connection. Call list_accounts to see the accounts you can use. A draft of this mail may be left in Drafts. The owner should delete it there before this call is made again.`,
  },
  {
    code: "message_not_sendable",
    audit: "refused",
    message: `Gmail refused this message from ${PERSONAL}. The usual cause is an address that is not valid. A draft of this mail may be left in Drafts. The owner should delete it there before this call is made again.`,
  },
] as const)(
  "reports a leftover draft without changing the released $code outcome",
  ({ code, audit, message }) => {
    for (const draft of [undefined, "staged-9"]) {
      const expected =
        draft === undefined
          ? message
          : message
              .replace("a draft of this mail", 'draft "staged-9" of this mail')
              .replace("A draft of this mail", 'Draft "staged-9" of this mail');
      const failure = new ToolFailure({
        code,
        released: true,
        leftover: draft === undefined ? {} : { draft },
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
        ).toEqual({ audit, reason: code, error: { code, message: expected } });
      }
    }
  },
);

it.each([
  {
    over: { text: true as const },
    message:
      "The text of the original message cannot be carried whole: it is too large, or its HTML could not be converted.",
  },
  {
    over: { attachments: 21, limit: 20 },
    message: "This message would have 21 attachments. The limit is 20.",
  },
  {
    over: { bytes: 12_345, limit: 10_000 },
    message:
      "This message would have 12,345 bytes of attachments and text. The limit is 10,000 bytes.",
  },
])("formats a message's limit from the failure itself (%#)", ({ over, message }) => {
  expect(
    classify(
      new ToolFailure({ code: "message_too_large", over }),
      { approved: false, aborted: false },
      {
        input: PERSONAL,
        email: PERSONAL,
        origin: "https://mail.example.com",
        tool: "forward_message",
        connection: parseConnectionId("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")!,
      },
    ),
  ).toEqual({
    audit: "refused",
    reason: "message_too_large",
    error: { code: "message_too_large", message },
  });
});
