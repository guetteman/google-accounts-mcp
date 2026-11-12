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
