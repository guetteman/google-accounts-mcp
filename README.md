# google-accounts-mcp

An MCP server that lets your AI agents use several Google accounts at once: personal gmail.com accounts and Google Workspace accounts from any organization. You decide what each agent connection can do in each account, and every tool call is recorded.

You deploy it to your own Cloudflare account, with your own Google Cloud OAuth client. Gmail comes first; other Google services follow.

**Status:** owner sign-in through Cloudflare Access and MCP connections for Claude, Claude Code, and ChatGPT are implemented. The owner can manage Google accounts and choose which accounts each connection may use from its Tool permissions page. Connections start with no access. `list_accounts` returns only allowed accounts, and `list_labels` reads one allowed account's Gmail labels. Tokens are encrypted in D1. Every tool call is recorded before Google is contacted; a missing outcome means the result is unknown. A page for viewing these records, approval requests, and more Gmail tools are still planned in the [issues](../../issues).

Before deploying this version, apply `migrations/0004_permissions_and_calls.sql` to the deploy's D1 database with `pnpm exec wrangler d1 migrations apply DB --remote`. Use the same configuration and environment as the Worker. Deploy the code only after the migration succeeds. Without the new tables, tool calls and connection pages fail closed. Existing connections keep no account access until the owner allows it.

Browser tests use Chromium. After `vp install`, run `pnpm exec playwright-core install chromium` once before `vp test run`. CI installs Chromium and its system dependencies.
