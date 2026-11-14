# google-accounts-mcp

An MCP server that lets your AI agents use several Google accounts at once: personal gmail.com accounts and Google Workspace accounts from any organization. You decide what each agent connection can do in each account, and every tool call is recorded.

You deploy it to your own Cloudflare account on the Workers Paid plan, with your own Google Cloud OAuth client. Gmail comes first; other Google services follow. Planned work is in the [issues](../../issues).

## What you control

You sign in through Cloudflare Access. On the Accounts page you connect your Google accounts. On the Connections page you see each agent client that connected (Claude, Claude Code, or ChatGPT) and set each of its tools, per account, to Not allowed, Ask first, or Allowed. A new connection starts with every tool set to Not allowed, and it sees only the tools you set to Ask first or Allowed.

With Ask first, the agent gets a link to an approval page. The tool runs only after you approve it there, and the agent then collects the result with `get_approval`. An approval expires after one hour.

The Activity page at `/activity` shows every tool call: which connection made it, in which account, its outcome, and the reason for each refusal or failure.

The Gmail tools list labels, search and read threads, change labels, write drafts, send, reply, forward, move messages to the trash and back, delete them permanently, download attachments, and attach files. Each tool's description tells the agent its inputs and limits. You cannot undo a send or a permanent deletion, so the Connections page asks you to confirm before it sets such a tool to Allowed.

## Deploy

1. Configure two Cloudflare Access self-hosted applications for the Worker's hostname:
   - one for the whole hostname, with an Allow policy for your email address only. Its Application Audience (AUD) Tag is the `ACCESS_AUDIENCE` setting;
   - one for the paths `/mcp`, `/oauth/*`, `/.well-known/*`, and `/uploads/*`, with a Bypass policy for everyone. These paths check the server's own connection and upload credentials instead of an Access session. Without the Bypass for `/uploads/*`, a file upload gets the Access sign-in page.
2. Set the six secrets that `wrangler.jsonc` lists with `wrangler secret put`.
3. Apply every pending migration to the deploy's D1 database before you deploy the code: `pnpm exec wrangler d1 migrations apply DB --remote`, with the same configuration and environment as the Worker.
4. Deploy. The deploy also creates a cron trigger that runs every ten minutes to remove expired approvals, uploads, and repeat records, and a second KV namespace for downloaded and uploaded files.

## Know before you use it

An agent that controls a browser where you are signed in can approve its own calls or change its own settings. The server cannot tell those browser actions from yours.

The server encrypts tokens, and the arguments and results it keeps for approvals, in D1. It encrypts files in KV, and KV deletes them within about 75 minutes. The name of an uploaded file is part of its upload address, so it appears in the Worker's request log.

## Development

See [AGENTS.md](AGENTS.md) for how to install, run, and test the project.
