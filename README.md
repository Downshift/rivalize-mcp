# Rivalize MCP Server

[![npm](https://img.shields.io/npm/v/@rivalize/mcp)](https://www.npmjs.com/package/@rivalize/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Sourced, dated competitive intelligence for your AI assistant, over the Model
Context Protocol.

## What it does

This server connects Claude, Cursor or any other MCP client to
[Rivalize](https://rivalize.ai). Your assistant can tear down a competitor's
positioning, pricing, ads, social presence, reviews, hiring and momentum in one
call, search the Rivalize universe of tracked companies, and read the projects,
reports, battlecards, timelines and evidence in your own Rivalize account.
Every answer comes from data Rivalize has collected, with dates and sources,
rather than from a model's memory.

The server is read-only by default. One write tool, `add_competitor`, is
available when you opt in with `RIVALIZE_MCP_ALLOW_WRITES=1`.

## Quick start

Requires **Node.js 22 or newer** (`node --version`).

1. Create an account at [rivalize.ai](https://rivalize.ai).
2. Create an API key under **Dashboard → Settings → API Keys**. Keys start with
   `rk_live_`. A key from any plan works, including the free plan, which gets
   rate-limited reads.
3. Add the server to your client using one of the blocks below.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart Claude
Desktop:

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

### Claude Code

```bash
claude mcp add rivalize -e RIVALIZE_API_KEY=rk_live_... -- npx -y @rivalize/mcp
```

### Cursor

Add to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for all
projects:

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

### Any MCP client (stdio)

The server speaks MCP over stdin and stdout. Configure your client to launch:

| Setting | Value |
|---------|-------|
| Command | `npx` |
| Arguments | `-y @rivalize/mcp` |
| Environment | `RIVALIZE_API_KEY=rk_live_...` |
| Transport | stdio |

On Windows, some clients cannot launch `npx` directly because it is `npx.cmd`.
Use `cmd` as the command and `/c npx -y @rivalize/mcp` as the arguments
instead.

## Tools

Thirteen read-only tools are always available. `add_competitor` is registered
only when `RIVALIZE_MCP_ALLOW_WRITES` is set to `1`, `true` or `yes`; without
it, the tool does not exist for the client.

| Tool | Access | What it does | Key arguments |
|------|--------|--------------|---------------|
| `teardown_competitor` | read | One-call strategy teardown of a competitor as Markdown: positioning, pricing, ads, social, reviews, hiring, momentum and weaknesses to attack, with when the data was last refreshed | `domain` (required) |
| `list_universe_companies` | read | Search the Rivalize universe, the cross-customer dataset of tracked companies | `q`, `category` (slug), `layer`, `limit` (1-100), `offset` |
| `get_universe_company` | read | Full universe profile for one company: identity, pricing, features, ads, social, reviews, funding and hiring, rankings, signals, momentum | `domain` (required), `layers` |
| `list_projects` | read | The projects in your account; returns the `project_id` other tools take | none |
| `list_reports` | read | Your reports, newest first. Reading never generates a report | `project_id`, `limit` (1-100), `offset` |
| `get_report` | read | One report as Markdown, whole or one section or one competitor at a time | `report_id` (required), `section`, `competitor`, `page` |
| `list_competitors` | read | The competitors you track, with threat level and momentum score | `project_id`, `limit` (1-100), `offset` |
| `get_competitor_intelligence` | read | Latest stored intelligence for one tracked competitor; a field is present only when it was measured | `competitor_id` (required) |
| `get_battlecard` | read | Cited sales battlecard for one tracked competitor. Requires a Pro plan | `competitor_id` (required) |
| `get_strategic_timeline` | read | Evidence-linked timeline of competitor moves across pricing, product, people, funding and content/social | `project_id` (required), `days` (`30`, `90`, `180`), `competitor_id`, `lanes`, `format`, `page` |
| `get_competitive_landscape` | read | Current or stored weekly positions of competitors by activity and strategic importance | `project_id` (required), `week` (`YYYY-MM-DD`), `format`, `page` |
| `get_freshness` | read | When each tracked competitor in a project was last actually observed, and how | `project_id` (required) |
| `get_evidence` | read | The sources behind the facts for your product or one competitor: URL, what it supports, and when it was read | `project_id` (required), `competitor_id` |
| `add_competitor` | **write**, opt-in | Add competitor URLs to a project. Spends credits and queues analysis | `project_id` (required), `urls` (1-10, required) |

`project_id` and `competitor_id` are UUIDs from `list_projects` and
`list_competitors`. Tools that read your account only ever see your own data.

### Report sections

`get_report` takes a `section` so your assistant can read the part a question
needs instead of the whole report:

| Section | Contains |
|---------|----------|
| `tldr`, `biggest-threat`, `blind-spots`, `actions` | The report's headline sections (`actions` is what your product should do) |
| `battlecards` | The cited sales battlecards |
| `competitors` | Every competitor's section in full |
| `pricing`, `momentum`, `app-store`, `strengths`, `weaknesses`, `key-findings`, `creators`, `ads`, `tech-stack` | One topic gathered from every competitor's section |

A report has only the sections it has data for; asking for any other name
returns an error that lists the sections it does have. `section` combines with
`competitor`, so `section: "pricing"` with `competitor: "Acme"` returns Acme's
pricing. Claims the report's fabrication check removed appear as
`[removed — unverified]`, exactly as in the report.

### Long responses

Every response stays under 25,000 characters, and nothing is cut silently:

- **Markdown** (`get_report`, `get_strategic_timeline`,
  `get_competitive_landscape`) is split into pages at section boundaries. Each
  page starts with `Page N of M`, how much remains, and the exact call for the
  next page.
- **Lists** (`list_universe_companies`, `list_competitors`, `list_reports`)
  return `pagination.next_offset`; continue from it until it is `null`.
- **Objects** (`get_universe_company`, and timeline or landscape JSON) cap long
  arrays and record the cap in `_capped`. A field that still does not fit is
  listed in `_omitted` with the call that fetches it.

## Example prompts

- "Tear down linear.app." (`teardown_competitor`)
- "Who are the players in AI developer tools?" (`list_universe_companies`)
- "Summarize my latest report, then show me what my competitors charge."
  (`list_reports`, `get_report` with `section: "pricing"`)
- "Which of my competitors moved most this quarter, and what did they do?"
  (`get_competitive_landscape`, `get_strategic_timeline`)
- "Give me sales talking points against my top competitor." (`list_competitors`,
  `get_battlecard`)
- "Where does that pricing claim come from, and how fresh is it?"
  (`get_evidence`, `get_freshness`)

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RIVALIZE_API_KEY` | yes | none | Your Rivalize API key. Must start with `rk_live_`; the server exits at startup with a message if it is missing or malformed. |
| `RIVALIZE_API_URL` | no | `https://rivalize.ai` | Origin of the Rivalize API. A key only works on the server that issued it: leave this unset for rivalize.ai, and for a staging or self-hosted Rivalize set it to that server's origin, or every call returns 401. |
| `RIVALIZE_MCP_ALLOW_WRITES` | no | off | `1`, `true` or `yes` (any case) registers `add_competitor`. Any other value, or unset, keeps the server read-only. |
| `HTTPS_PROXY` / `HTTP_PROXY` | no | none | Route requests through a corporate proxy. Lowercase forms are also read, and `HTTPS_PROXY` wins when both are set. `NO_PROXY` is honoured. Errors name the proxy host, never its credentials. |

## Troubleshooting

### "Connection closed"

When the server cannot start, many clients show only "Connection closed" or a
failed status. The server prints the reason as the first line of its stderr,
prefixed `rivalize-mcp:`, and most clients keep stderr in their MCP log. The
usual causes:

1. **`RIVALIZE_API_KEY` is missing or invalid.** The log reads
   `rivalize-mcp: RIVALIZE_API_KEY is required`, or says the key does not look
   like a Rivalize API key (it must start with `rk_live_`). Put the key in the
   server's `env` block and restart the client.
2. **Node.js is older than 22.** Run `node --version` and install Node.js 22 or
   newer. Your client uses whichever `node` and `npx` come first on its own
   `PATH`, which can differ from your terminal's.
3. **No network access.** `npx` downloads the package on first run, and every
   tool call goes to `https://rivalize.ai` (or `RIVALIZE_API_URL`). Behind a
   corporate proxy, set `HTTPS_PROXY`. A network error names the server and the
   cause code, such as `ECONNREFUSED` or `ENOTFOUND`.

To see the message directly, run the server in a terminal with the same key:

```bash
RIVALIZE_API_KEY=rk_live_... npx -y @rivalize/mcp
```

A healthy server prints `rivalize-mcp-server connected via stdio` to stderr
and waits for input (press Ctrl+C to stop). Anything else is the reason your
client could not connect.

### Every call returns 401

The key was rejected by the server it was sent to, and the error names that
server. Check that the key has not been revoked, and that `RIVALIZE_API_URL` is
unset unless the key was issued by a different Rivalize server.

### A tool says it needs a higher plan

Reads are available on every plan. Some capabilities, such as battlecards and
full timeline or landscape history, need a higher plan; the error says which
and links to [rivalize.ai/pricing](https://rivalize.ai/pricing).

## Docker

The repository includes a `Dockerfile` that builds the same stdio server on
Node 22 and runs it as a non-root user.

```bash
docker build -t rivalize-mcp .
```

```json
{
  "mcpServers": {
    "rivalize": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "RIVALIZE_API_KEY", "rivalize-mcp"],
      "env": { "RIVALIZE_API_KEY": "rk_live_..." }
    }
  }
}
```

Run the container with `-i` and without a TTY, since MCP uses stdin and
stdout. `-e RIVALIZE_API_KEY` with no value passes the key through from the
client's environment, so it never appears on the `docker run` command line.
Add `-e RIVALIZE_API_URL` or `-e RIVALIZE_MCP_ALLOW_WRITES` the same way if you
need them.

## Privacy Policy

This server is a thin client for the Rivalize API.

- **What it sends, and where.** Each tool call becomes an HTTPS request to the
  Rivalize API at `https://rivalize.ai`, or the origin you set in
  `RIVALIZE_API_URL`. A request carries your API key as a Bearer token, a
  `User-Agent` of `rivalize-mcp/<version>`, and the tool's arguments: for
  example a company domain, a search term, a project, report or competitor id,
  and, with writes enabled, the competitor URLs you add. If you set
  `HTTPS_PROXY` or `HTTP_PROXY`, requests go through that proxy. Nothing is
  sent anywhere else.
- **What it does not send.** No telemetry, analytics or crash reports. It does
  not read files on your machine, your conversation, or other tools' output;
  it sees only the arguments your MCP client passes to its own tools.
- **What it stores locally.** Nothing. It writes no files, keeps no cache and
  holds no state between runs. Your key lives in your MCP client's
  configuration, not in this server. Diagnostic messages go to stderr, which
  your MCP client may log; they never include your API key.
- **What Rivalize does with requests.** The API processes them under the
  Rivalize Privacy Policy at [rivalize.ai/privacy](https://rivalize.ai/privacy).
  Rivalize is operated by Downshift LLC, the data controller for that data.
  Privacy questions go to privacy@rivalize.ai.

## Security

Please report vulnerabilities privately to **support@rivalize.ai** with
"security" in the subject line, not in a public issue. Include the package
version (`npm view @rivalize/mcp version`, or the `User-Agent` above), what you
did, and what happened. We will acknowledge your report and keep you updated
until it is resolved.

Treat your API key as a credential. Keep it in your client's `env` block or
your shell environment, never in a shared or committed file, and revoke a
leaked key under **Dashboard → Settings → API Keys**.

## Contributing

Bug reports and feature requests are welcome at
[github.com/Downshift/rivalize-mcp/issues](https://github.com/Downshift/rivalize-mcp/issues).
For account and billing questions, email support@rivalize.ai.

To work on the server locally:

```bash
npm ci
npm run typecheck
npm run build      # emits dist/, which the rivalize-mcp bin runs
npm test           # offline: every API call is mocked or served by a local fixture
```

`server.json` is the [MCP Registry](https://registry.modelcontextprotocol.io)
entry. The tests validate it against the official schema (vendored in
`schema/`) and check that its name, version and package match `package.json`.

## License

MIT, © 2026 Downshift LLC. See [LICENSE](./LICENSE).
