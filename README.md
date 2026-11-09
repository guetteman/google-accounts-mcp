# google-accounts-mcp

An MCP server that lets your AI agents use several Google accounts at once: personal gmail.com accounts and Google Workspace accounts from any organization. You decide what each agent connection can do in each account, and every action is recorded in an audit log you can read.

You deploy it to your own Cloudflare account, with your own Google Cloud OAuth client. Gmail comes first; other Google services follow.

**Status:** owner sign-in through Cloudflare Access and MCP connections for Claude, Claude Code, and ChatGPT are implemented. Connections start with no Google account access. Google accounts, permissions, audit logging, and tools are still planned in the [issues](../../issues).
