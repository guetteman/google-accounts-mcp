# google-accounts-mcp

An MCP server that lets your AI agents use several Google accounts at once: personal gmail.com accounts and Google Workspace accounts from any organization. You decide what each agent connection can do in each account, and every action is recorded in an audit log you can read.

You deploy it to your own Cloudflare account, with your own Google Cloud OAuth client. Gmail comes first; other Google services follow.

**Status:** owner sign-in through Cloudflare Access and MCP connections for Claude, Claude Code, and ChatGPT are implemented. The owner can connect, reconnect, rename, and remove Google accounts. Tokens are encrypted in D1, and the token function that tools will use in [#11](../../issues/11) refreshes them when a request needs them. Connections start with no Google account access. Permissions, audit logging, and tools are still planned in the [issues](../../issues).

Browser tests use Chromium. After `vp install`, run `pnpm exec playwright-core install chromium` once before `vp test run`. CI installs Chromium and its system dependencies.
