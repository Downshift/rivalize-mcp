#!/usr/bin/env node
/**
 * Rivalize MCP server.
 *
 * Exposes the Rivalize competitive-intelligence data layer as MCP tools over a
 * stdio transport (Claude Desktop / local MCP clients). Authenticates to the
 * existing v1 REST API with the `rk_live_*` key from RIVALIZE_API_KEY.
 *
 * Tools: READ_TOOL_NAMES in tools.ts, always; add_competitor only when
 * RIVALIZE_MCP_ALLOW_WRITES=1 (read-only by default).
 *
 * Run:  RIVALIZE_API_KEY=rk_live_... node dist/index.js
 *       (optional RIVALIZE_API_URL to point at a self-hosted or local server,
 *        optional RIVALIZE_MCP_ALLOW_WRITES=1 to enable add_competitor)
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RivalizeClient } from './client.js';
import { resolveConfig } from './config.js';
import { createProxyAwareFetch } from './proxy.js';
import { type RegisterToolsOptions, registerTools } from './tools.js';
import { VERSION } from './version.js';

export function buildServer(client: RivalizeClient, opts: RegisterToolsOptions = {}): McpServer {
  const server = new McpServer({
    name: 'rivalize-mcp-server',
    version: VERSION,
  });
  registerTools(server, client, opts);
  return server;
}

async function main(): Promise<void> {
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig();
  } catch (err) {
    // A client that cannot start the server may show only
    // "Connection closed", while logging stderr. This is the first and only
    // line printed, and it names the server, so the cause is what a log shows.
    console.error(`rivalize-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  // Node's global fetch ignores HTTPS_PROXY; route through it when set.
  const client = new RivalizeClient(config, createProxyAwareFetch(process.env));
  const server = buildServer(client, { allowWrites: config.allowWrites, origin: config.apiUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to log to under stdio transport (stdout is the protocol channel).
  console.error(
    `rivalize-mcp-server connected via stdio → ${config.apiUrl} (${
      config.allowWrites ? 'writes enabled' : 'read-only'
    })`,
  );
}

/**
 * Only auto-run when invoked as the entrypoint, not when imported by tests.
 *
 * npm installs `bin` entries as SYMLINKS in `node_modules/.bin/`, and npx
 * executes that symlink. Node resolves the ESM main module to its REALPATH for
 * `import.meta.url`, but `process.argv[1]` keeps the symlink path as given, so
 * a raw string comparison fails, `main()` never runs, and `npx @rivalize/mcp`
 * is a silent no-op (exit 0, no output, config errors swallowed). Resolve
 * symlinks on BOTH sides before comparing. `fileURLToPath` also fixes paths
 * that URL-encode (spaces → `%20`), which the raw template string mismatched.
 */
function isMainEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // argv[1] not a resolvable file (e.g. a test runner's virtual entry) —
    // we were imported, not executed.
    return false;
  }
}

if (isMainEntrypoint()) {
  main().catch((err) => {
    console.error('rivalize-mcp: fatal error:', err);
    process.exit(1);
  });
}
