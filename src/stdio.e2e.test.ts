/**
 * Stdio end-to-end tests.
 *
 * Spawns the REAL built server (`node dist/index.js`) exactly as an MCP client
 * would, against a local Node http fixture standing in for the Rivalize API
 * (no real scraping, report generation or other metered work).
 *
 * Also covers the symlink case: the npm `.bin`/npx path invokes the bin
 * THROUGH A SYMLINK, and a naive entrypoint guard
 * (`import.meta.url === file://${process.argv[1]}`) fails under symlinks,
 * making the server a silent no-op. The realpath-based guard is locked in by
 * the symlink specs at the end of this file.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ENTRY = path.join(PKG_DIR, 'dist', 'index.js');
const API_KEY = 'rk_live_e2e_fixture_key_do_not_leak';
// Resolve the TypeScript compiler through module resolution, not a hardcoded
// `node_modules/.bin/tsc`: in the workspace it is hoisted to the root, and on
// Windows `.bin` holds shims that execFileSync cannot run directly.
const TSC_JS = createRequire(import.meta.url).resolve('typescript/bin/tsc');

const COMPANY = {
  domain: 'notion.so',
  name: 'Notion',
  lastEnrichedAt: '2026-07-01T00:00:00Z',
  pricing: { plans: [{ name: 'Plus', price: '$10' }] },
  momentum: { momentum: 80, signalCount: 2 },
};

let fixture: http.Server;
let fixtureUrl: string;
let tmp: string;

beforeAll(async () => {
  // Build dist once (tsc, ~2s) so we exercise the exact artifact npm would ship.
  execFileSync(process.execPath, [TSC_JS], { cwd: PKG_DIR });
  expect(existsSync(DIST_ENTRY)).toBe(true);

  tmp = mkdtempSync(path.join(tmpdir(), 'rivalize-mcp-e2e-'));

  fixture = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith('/api/v1/universe/companies/')) return send(200, { data: COMPANY });
    if (url.startsWith('/api/v1/universe/companies'))
      return send(200, {
        data: [COMPANY],
        pagination: { total: 1, limit: 50, offset: 0 },
        filters: {},
      });
    return send(404, { error: { code: 'NOT_FOUND', message: 'no fixture route' } });
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const addr = fixture.address();
  if (typeof addr === 'object' && addr) fixtureUrl = `http://127.0.0.1:${addr.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise((r) => fixture?.close(r));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Link `link` → DIST_ENTRY. Only a leftover link from a prior run is tolerated;
 * any other failure throws, so the symlink specs never run against a path that
 * is not there. */
function linkToDist(link: string): void {
  try {
    symlinkSync(DIST_ENTRY, link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

function spawnServer(entry: string, env: Record<string, string | undefined>): ChildProcess {
  return spawn(process.execPath, [entry], {
    env: { ...process.env, RIVALIZE_API_KEY: undefined, RIVALIZE_API_URL: undefined, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function collect(stream: NodeJS.ReadableStream | null): { text: () => string } {
  let buf = '';
  stream?.on('data', (d: Buffer) => {
    buf += d.toString();
  });
  return { text: () => buf };
}

function waitExit(child: ChildProcess, ms = 5000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process did not exit within ${ms}ms`));
    }, ms);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

describe('stdio E2E (real process, fixture API)', () => {
  it('missing RIVALIZE_API_KEY → exit 1 + actionable stderr, no network', async () => {
    const child = spawnServer(DIST_ENTRY, {});
    const stderr = collect(child.stderr);
    child.stdin?.end();
    const code = await waitExit(child);
    expect(code).toBe(1);
    expect(stderr.text()).toContain('RIVALIZE_API_KEY is required');
    expect(stderr.text()).toContain('rivalize.ai');
  });

  it('the missing-key message is the FIRST stderr line and names this server', async () => {
    // A client that shows only "Connection closed" may still log stderr; the
    // first line is the one most likely to be shown, so it carries the cause.
    const child = spawnServer(DIST_ENTRY, {});
    const stderr = collect(child.stderr);
    child.stdin?.end();
    expect(await waitExit(child)).toBe(1);
    const first = stderr.text().split(/\r?\n/)[0];
    expect(first).toMatch(/^rivalize-mcp: RIVALIZE_API_KEY is required\. /);
    expect(first).toContain('Settings → API Keys');
  });

  it('wrong key prefix → exit 1 naming the expected rk_live_ prefix', async () => {
    const child = spawnServer(DIST_ENTRY, { RIVALIZE_API_KEY: 'sk_test_wrong' });
    const stderr = collect(child.stderr);
    child.stdin?.end();
    const code = await waitExit(child);
    expect(code).toBe(1);
    expect(stderr.text()).toContain('rk_live_');
  });

  it('over real stdio: initialize + 13 read tools + a live tool call against the fixture API', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: { RIVALIZE_API_KEY: API_KEY, RIVALIZE_API_URL: fixtureUrl },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('rivalize-mcp-server');
      const { tools } = await client.listTools();
      expect(tools.length).toBe(13);
      expect(tools.some((t) => t.name === 'add_competitor')).toBe(false);
      // The freshness and evidence reads, over the wire.
      expect(tools.some((t) => t.name === 'get_freshness')).toBe(true);
      expect(tools.some((t) => t.name === 'get_evidence')).toBe(true);

      const res = await client.callTool({
        name: 'teardown_competitor',
        arguments: { domain: 'notion.so' },
      });
      expect(res.isError).toBeFalsy();
      const md = (res.content as Array<{ text: string }>)[0].text;
      expect(md).toContain('# Competitor Teardown — Notion');
      expect(md).toContain('Last refreshed'); // dated, over the wire
      // The key never leaks into results.
      expect(md).not.toContain(API_KEY);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('over real stdio: RIVALIZE_MCP_ALLOW_WRITES=1 adds add_competitor (14 tools)', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: {
        RIVALIZE_API_KEY: API_KEY,
        RIVALIZE_API_URL: fixtureUrl,
        RIVALIZE_MCP_ALLOW_WRITES: '1',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e-writes', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(14);
      expect(tools.some((t) => t.name === 'add_competitor')).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('malformed stdin bytes do not kill the server; a valid request still succeeds', async () => {
    const child = spawnServer(DIST_ENTRY, {
      RIVALIZE_API_KEY: API_KEY,
      RIVALIZE_API_URL: fixtureUrl,
    });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);

    // Garbage first…
    child.stdin?.write('this is not JSON-RPC\n');
    child.stdin?.write('{"jsonrpc":"2.0","broken\n');
    // …then a proper initialize request, raw JSON-RPC.
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'raw-client', version: '0' },
        },
      })}\n`,
    );

    // Wait for the id:1 response line.
    const ok = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (stdout.text().includes('"rivalize-mcp-server"')) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - started > 8000) {
          clearInterval(poll);
          resolve(false);
        }
      }, 50);
    });
    expect(ok, `server must answer initialize after garbage input. stderr: ${stderr.text()}`).toBe(
      true,
    );
    // stderr is lifecycle-only, never the key.
    expect(stderr.text()).not.toContain(API_KEY);
    child.kill();
    await waitExit(child).catch(() => {});
  }, 15_000);

  it('stdin EOF → prompt clean exit (no hang)', async () => {
    const child = spawnServer(DIST_ENTRY, {
      RIVALIZE_API_KEY: API_KEY,
      RIVALIZE_API_URL: fixtureUrl,
    });
    const stderr = collect(child.stderr);
    // Give it a beat to boot, then close stdin — the transport's shutdown signal.
    await new Promise((r) => setTimeout(r, 500));
    child.stdin?.end();
    const code = await waitExit(child, 3000);
    expect(code).toBe(0);
    expect(stderr.text()).toContain('connected via stdio');
    // The startup line says which mode the server is in.
    expect(stderr.text()).toContain('(read-only)');
  });

  // ── Symlinked bin ────────────────────────────────────────────────────────
  // npm installs bin entries as SYMLINKS in node_modules/.bin; npx runs that
  // symlink. Node resolves import.meta.url to the REALPATH but keeps argv[1]
  // as the symlink, so a naive entrypoint guard never calls main() and
  // `npx -y @rivalize/mcp` becomes a silent no-op (exit 0, no output). The
  // realpath-based guard handles it; these two specs lock that in.
  it('server starts when the bin is invoked via a symlink, as npx does', async () => {
    const link = path.join(tmp, 'rivalize-mcp');
    linkToDist(link);
    const child = spawnServer(link, {
      RIVALIZE_API_KEY: API_KEY,
      RIVALIZE_API_URL: fixtureUrl,
    });
    const stderr = collect(child.stderr);
    await new Promise((r) => setTimeout(r, 800));
    child.stdin?.end();
    await waitExit(child).catch(() => {});
    // Desired behavior: identical to direct invocation.
    expect(stderr.text()).toContain('connected via stdio');
  });

  it('missing-key error also surfaces via symlink invocation', async () => {
    const link = path.join(tmp, 'rivalize-mcp-nokey');
    linkToDist(link);
    const child = spawnServer(link, {});
    const stderr = collect(child.stderr);
    child.stdin?.end();
    const code = await waitExit(child);
    // Desired behavior: exit 1 + the actionable message (not a silent exit 0).
    expect(code).toBe(1);
    expect(stderr.text()).toContain('RIVALIZE_API_KEY is required');
  });
});
