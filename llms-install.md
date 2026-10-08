# Installing Rivalize MCP (instructions for AI agents)

Rivalize MCP gives you read access to the user's Rivalize competitive-intelligence account. It is a local stdio server published on npm as `@rivalize/mcp`. It is read-only by default.

## Requirements
- Node.js 22 or newer. Check with `node --version`. If it is older, tell the user to upgrade; do not continue.
- A Rivalize API key. It starts with `rk_live_`. A key from any plan works, including the free plan.

## Rules
- Do not clone, build or `npm link` this repository. The published npm package is all you need.
- Install it into your own MCP settings (`cline_mcp_settings.json`, opened from the MCP Servers panel, Configure tab). Do not use `claude mcp add` or any other client's config.
- Never put a placeholder such as `%RIVALIZE_API_KEY%` in the config. Use the real key the user gives you.

## Steps
1. Ask the user for their Rivalize API key. If they don't have one, tell them to create a free account at https://rivalize.ai and make a key under Dashboard, Settings, API Keys. Never invent or reuse a key, and never write the key anywhere except the MCP settings below.
2. Add this server to the MCP settings file (`cline_mcp_settings.json`), replacing `rk_live_...` with the user's key:

```json
{
  "mcpServers": {
    "rivalize": {
      "command": "npx",
      "args": ["-y", "@rivalize/mcp"],
      "env": { "RIVALIZE_API_KEY": "rk_live_..." }
    }
  }
}
```

3. On Windows, if the server fails to start because `npx` cannot be launched directly, use this instead:

```json
{
  "mcpServers": {
    "rivalize": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@rivalize/mcp"],
      "env": { "RIVALIZE_API_KEY": "rk_live_..." }
    }
  }
}
```

4. Do not set `RIVALIZE_MCP_ALLOW_WRITES`. Leaving it unset keeps the server read-only.
5. Do not set `RIVALIZE_API_URL` unless the user says their key was issued by a different Rivalize environment (for example staging). By default the server talks to https://rivalize.ai.

## Check that it works
The first start downloads the package and can take about 10 to 15 seconds. Then call the `list_projects` tool. It returns the projects in the user's account. A reply with a `data` list means the install worked. If it returns an authentication error, the key is wrong or revoked: ask the user to check it.

## What you can do with it
13 read-only tools: `list_projects`, `list_competitors`, `list_reports`, `get_report`, `get_competitor_intelligence`, `get_battlecard`, `get_strategic_timeline`, `get_competitive_landscape`, `get_freshness`, `get_evidence`, `list_universe_companies`, `get_universe_company` and `teardown_competitor`. Every answer carries a date and a source. On a free key some tools (battlecards, 90 or 180 day timeline, landscape history) return a plan-upgrade message: that is expected, not an install problem.

Source and full README: https://github.com/Downshift/rivalize-mcp
