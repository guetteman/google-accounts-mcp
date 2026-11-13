import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { activityProps } from "./support/activity";
import { answer } from "./support/approvals";
import { callRows } from "./support/permissions";
import { attaching, attachCall, copy, setTool } from "./support/uploads";

it("finds an actual tool call by both its named account and its attachment's source account", async () => {
  const f = await attaching("create_draft");
  await setTool(f, "get_attachment", "allow", f.northwind);
  await answer(await attachCall(f, [copy], {}, "create_draft"));
  const call = (await callRows()).at(-1)!;
  for (const account of [f.personal, f.northwind]) {
    const response = await f.mcp.browser.get(`/activity?account=${account.id}`);
    expect(response.status).toBe(200);
    const records = activityProps(await response.text()).load.records;
    expect(records.map((r) => r.id)).toEqual([call.id]);
    expect(records[0]).toMatchObject({
      account: { id: f.personal.id },
      tool: { name: "create_draft" },
      also: [{ account: { id: f.northwind.id }, tool: { name: "get_attachment" } }],
    });
  }
});
