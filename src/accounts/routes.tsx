import { Unavailable } from "../db";
import { readForm } from "../http/form";
import { Effect, Result } from "effect";
import { Hono } from "hono";
import type { PageEnv } from "../http/context";
import { ownerOnly } from "../owner/routes";
import { renderPage } from "../pages/render";
import { parseName } from "../names";
import { authorizationUrl, exchangeCode, revoke, GMAIL_SCOPES } from "../google/client";
import { open, seal } from "../seal";
import { newAccountId, parseAccountId } from "./model";
import {
  beginFlow,
  setAlert,
  takeAlert,
  takeFlow,
  type AccountsAlert,
  type FlowStart,
} from "./flow";
import {
  addAccount,
  listAccounts,
  reconnectAccount,
  reconnectTarget,
  removalTarget,
  removeAccount,
  renameAccount,
} from "./store";

export const accountRoutes = new Hono<PageEnv>();
accountRoutes.get("/accounts", ownerOnly, async (c) => {
  const result = await Effect.runPromise(
    Effect.result(listAccounts(c.env.DB, c.get("owner"), c.get("config").tokenKey)),
  );
  if (Result.isFailure(result)) return renderPage({ _tag: "Unavailable" }, { status: 503 });
  const headers = new Headers();
  const alert = takeAlert(c.req.raw, headers);
  return renderPage(
    {
      _tag: "Accounts",
      requiredGmailScopes: GMAIL_SCOPES.length,
      frame: {
        host: new URL(c.req.url).host,
        ownerEmail: c.get("owner").email,
        current: "accounts",
      },
      accounts: result.success,
      alert,
    },
    { headers },
  );
});
for (const purpose of ["add", "reconnect"] as const)
  accountRoutes.post(
    purpose === "add" ? "/accounts/connect" : "/accounts/:id/reconnect",
    ownerOnly,
    readForm,
    async (c) => {
      const owner = c.get("owner");
      let target: { id: import("./model").AccountId; version: number; email: string } | null = null;
      if (purpose === "reconnect") {
        const id = parseAccountId(c.req.param("id"));
        if (!id) return c.json({ outcome: "not_found" }, 404);
        const result = await Effect.runPromise(Effect.result(reconnectTarget(c.env.DB, owner, id)));
        if (Result.isFailure(result)) return c.json({ outcome: "unavailable" }, 503);
        target = result.success;
        if (!target) return c.json({ outcome: "not_found" }, 404);
      }
      const start: FlowStart = target
        ? {
            purpose: "reconnect",
            account: target.id,
            version: target.version,
            generation: owner.generation,
            startedAt: Date.now(),
          }
        : { purpose: "add", generation: owner.generation, startedAt: Date.now() };
      const flow = await beginFlow(start);
      c.header("Set-Cookie", flow.setCookie);
      return c.json({
        outcome: "ok",
        url: authorizationUrl(c.get("config"), {
          origin: new URL(c.req.url).origin,
          state: flow.state,
          challenge: flow.challenge,
          loginHint: target?.email,
        }).href,
      });
    },
  );
accountRoutes.get("/google/callback", ownerOnly, async (c) => {
  const url = new URL(c.req.url);
  const owner = c.get("owner");
  const config = c.get("config");
  const { flow, clearCookie } = takeFlow(
    c.req.raw,
    url.searchParams.get("state") ?? "",
    Date.now(),
  );
  const headers = new Headers({ Location: "/accounts" });
  headers.append("Set-Cookie", clearCookie);
  const reply = (alert: AccountsAlert) => {
    setAlert(headers, alert);
    return new Response(null, { status: 303, headers });
  };
  if (
    !flow ||
    flow.generation !== owner.generation ||
    url.searchParams.has("error") ||
    !url.searchParams.get("code")
  )
    return reply({ kind: "didnt_finish" });
  const exchanged = await Effect.runPromise(
    Effect.result(
      exchangeCode(config, {
        origin: url.origin,
        code: url.searchParams.get("code")!,
        verifier: flow.verifier,
        now: Date.now(),
      }),
    ),
  );
  if (Result.isFailure(exchanged))
    return reply({
      kind:
        exchanged.failure._tag === "ClientRefused"
          ? "client_refused"
          : exchanged.failure._tag === "GoogleUnavailable"
            ? "google_down"
            : exchanged.failure._tag === "NoRefreshToken"
              ? "no_refresh_token"
              : "didnt_finish",
    });
  const id = flow.purpose === "add" ? newAccountId() : flow.account;
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const grant = exchanged.success;
        const tokens = yield* Effect.tryPromise({
          try: async () => ({
            refreshToken: await seal(config.tokenKey, `${id}:refresh`, grant.refreshToken),
            accessToken: await seal(config.tokenKey, `${id}:access`, grant.accessToken),
          }),
          catch: () => new Unavailable(),
        });
        const sealed = { ...grant, ...tokens, id };
        if (flow.purpose === "add") return yield* addAccount(c.env.DB, owner, sealed, Date.now());
        return yield* reconnectAccount(c.env.DB, owner, { id, version: flow.version }, sealed);
      }),
    ),
  );
  if (Result.isFailure(result)) return reply({ kind: "unconfirmed" });
  const outcome = result.success;
  switch (outcome._tag) {
    case "OwnerChanged":
      return reply({ kind: "didnt_finish" });
    case "Connected":
      return reply({ kind: "connected", address: outcome.address });
    case "Reconnected":
      return reply({ kind: "reconnected", address: outcome.address });
    case "AlreadyConnected":
      return reply({ kind: "already_connected", address: outcome.address });
    case "AddressTaken":
      return reply({ kind: "address_taken", address: outcome.address, name: outcome.name });
    case "WrongAccount":
      return reply({ kind: "wrong_account", signedIn: outcome.signedIn, target: outcome.target });
    case "Changed":
      return reply({ kind: "changed", address: outcome.address });
  }
});
accountRoutes.post("/accounts/:id/name", ownerOnly, readForm, async (c) => {
  const id = parseAccountId(c.req.param("id"));
  if (!id) return c.json({ outcome: "not_found" }, 404);
  const name = parseName(c.get("form").get("name"));
  if (!name) return c.json({ outcome: "invalid" }, 400);
  const result = await Effect.runPromise(
    Effect.result(renameAccount(c.env.DB, c.get("owner"), id, name)),
  );
  return Result.isFailure(result)
    ? c.json({ outcome: "unknown" }, 503)
    : c.json(
        { outcome: result.success._tag === "NotFound" ? "not_found" : "ok" },
        result.success._tag === "NotFound" ? 404 : 200,
      );
});
accountRoutes.post("/accounts/:id/remove", ownerOnly, readForm, async (c) => {
  const id = parseAccountId(c.req.param("id"));
  if (!id) return c.json({ outcome: "not_found" }, 404);
  const owner = c.get("owner");
  const target = await Effect.runPromise(Effect.result(removalTarget(c.env.DB, owner, id)));
  if (Result.isFailure(target)) return c.json({ outcome: "unavailable" }, 503);
  if (!target.success) return c.json({ outcome: "not_found" }, 404);
  const disconnect = c.get("form").get("disconnect") === "1";
  let confirmed = !disconnect;
  if (disconnect && target.success.refreshToken) {
    const token = await open(
      c.get("config").tokenKey,
      `${id}:refresh`,
      target.success.refreshToken,
    );
    if (token.ok) confirmed = await Effect.runPromise(revoke(token.value));
  }
  const result = await Effect.runPromise(
    Effect.result(removeAccount(c.env.DB, owner, id, Date.now())),
  );
  if (Result.isFailure(result)) return c.json({ outcome: "unknown" }, 503);
  if (result.success._tag === "NotFound") return c.json({ outcome: "not_found" }, 404);
  const headers = new Headers();
  setAlert(headers, {
    kind: confirmed ? "removed" : "removed_unconfirmed",
    address: result.success.address,
  });
  return Response.json({ outcome: "ok" }, { headers });
});
