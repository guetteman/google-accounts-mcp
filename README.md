# google-accounts-mcp

An MCP (Model Context Protocol) server that lets your AI agents use several Google accounts at once, both gmail.com accounts and Google Workspace accounts from any organization. The official Google connectors allow one account per client. With this server, one connection from Claude, Claude Code, or ChatGPT can reach every account you allow.

You run it as a Cloudflare Worker on your own Cloudflare account, on the Workers Paid plan, with your own Google Cloud OAuth client. Agent clients connect to `https://<your host>/mcp`. It supports Gmail today, and other Google services are planned in the [issues](../../issues).

## What you control

You sign in to the server's pages through Cloudflare Access.

- **Accounts** (`/accounts`). You connect each Google account here.
- **Connections** (`/connections`). Each time an agent client signs in to the server, it becomes a new connection. For each account, you set each of its tools to Not allowed, Ask first, or Allowed. A new connection starts with every tool set to Not allowed, and it sees only the tools you set to Ask first or Allowed.
- **Approvals** (`/approvals/:id`). With Ask first, the agent gets a link to an approval page instead of a result. The tool runs only after you approve it there, and the agent then collects the result with `get_approval`. An approval expires after one hour.
- **Activity** (`/activity`). The server records every tool call, with the connection that made it, the account, the outcome, and the reason for each refusal or failure.

The Gmail tools list labels, search and read threads, change labels, write drafts, send, reply, forward, move messages to the trash and back, delete them permanently, download attachments, and attach files. Each tool's description tells the agent its inputs and limits. You cannot undo a send or a permanent deletion, so the Connections page asks you to confirm before it sets such a tool to Allowed.

## Deploy

You need these before the first deploy:

- **A Google Cloud OAuth client.** Use a project with the Gmail API enabled and a web application client. Register `https://<host>/google/callback` as a redirect URI, once for each hostname you use. The server asks for the scopes `gmail.readonly`, `gmail.compose`, `gmail.send`, `gmail.modify`, and `https://mail.google.com/`. The admin of a Workspace organization can block your client for that organization's accounts.
- **Two Cloudflare Access self-hosted applications** on the Worker's hostname, both with managed OAuth turned off:
  1. One for the whole hostname, with an Allow policy for your email address only. Its Application Audience (AUD) tag is `ACCESS_AUDIENCE`.
  2. One for `/mcp`, `/oauth/*`, `/.well-known/*`, and `/uploads/*`, with a Bypass policy for everyone. Agent clients and file uploads call these paths without a browser, and the server checks its own connection and upload credentials there. Without `/uploads/*` here, an upload gets the Access sign-in page.

  Put the `workers.dev` address behind Access too, or turn it off.

Then:

1. Set the six secrets with `wrangler secret put`. `wrangler deploy` refuses to deploy while one is missing.

   | Secret                 | Value                                                                                       |
   | ---------------------- | ------------------------------------------------------------------------------------------- |
   | `OWNER_EMAIL`          | Your email address. The first request with a valid Access token for it makes you the owner. |
   | `ACCESS_ISSUER`        | Your Access team domain, exactly `https://<team>.cloudflareaccess.com`.                     |
   | `ACCESS_AUDIENCE`      | The AUD tag of the first Access application.                                                |
   | `GOOGLE_CLIENT_ID`     | The OAuth client ID.                                                                        |
   | `GOOGLE_CLIENT_SECRET` | The OAuth client secret.                                                                    |
   | `TOKEN_KEY`            | 64 hexadecimal characters, for example from `openssl rand -hex 32`.                         |

2. Apply the pending migrations to the deploy's D1 database, with the same configuration and environment as the Worker:

   ```sh
   pnpm exec wrangler d1 migrations apply DB --remote
   ```

   Apply them before you deploy the code, unless a migration's first comment says to deploy first, as `0010_owner_without_instance.sql` does.

3. Deploy. The deploy creates the D1 database, the KV namespaces, and a cron trigger that removes expired approvals, uploads, and repeat records every ten minutes.

To change the owner, deploy the new `OWNER_EMAIL` to all traffic at once, never as a gradual deployment, because an older version would still accept the old owner. The server refuses every request until you run `pnpm owner:reset`, which asks for confirmation before it clears the stored owner. The new owner then signs in.

## Before you use it

An agent that controls a browser where you are signed in can approve its own calls or change its own settings. The server cannot tell those browser actions from yours.

The server encrypts Google tokens, and the arguments and results it keeps for approvals, in D1. It encrypts downloaded and uploaded files in KV, and KV deletes them within about 75 minutes. The name of an uploaded file is part of its upload address, so it appears in the Worker's request log.

## Development

See [AGENTS.md](AGENTS.md) for how to install, run, and test the project.
