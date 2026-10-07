/**
 * MCP protocol-conformance tests. Unlike tools.test.ts (which drives handlers
 * through a fake server), these run the REAL McpServer from buildServer() against a REAL MCP
 * Client over an in-memory transport pair — full handshake, tools/list,
 * tools/call, schema validation, error envelopes.
 *
 * The HTTP layer is a mocked fetch: tests never trigger real report
 * generation, scraping or any metered call.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RivalizeClient } from './client.js';
import { buildServer } from './index.js';
import { READ_TOOL_NAMES, type RegisterToolsOptions, TOOL_NAMES } from './tools.js';

const API_KEY = 'rk_live_protocol_test_secret';
const CONFIG = { apiKey: API_KEY, apiUrl: 'https://api.test.invalid' };

const COMPANY = {
  domain: 'notion.so',
  name: 'Notion',
  lastEnrichedAt: '2026-07-01T00:00:00Z',
  pricing: { plans: [{ name: 'Plus', price: '$10' }] },
};

/** Route-aware mocked fetch: answers the v1 endpoints with canned JSON. */
function routedFetch(): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.includes('/v1/universe/companies/')) return json(200, { data: COMPANY });
    if (url.includes('/v1/universe/companies'))
      return json(200, {
        data: [COMPANY],
        pagination: { total: 1, limit: 50, offset: 0 },
        filters: {},
      });
    if (url.includes('/v1/competitors/'))
      return json(200, { data: { competitor_name: 'Notion', momentum_score: 42 } });
    if (url.includes('/v1/competitors'))
      return json(200, { data: [{ id: 'c-1', name: 'Notion' }] });
    if (url.includes('/competitors') && url.includes('/v1/projects/'))
      return json(202, { data: { competitors_added: 1, competitors_skipped: 0, job_id: 'j-1' } });
    if (url.endsWith('/v1/projects'))
      return json(200, { data: [{ id: 'p-1', name: 'My Product', competitor_count: 1 }] });
    if (url.includes('/v1/reports/') && url.includes('/intelligence'))
      return json(200, {
        data: {
          id: 'r-1',
          markdown: '# Rivalize Competitive Intelligence Report\n\n## TL;DR\nThey lead.',
        },
      });
    if (url.includes('/v1/reports'))
      return json(200, {
        data: [{ id: 'r-1', product_name: 'My Product', status: 'completed' }],
        pagination: { total: 1, limit: 20, offset: 0 },
      });
    return json(404, { error: { code: 'NOT_FOUND', message: 'no route' } });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

/** Spin up a connected real-server/real-client pair over in-memory transport. */
async function connect(fetchImpl: typeof fetch = routedFetch(), opts: RegisterToolsOptions = {}) {
  const server = buildServer(new RivalizeClient(CONFIG, fetchImpl), opts);
  const client = new Client({ name: 'protocol-suite', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, fetchImpl };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn().catch(() => {});
  cleanup = [];
});

async function setup(fetchImpl?: typeof fetch, opts: RegisterToolsOptions = {}) {
  const pair = await connect(fetchImpl, opts);
  cleanup.push(async () => {
    await pair.client.close();
    await pair.server.close();
  });
  return pair;
}

describe('protocol conformance (real McpServer + real Client)', () => {
  it('initialize handshake succeeds with the declared server identity', async () => {
    const { client } = await setup();
    const info = client.getServerVersion();
    expect(info?.name).toBe('rivalize-mcp-server');
    expect(info?.version).toBe('0.3.2');
  });

  it('tools/list returns exactly the 13 read tools by default, each with description + object input schema', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    expect(tools.some((t) => t.name === 'add_competitor')).toBe(false);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect((tool.description ?? '').length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe('object');
    }
    // Required args are declared where the tool cannot work without them.
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('get_universe_company')?.inputSchema.required).toContain('domain');
    expect(byName.get('teardown_competitor')?.inputSchema.required).toContain('domain');
    expect(byName.get('get_report')?.inputSchema.required).toContain('report_id');
    // The public contract's names and arguments, exactly.
    const props = (name: string) =>
      Object.keys(
        (byName.get(name)?.inputSchema as { properties?: Record<string, unknown> }).properties ??
          {},
      ).sort();
    expect(props('get_report')).toEqual(['competitor', 'page', 'report_id', 'section']);
    expect(byName.get('get_report')?.inputSchema.required).toEqual(['report_id']);
    expect(props('get_freshness')).toEqual(['project_id']);
    expect(byName.get('get_freshness')?.inputSchema.required).toEqual(['project_id']);
    expect(props('get_evidence')).toEqual(['competitor_id', 'project_id']);
    expect(byName.get('get_evidence')?.inputSchema.required).toEqual(['project_id']);
  });

  it('with writes enabled, tools/list adds add_competitor with its required args', async () => {
    const { client } = await setup(undefined, { allowWrites: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('add_competitor')?.inputSchema.required).toEqual(
      expect.arrayContaining(['project_id', 'urls']),
    );
  });

  it('read-only by default — calling add_competitor is refused and never reaches the API', async () => {
    const fetchImpl = routedFetch();
    const { client } = await setup(fetchImpl);
    const res = await client
      .callTool({
        name: 'add_competitor',
        arguments: { project_id: '11111111-1111-4111-8111-111111111111', urls: ['https://r.com'] },
      })
      .catch((e: Error) => e);
    const refused = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(refused).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('annotations are honest over the wire — reads readOnly, add_competitor a write', async () => {
    const { client } = await setup(undefined, { allowWrites: true });
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of TOOL_NAMES.filter((n) => n !== 'add_competitor')) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.get('add_competitor')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('add_competitor')?.annotations?.destructiveHint).toBe(false);
  });

  it('unknown tool name → protocol error; server survives and serves the next call', async () => {
    const { client } = await setup();
    // The SDK surfaces the JSON-RPC method error as an isError tool result.
    const res = await client
      .callTool({ name: 'does_not_exist', arguments: {} })
      .catch((e: Error) => e);
    if (res instanceof Error) {
      expect(res.message).toMatch(/does_not_exist|not found|unknown/i);
    } else {
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0].text).toMatch(
        /does_not_exist|not found|unknown/i,
      );
    }
    // Server must still answer after the bad call.
    const ok = await client.callTool({ name: 'list_competitors', arguments: {} });
    expect(ok.isError).toBeFalsy();
  });

  it('invalid list_universe_companies args are rejected pre-HTTP (limit bounds, enum, strict keys)', async () => {
    const fetchImpl = routedFetch();
    const { client } = await setup(fetchImpl);
    const bad = [
      { limit: 0 },
      { limit: 101 },
      { layer: 'not_a_layer' },
      { totally_unknown_key: true },
      { q: 'x'.repeat(201) },
    ];
    for (const args of bad) {
      const res = await client
        .callTool({ name: 'list_universe_companies', arguments: args })
        .catch((e: Error) => e);
      // Either a protocol-level validation error (throw) or an isError result —
      // both acceptable; a silent 200 pass-through is not.
      const rejected = res instanceof Error || (res as { isError?: boolean }).isError === true;
      expect(rejected, `args ${JSON.stringify(args)} must be rejected`).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a whitespace-only domain is rejected pre-HTTP by the real server', async () => {
    const fetchImpl = routedFetch();
    const { client } = await setup(fetchImpl);
    for (const name of ['get_universe_company', 'teardown_competitor']) {
      const res = await client
        .callTool({ name, arguments: { domain: '   ' } })
        .catch((e: Error) => e);
      const rejected = res instanceof Error || (res as { isError?: boolean }).isError === true;
      expect(rejected, name).toBe(true);
      // The SCHEMA answered (its message), not the handler's fallback guard.
      const message =
        res instanceof Error
          ? res.message
          : JSON.stringify((res as { content?: unknown }).content ?? '');
      expect(message, name).toContain('domain must not be blank');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('companion: the real server trims a padded domain before the request', async () => {
    const fetchImpl = routedFetch();
    const { client } = await setup(fetchImpl);
    await client.callTool({ name: 'get_universe_company', arguments: { domain: '  notion.so ' } });
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(
      'https://api.test.invalid/api/v1/universe/companies/notion.so',
    );
  });

  it('non-UUID competitor_id rejected pre-HTTP', async () => {
    const fetchImpl = routedFetch();
    const { client } = await setup(fetchImpl);
    const res = await client
      .callTool({ name: 'get_competitor_intelligence', arguments: { competitor_id: 'nope' } })
      .catch((e: Error) => e);
    expect(res instanceof Error || (res as { isError?: boolean }).isError === true).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('add_competitor arg limits enforced pre-HTTP (0 urls, 11 urls, bad uuid)', async () => {
    const fetchImpl = routedFetch();
    const { client } = await setup(fetchImpl, { allowWrites: true });
    // NB: must satisfy zod v4's strict UUID check (version + variant nibbles).
    const uuid = '11111111-1111-4111-8111-111111111111';
    const bad = [
      { project_id: uuid, urls: [] },
      { project_id: uuid, urls: Array.from({ length: 11 }, (_, i) => `https://r${i}.com`) },
      { project_id: 'not-a-uuid', urls: ['https://r.com'] },
      { project_id: uuid }, // missing urls entirely
    ];
    for (const args of bad) {
      const res = await client
        .callTool({ name: 'add_competitor', arguments: args })
        .catch((e: Error) => e);
      const rejected = res instanceof Error || (res as { isError?: boolean }).isError === true;
      expect(rejected, `args ${JSON.stringify(args)} must be rejected`).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('REST failures come back as isError result envelopes, never transport-level crashes', async () => {
    const failing = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }), {
        status: 500,
      });
    }) as unknown as typeof fetch;
    const { client } = await setup(failing);
    const res = await client.callTool({ name: 'list_competitors', arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('500');
    // And the connection is still healthy afterwards.
    const { tools } = await client.listTools();
    expect(tools.length).toBe(READ_TOOL_NAMES.length);
  });

  it('happy path per tool over the real protocol', async () => {
    const { client } = await setup();
    // Valid v4-shaped UUIDs — zod v4 enforces version + variant nibbles.
    const uuid = '11111111-1111-4111-8111-111111111111';
    const cuuid = '22222222-2222-4222-8222-222222222222';
    const calls: Array<[string, Record<string, unknown>, (text: string) => void]> = [
      ['list_universe_companies', { q: 'notion' }, (t) => expect(t).toContain('notion.so')],
      ['get_universe_company', { domain: 'notion.so' }, (t) => expect(t).toContain('Notion')],
      [
        'teardown_competitor',
        { domain: 'notion.so' },
        (t) => expect(t).toContain('# Competitor Teardown — Notion'),
      ],
      ['list_competitors', {}, (t) => expect(t).toContain('c-1')],
      [
        'get_competitor_intelligence',
        { competitor_id: cuuid },
        (t) => expect(t).toContain('momentum_score'),
      ],
      ['list_projects', {}, (t) => expect(t).toContain('p-1')],
      ['list_reports', { project_id: uuid }, (t) => expect(t).toContain('r-1')],
      [
        'get_report',
        { report_id: 'r-1' },
        (t) => expect(t.startsWith('# Rivalize Competitive Intelligence Report')).toBe(true),
      ],
    ];
    for (const [name, args, check] of calls) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, `${name} should not error`).toBeFalsy();
      check((res.content as Array<{ text: string }>)[0].text);
    }
  });

  it('happy path: add_competitor over the real protocol when writes are enabled', async () => {
    const { client } = await setup(undefined, { allowWrites: true });
    const res = await client.callTool({
      name: 'add_competitor',
      arguments: {
        project_id: '11111111-1111-4111-8111-111111111111',
        urls: ['https://rival.example'],
      },
    });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toContain('j-1');
  });

  it('20 concurrent mixed calls resolve independently; a slow call does not wedge the rest', async () => {
    let slowResolved = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/universe/companies/slow.co')) {
        await new Promise((r) => setTimeout(r, 300));
        slowResolved = true;
        return new Response(JSON.stringify({ data: { domain: 'slow.co', name: 'Slow' } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: [{ id: 'c-1' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { client } = await setup(fetchImpl);

    const slow = client.callTool({
      name: 'get_universe_company',
      arguments: { domain: 'slow.co' },
    });
    const fast = Array.from({ length: 20 }, () =>
      client.callTool({ name: 'list_competitors', arguments: {} }),
    );
    const fastResults = await Promise.all(fast);
    // Every fast call finished while the slow one was still pending.
    expect(slowResolved).toBe(false);
    for (const r of fastResults) expect(r.isError).toBeFalsy();
    const slowRes = await slow;
    expect(slowRes.isError).toBeFalsy();
    expect((slowRes.content as Array<{ text: string }>)[0].text).toContain('slow.co');
  });

  it('the API key never appears in tool results or protocol errors', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { client } = await setup(failing);
    const res = await client.callTool({ name: 'list_competitors', arguments: {} });
    expect(JSON.stringify(res)).not.toContain(API_KEY);
    const listing = await client.listTools();
    expect(JSON.stringify(listing)).not.toContain(API_KEY);
  });
});
