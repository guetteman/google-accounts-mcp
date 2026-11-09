import { expect, it } from "vite-plus/test";
import { Browser } from "./support/browser";
import { rows } from "./support/connections";
import { codeClient, expectOAuthError, McpClient } from "./support/oauth";
import { callWorker, ORIGIN } from "./support/worker";

it("binds each origin's metadata, consent, code and tokens to that origin", async () => {
  const otherOrigin = "https://other.example.com";
  const browser = new Browser();
  for (const origin of [ORIGIN, otherOrigin]) {
    const metadata = await browser.get(`${origin}/.well-known/oauth-authorization-server`);
    expect(await metadata.json()).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      protected_resources: [`${origin}/mcp`],
    });
    const resource = await browser.get(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(await resource.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
  }

  const first = new McpClient();
  await first.authorize();
  await first.approve();
  const other = new McpClient(codeClient, otherOrigin);
  await expectOAuthError(
    await other.token({
      grant_type: "authorization_code",
      code: first.code!,
      redirect_uri: first.callback,
      code_verifier: first.verifier,
      resource: `${otherOrigin}/mcp`,
    }),
    "invalid_grant",
  );
  expect(await rows()).toEqual([]);
  await first.keepTokens(await first.exchange());
  const denied = await callWorker(
    new Request(`${otherOrigin}/mcp`, {
      headers: { Authorization: `Bearer ${first.tokens!.access_token}` },
    }),
  );
  expect(denied.status).toBe(401);
  expect(denied.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  await expectOAuthError(
    await other.token({
      grant_type: "refresh_token",
      refresh_token: first.tokens!.refresh_token,
      resource: `${otherOrigin}/mcp`,
    }),
    "invalid_grant",
  );
  await first.keepTokens(await first.refresh());
  expect((await first.call()).status).toBe(200);

  await other.connect("Other origin");
  await other.keepTokens(await other.refresh());
  expect((await other.call()).status).toBe(200);
  // A later consent at the first origin must not reuse the second provider's helpers.
  const again = await new McpClient().connect("First origin again");
  expect((await again.call()).status).toBe(200);
  expect(await rows()).toHaveLength(3);
});
