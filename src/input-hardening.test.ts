/**
 * Input hardening and the 404 form.
 *
 * - A NUL character (U+0000) in q, category or domain would reach the API,
 *   whose database cannot store it, and come back as a 500. The MCP refuses
 *   it before any request is sent.
 * - domain is at most 253 characters, the longest a DNS name can be. Without
 *   the bound, an oversized domain reaches the API or fails at the edge as a
 *   431 or 502.
 * - Every tool answers a 404 with a code and the list_ call that returns valid
 *   ids, never a generic "Verify the id/domain"; a report-id 404 never
 *   mentions a domain.
 * - "<input> is not in the Rivalize universe yet" echoes only a short prefix
 *   of the input, not the whole of it.
 *
 * Two layers are exercised: the REAL McpServer over an in-memory transport
 * (the SDK validates against the tool's input schema, as a client sees it),
 * and the handlers directly (a caller that skips schema validation still meets
 * the handler's own guard). Every HTTP call is a mocked fetch.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RivalizeApiError, RivalizeClient } from './client.js';
import { buildServer } from './index.js';
import { ECHO_MAX, MAX_DOMAIN_LENGTH, registerTools } from './tools.js';

const CONFIG = { apiKey: 'rk_live_hardening_suite', apiUrl: 'https://api.test.invalid' };
const UUID = '11111111-1111-4111-8111-111111111111';
const NUL = '\u0000';

function okFetch(): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: { domain: 'x.co', name: 'X' },
          pagination: { total: 0, limit: 50, offset: 0 },
          filters: {},
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close().catch(() => {});
});

async function connect(fetchImpl: typeof fetch) {
  const server = buildServer(new RivalizeClient(CONFIG, fetchImpl));
  const client = new Client({ name: 'hardening-suite', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  open.push(() => client.close());
  return client;
}

/** The text of a call that must be refused: a thrown protocol error or an isError result. */
async function refusal(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args }).catch((e: Error) => e);
  if (res instanceof Error) return { refused: true, text: res.message };
  const r = res as { isError?: boolean; content?: Array<{ text?: string }> };
  return { refused: r.isError === true, text: (r.content ?? []).map((c) => c.text).join('\n') };
}

const NUL_INPUTS: Array<[string, Record<string, unknown>]> = [
  ['list_universe_companies', { q: `a${NUL}b` }],
  ['list_universe_companies', { category: NUL }],
  ['get_universe_company', { domain: `a${NUL}b.com` }],
  ['teardown_competitor', { domain: NUL }],
];

describe('a NUL character is refused by the MCP, before any request', () => {
  for (const [name, args] of NUL_INPUTS) {
    it(`${name} ${JSON.stringify(args)} is a validation error, and no request is sent`, async () => {
      const fetchImpl = okFetch();
      const client = await connect(fetchImpl);
      const { refused, text } = await refusal(client, name, args);
      expect(refused).toBe(true);
      // The tool's input SCHEMA answered (the SDK's message), not the
      // handler's fallback guard: a client sees the rule in tools/list.
      expect(text).toContain('Input validation error');
      expect(text).toContain('NUL');
      expect(text).not.toMatch(/\b500\b|INTERNAL_ERROR/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  it('every other free-text argument refuses a NUL too', async () => {
    const fetchImpl = okFetch();
    const client = await connect(fetchImpl);
    for (const args of [
      { report_id: `r${NUL}1` },
      { report_id: 'r-1', section: `tl${NUL}dr` },
      { report_id: 'r-1', competitor: `No${NUL}tion` },
    ]) {
      const { refused, text } = await refusal(client, 'get_report', args);
      expect(refused, JSON.stringify(args)).toBe(true);
      expect(text, JSON.stringify(args)).toContain('Input validation error');
      expect(text, JSON.stringify(args)).toContain('NUL');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('companion: the same arguments without the NUL do reach the API', async () => {
    const fetchImpl = okFetch();
    const client = await connect(fetchImpl);
    await client.callTool({ name: 'list_universe_companies', arguments: { q: 'ab' } });
    await client.callTool({ name: 'get_universe_company', arguments: { domain: 'ab.com' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a caller that skips schema validation meets the handler guard', async () => {
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool(name: string, _c: unknown, h: (a: Record<string, unknown>) => Promise<unknown>) {
        tools.set(name, h);
      },
    };
    const client = {
      listUniverseCompanies: vi.fn(async () => ({ data: [] })),
      getUniverseCompany: vi.fn(async () => ({ data: { domain: 'x.co' } })),
      getReportIntelligence: vi.fn(async () => ({ data: { markdown: '# R' } })),
      listCompetitors: vi.fn(async () => ({ data: [] })),
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural fakes for the SDK server and client
    registerTools(server as any, client as any);
    for (const [name, args] of [...NUL_INPUTS, ['get_report', { report_id: `r${NUL}` }]] as Array<
      [string, Record<string, unknown>]
    >) {
      const res = (await tools.get(name)?.(args)) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(res.isError, name).toBe(true);
      expect(res.content[0].text, name).toMatch(
        /^Error \(invalid argument\): [a-z_]+ must not contain a NUL/,
      );
    }
    expect(client.listUniverseCompanies).not.toHaveBeenCalled();
    expect(client.getUniverseCompany).not.toHaveBeenCalled();
    expect(client.getReportIntelligence).not.toHaveBeenCalled();
  });
});

describe('domain is at most 253 characters', () => {
  const label = 'a'.repeat(60);
  // 253 = four 60-character labels, three dots and ".com" minus padding.
  const at253 = `${label}.${label}.${label}.${'a'.repeat(253 - 3 * 61 - 4)}.com`;
  const at254 = `a${at253}`;

  it('the fixtures are the lengths they claim', () => {
    expect(MAX_DOMAIN_LENGTH).toBe(253);
    expect(at253).toHaveLength(253);
    expect(at254).toHaveLength(254);
  });

  it('tools/list advertises maxLength 253 on both domain tools', async () => {
    const client = await connect(okFetch());
    const { tools } = await client.listTools();
    for (const name of ['get_universe_company', 'teardown_competitor']) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as {
        properties: { domain: { maxLength?: number } };
      };
      expect(schema, name).toBeDefined();
      expect(schema.properties.domain.maxLength, name).toBe(253);
    }
  });

  for (const name of ['get_universe_company', 'teardown_competitor']) {
    it(`${name}: 254 characters is refused before any request; 253 is sent`, async () => {
      const fetchImpl = okFetch();
      const client = await connect(fetchImpl);
      for (const domain of [at254, 'x'.repeat(5_004), 'x'.repeat(300_004)]) {
        const { refused, text } = await refusal(client, name, { domain });
        expect(refused, `${domain.length}`).toBe(true);
        expect(text, `${domain.length}`).toContain('Input validation error');
        expect(text, `${domain.length}`).toContain('253');
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      await client.callTool({ name, arguments: { domain: at253 } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  }

  it('the handler guard bounds the length for a caller that skips validation', async () => {
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool(name: string, _c: unknown, h: (a: Record<string, unknown>) => Promise<unknown>) {
        tools.set(name, h);
      },
    };
    const client = { getUniverseCompany: vi.fn(async () => ({ data: { domain: 'x.co' } })) };
    // biome-ignore lint/suspicious/noExplicitAny: structural fakes for the SDK server and client
    registerTools(server as any, client as any);
    for (const name of ['get_universe_company', 'teardown_competitor']) {
      const res = (await tools.get(name)?.({ domain: at254 })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(res.isError, name).toBe(true);
      expect(res.content[0].text, name).toBe(
        'Error (invalid argument): domain must be at most 253 characters (got 254).',
      );
    }
    expect(client.getUniverseCompany).not.toHaveBeenCalled();
  });
});

// ── One 404 form for every tool ─────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** Every client method answers 404 with the given code (undefined = no code). */
function notFoundHarness(code: string | undefined, message: string) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _c: unknown, h: Handler) {
      tools.set(name, h);
    },
  };
  const fail = vi.fn(async () => {
    throw new RivalizeApiError(404, message, code, 'https://rivalize.ai');
  });
  const client = new Proxy({}, { get: () => fail });
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes for the SDK server and client
  registerTools(server as any, client as any, { allowWrites: true });
  return tools;
}

/** Each tool that takes an id, with the code and the list_ call its 404 must name. */
const ID_TOOLS: Array<[string, Record<string, unknown>, string, string]> = [
  ['get_report', { report_id: 'r-missing' }, 'REPORT_NOT_FOUND', 'list_reports'],
  [
    'get_competitor_intelligence',
    { competitor_id: UUID },
    'COMPETITOR_NOT_FOUND',
    'list_competitors',
  ],
  ['get_battlecard', { competitor_id: UUID }, 'COMPETITOR_NOT_FOUND', 'list_competitors'],
  ['list_competitors', { project_id: UUID }, 'PROJECT_NOT_FOUND', 'list_projects'],
  ['list_reports', { project_id: UUID }, 'PROJECT_NOT_FOUND', 'list_projects'],
  ['get_strategic_timeline', { project_id: UUID }, 'PROJECT_NOT_FOUND', 'list_projects'],
  ['get_competitive_landscape', { project_id: UUID }, 'PROJECT_NOT_FOUND', 'list_projects'],
  ['get_freshness', { project_id: UUID }, 'PROJECT_NOT_FOUND', 'list_projects'],
  ['get_evidence', { project_id: UUID }, 'PROJECT_NOT_FOUND', 'list_projects'],
  [
    'add_competitor',
    { project_id: UUID, urls: ['https://x.co'] },
    'PROJECT_NOT_FOUND',
    'list_projects',
  ],
];

describe('every tool answers a 404 with a code and the list_ call that finds valid ids', () => {
  for (const apiCode of ['NOT_FOUND', undefined]) {
    for (const [name, args, code, listCall] of ID_TOOLS) {
      it(`${name}, API code ${apiCode ?? '(none)'} -> ${code} + "call ${listCall}"`, async () => {
        const tools = notFoundHarness(apiCode, 'Not found');
        const res = await tools.get(name)?.(args);
        expect(res, name).toBeDefined();
        const text = res?.content[0].text ?? '';
        expect(res?.isError).toBe(true);
        expect(text).toContain(`Error (404 ${code})`);
        expect(text).toContain(`Call ${listCall}`);
        expect(text).not.toContain('Verify the id/domain');
      });
    }
  }

  it('the three account-scoped reads, with the exact text the API sends', async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['get_report', { report_id: 'r-missing' }, 'Report not found', 'REPORT_NOT_FOUND'],
      ['get_battlecard', { competitor_id: UUID }, 'Competitor not found', 'COMPETITOR_NOT_FOUND'],
      [
        'get_competitor_intelligence',
        { competitor_id: UUID },
        'Competitor not found',
        'COMPETITOR_NOT_FOUND',
      ],
    ];
    for (const [name, args, message, code] of cases) {
      const res = await notFoundHarness('NOT_FOUND', message).get(name)?.(args);
      expect(res?.content[0].text).toMatch(
        new RegExp(`^Error \\(404 ${code}\\): ${message}\\. Call list_`),
      );
    }
  });

  it('no 404 for a report id mentions a domain, whatever code the API sends', async () => {
    for (const apiCode of ['NOT_FOUND', undefined, 'REPORT_NOT_FOUND', 'SOMETHING_NEW']) {
      const res = await notFoundHarness(apiCode, 'Report not found').get('get_report')?.({
        report_id: 'r-missing',
      });
      expect(res?.isError, String(apiCode)).toBe(true);
      expect(res?.content[0].text.toLowerCase(), String(apiCode)).not.toContain('domain');
    }
  });

  it('a code the API already sends is kept (NOT_READY on a report in review)', async () => {
    const res = await notFoundHarness('NOT_READY', 'Report is not available yet').get(
      'get_report',
    )?.({ report_id: 'r-1' });
    expect(res?.content[0].text).toContain('Error (404 NOT_READY)');
    expect(res?.content[0].text).toContain('list_reports');
  });
});

// ── The not-in-universe message echoes only a short prefix ──────────────────

describe('echoed input is length-capped', () => {
  function notInUniverseHarness() {
    const tools = new Map<string, Handler>();
    const server = {
      registerTool(name: string, _c: unknown, h: Handler) {
        tools.set(name, h);
      },
    };
    const client = {
      getUniverseCompany: vi.fn(async () => {
        throw new RivalizeApiError(404, 'Universe company not found', 'NOT_FOUND');
      }),
      listCompetitors: vi.fn(async () => ({ data: [], pagination: { total: 0 } })),
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural fakes for the SDK server and client
    registerTools(server as any, client as any);
    return tools;
  }

  for (const name of ['get_universe_company', 'teardown_competitor']) {
    it(`${name}: the longest accepted input is echoed as at most ${ECHO_MAX} characters`, async () => {
      // 253 characters: the most the schema lets through.
      const input = `${'q'.repeat(245)}.example`;
      expect(input).toHaveLength(MAX_DOMAIN_LENGTH);
      const res = await notInUniverseHarness().get(name)?.({ domain: input });
      const text = res?.content[0].text ?? '';
      expect(text).toContain('is not in the Rivalize universe yet');
      // The longest run of the input that appears in the reply.
      const echoed = text.match(/q+/g)?.reduce((m, s) => Math.max(m, s.length), 0) ?? 0;
      expect(echoed).toBeGreaterThan(0);
      expect(echoed).toBeLessThanOrEqual(ECHO_MAX);
      expect(text).toContain('253 characters');
      expect(text.length).toBeLessThan(600);
    });
  }

  it('a short input is echoed whole, unchanged', async () => {
    const res = await notInUniverseHarness().get('get_universe_company')?.({ domain: 'gone.io' });
    expect(res?.content[0].text).toContain('"gone.io" is not in the Rivalize universe yet');
  });

  it('ECHO_MAX is a short prefix', () => {
    expect(ECHO_MAX).toBeGreaterThan(0);
    expect(ECHO_MAX).toBeLessThanOrEqual(80);
  });
});
