/**
 * Tool-level response tests on full-scale payloads: truthful paging, the
 * 25,000-character limit, layer capping, tool descriptions, and the hints
 * that accompany errors. Handlers are driven through a fake server against a
 * mocked client: no network, no metered work.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  demoSeedCompany,
  exampleScaleCompany,
  REPORT_COMPETITORS,
  twentyCompetitorReportMarkdown,
  universeListRow,
} from './__fixtures__/payloads.js';
import { RivalizeApiError, RivalizeClient } from './client.js';
import { registerTools } from './tools.js';

const LIMIT = 25_000;

type Result = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function harness(client: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  const tools = new Map<string, { description: string; handler: Handler }>();
  const server = {
    registerTool(name: string, config: { description: string }, handler: Handler) {
      tools.set(name, { description: config.description, handler });
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes
  registerTools(server as any, client as any, opts as any);
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.handler(args);
  };
  const description = (name: string) => tools.get(name)?.description ?? '';
  return { call, description };
}

function text(res: Result): string {
  expect(res.content.length).toBe(1);
  return res.content[0].text;
}

/** A universe list endpoint over `total` rows that honours limit/offset like the API. */
function universeServer(total: number) {
  const all = Array.from({ length: total }, (_, i) => universeListRow(i));
  return {
    all,
    listUniverseCompanies: vi.fn(async (args: { limit?: number; offset?: number }) => {
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      return {
        data: all.slice(offset, offset + limit),
        pagination: { total, limit, offset },
        filters: { q: null, category: null, layer: null },
      };
    }),
  };
}

describe('list_universe_companies — slim rows, compact JSON, truthful paging', () => {
  it('50 rows fit in one response, compactly serialized', async () => {
    const srv = universeServer(2159);
    const { call } = harness(srv);
    const out = text(await call('list_universe_companies', { limit: 50 }));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out).not.toContain('\n  ');
    const parsed = JSON.parse(out);
    expect(parsed.data).toHaveLength(50);
    expect(parsed._truncated).toBeUndefined();
    expect(parsed.pagination).toMatchObject({
      total: 2159,
      limit: 50,
      offset: 0,
      returned: 50,
      next_offset: 50,
    });
  });

  it('a slim row keeps what an agent needs to choose a company and drops the rest', async () => {
    const srv = universeServer(3);
    const { call } = harness(srv);
    const row = JSON.parse(text(await call('list_universe_companies', {}))).data[0];
    expect(row).toMatchObject({
      domain: 'company-0.example',
      name: 'Company 0000',
      primaryCategory: 'AI infrastructure',
      priorityScore: 100,
      categories: ['ai-dev-tools', 'ai-infra'],
    });
    expect(row.layers).toEqual(
      expect.arrayContaining(['ads', 'social', 'pricing', 'reviews', 'features', 'identity']),
    );
    expect(row.layersUpdated).toBe('2026-06-08 to 2026-06-10');
    expect(typeof row.description).toBe('string');
    expect(row.description.length).toBeLessThanOrEqual(120);
    for (const dropped of ['id', 'slug', 'homepageUrl', 'freshnessTier', 'layerFreshness']) {
      expect(row, dropped).not.toHaveProperty(dropped);
    }
  });

  it('{limit:100}: every dropped row is accounted for in-band, and pagination.limit is never larger than what came back', async () => {
    const srv = universeServer(2159);
    const { call } = harness(srv);
    const out = text(await call('list_universe_companies', { limit: 100 }));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(out);
    const returned = parsed.data.length;
    expect(returned).toBeGreaterThanOrEqual(50);
    if (returned < 100) {
      expect(parsed._truncated).toBe(true);
      expect(parsed.pagination.limit).toBe(returned);
      expect(parsed.pagination.requested_limit).toBe(100);
      expect(parsed._truncation_message).toContain(`offset=${returned}`);
    }
    expect(parsed.pagination.returned).toBe(returned);
    expect(parsed.pagination.next_offset).toBe(returned);
  });

  it('paging with next_offset (limit 100) visits every row exactly once — compared as a SET', async () => {
    const srv = universeServer(437);
    const { call } = harness(srv);
    const seen: string[] = [];
    let offset: number | null = 0;
    let calls = 0;
    while (offset !== null && calls < 50) {
      const parsed = JSON.parse(
        text(await call('list_universe_companies', { limit: 100, offset })),
      );
      for (const r of parsed.data) seen.push(r.domain);
      offset = parsed.pagination.next_offset;
      calls++;
    }
    expect(offset).toBeNull();
    const expected = new Set(srv.all.map((r) => r.domain as string));
    expect(seen.length).toBe(437);
    expect(new Set(seen)).toEqual(expected);
  });
});

/** A competitor row as GET /v1/competitors returns it (with a realistic description). */
function competitorRow(i: number, projectName = 'Carbon Co') {
  return {
    id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    project_id: 'p0000000-0000-4000-8000-000000000001',
    project_name: projectName,
    name: `Rival ${i}`,
    slug: `rival-${i}`,
    website: `https://www.rival-${i}.example/`,
    threat_level: i % 3 === 0 ? 'high' : 'medium',
    momentum_score: 40 + (i % 50),
    description: `Rival ${i} ${'sells carbon accounting and advisory to enterprise teams. '.repeat(8)}`,
    social_handles: { linkedin: `rival-${i}`, twitter: `rival${i}` },
    is_active: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-30T00:00:00.000Z',
  };
}

describe('list_competitors — limit/offset, old and new server responses', () => {
  const rows = Array.from({ length: 53 }, (_, i) => competitorRow(i));

  it('forwards limit and offset to the client', async () => {
    const listCompetitors = vi.fn(async () => ({ data: rows.slice(20, 30) }));
    const { call } = harness({ listCompetitors });
    await call('list_competitors', { project_id: 'p-1', limit: 10, offset: 20 });
    expect(listCompetitors).toHaveBeenCalledWith({ projectId: 'p-1', limit: 10, offset: 20 });
  });

  it('OLD server (no pagination, every row): next_offset pages through all 53 — compared as a SET', async () => {
    const listCompetitors = vi.fn(async () => ({ data: rows }));
    const { call } = harness({ listCompetitors });
    const seen: string[] = [];
    let offset: number | null = 0;
    let calls = 0;
    while (offset !== null && calls < 20) {
      const out = text(await call('list_competitors', offset === 0 ? {} : { offset }));
      expect(out.length).toBeLessThanOrEqual(LIMIT);
      const parsed = JSON.parse(out);
      for (const r of parsed.data) seen.push(r.id);
      expect(parsed.pagination.total).toBe(53);
      offset = parsed.pagination.next_offset;
      calls++;
    }
    expect(calls).toBeGreaterThan(1); // 53 rows do not fit one response
    expect(seen.length).toBe(53);
    expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.id)));
  });

  it('OLD server: limit/offset are applied locally', async () => {
    const { call } = harness({ listCompetitors: vi.fn(async () => ({ data: rows })) });
    const parsed = JSON.parse(text(await call('list_competitors', { limit: 10, offset: 50 })));
    expect(parsed.data.map((r: { id: string }) => r.id)).toEqual(rows.slice(50).map((r) => r.id));
    expect(parsed.pagination).toMatchObject({
      total: 53,
      offset: 50,
      returned: 3,
      next_offset: null,
    });
  });

  it('NEW server (pagination present): rows are taken as served, not re-sliced', async () => {
    const listCompetitors = vi.fn(async () => ({
      data: rows.slice(10, 20),
      pagination: { total: 53, limit: 10, offset: 10 },
    }));
    const { call } = harness({ listCompetitors });
    const parsed = JSON.parse(text(await call('list_competitors', { limit: 10, offset: 10 })));
    expect(parsed.data.map((r: { id: string }) => r.id)).toEqual(
      rows.slice(10, 20).map((r) => r.id),
    );
    expect(parsed.pagination).toMatchObject({
      total: 53,
      limit: 10,
      offset: 10,
      returned: 10,
      next_offset: 20,
    });
  });
});

/** Strip the page header (everything up to the first blank line after it). */
function body(page: string): string {
  const marker = '\n\n<!-- page-body -->\n';
  const at = page.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return page.slice(at + marker.length);
}

describe('get_report — paging at heading boundaries, competitor filter', () => {
  const md = twentyCompetitorReportMarkdown();
  const client = () => ({
    getReportIntelligence: vi.fn(async () => ({ data: { id: 'r-1', markdown: md } })),
  });

  it('the fixture is at full scale (a 20-competitor report well over the limit)', () => {
    expect(md.length).toBeGreaterThan(100_000);
    expect(md.match(/^## /gm)?.length).toBe(26);
  });

  it('a report under the limit comes back byte-identical, with or without page 1', async () => {
    const small = '# Rivalize Competitive Intelligence Report\n\n## TL;DR\nThey lead.';
    const { call } = harness({
      getReportIntelligence: vi.fn(async () => ({ data: { markdown: small } })),
    });
    expect(text(await call('get_report', { report_id: 'r-1' }))).toBe(small);
    expect(text(await call('get_report', { report_id: 'r-1', page: 1 }))).toBe(small);
  });

  it('page 1 names its position, the exact next call, what remains, and a TOC of later pages', async () => {
    const { call } = harness(client());
    const p1 = text(await call('get_report', { report_id: 'r-1' }));
    expect(p1.length).toBeLessThanOrEqual(LIMIT);
    const m = /Page 1 of (\d+)/.exec(p1);
    expect(m).not.toBeNull();
    const pages = Number(m?.[1]);
    expect(pages).toBeGreaterThanOrEqual(5);
    expect(p1).toContain('get_report {"report_id":"r-1","page":2}');
    expect(p1).toMatch(/[\d,]+ characters remain on pages 2[–-]\d+/);
    // The last competitor lives on a later page; the TOC in the HEADER names it
    // (the report intro also names every competitor, so the body cannot prove it).
    expect(body(p1)).not.toContain(`## ${REPORT_COMPETITORS[19]}`);
    const header = p1.slice(0, p1.indexOf('<!-- page-body -->'));
    expect(header).toMatch(new RegExp(`p\\d+: [^\\n]*${REPORT_COMPETITORS[19]}`));
    expect(p1.startsWith('> **Page 1 of')).toBe(true);
  });

  it('every page is under the limit and the page bodies concatenate back to the exact report', async () => {
    const { call } = harness(client());
    const first = text(await call('get_report', { report_id: 'r-1' }));
    const pages = Number(/Page 1 of (\d+)/.exec(first)?.[1]);
    let joined = body(first);
    for (let p = 2; p <= pages; p++) {
      const page = text(await call('get_report', { report_id: 'r-1', page: p }));
      expect(page.length, `page ${p}`).toBeLessThanOrEqual(LIMIT);
      expect(page).toContain(`Page ${p} of ${pages}`);
      if (p < pages) expect(page).toContain(`"page":${p + 1}`);
      else expect(page).toContain('last page');
      joined += body(page);
    }
    expect(joined).toBe(md);
    // Every competitor section heading reached the agent.
    for (const name of REPORT_COMPETITORS) expect(joined).toContain(`## ${name}`);
  });

  it('a page past the end is an error that names the page count', async () => {
    const { call } = harness(client());
    const res = await call('get_report', { report_id: 'r-1', page: 99 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/has \d+ pages/);
  });

  it('competitor returns that competitor’s section and battlecard plus the title and date, case-insensitively', async () => {
    const { call } = harness(client());
    const out = text(await call('get_report', { report_id: 'r-1', competitor: 'carbon vault co' }));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out).toContain('# Rivalize Competitive Intelligence Report');
    expect(out).toContain('**Generated:** October 1, 2026');
    expect(out).toContain('## Carbon Vault Co');
    expect(out).toContain('### vs Carbon Vault Co');
    expect(out).not.toContain('## Quorl');
    expect(out).not.toContain('## Northwind Carbon');
    expect(out).not.toContain('Page 1 of');
  });

  it('competitor that names no heading is an error listing the sections that exist', async () => {
    const { call } = harness(client());
    const res = await call('get_report', { report_id: 'r-1', competitor: 'Nobody Inc' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Riverbend Climate');
  });
});

function timelineMarkdown(): string {
  const lines = ['# Strategic Timeline', '', 'Tracking since 2026-04-01. Window: 180 days.', ''];
  for (const lane of ['Pricing', 'Product', 'People', 'Funding', 'Content/Social']) {
    lines.push(`## ${lane}`, '');
    for (let m = 0; m < 6; m++) {
      lines.push(`### ${lane} move ${m}`, '');
      for (let e = 0; e < 18; e++)
        lines.push(
          `- 2026-0${(e % 6) + 4}-1${e % 9} — Rival ${e}: [Google Play heartbeat ${e} for ${lane}](https://evidence.example/${lane}/${m}/${e})`,
        );
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

describe('get_strategic_timeline / get_competitive_landscape — paged, never silently cut', () => {
  const P = '11111111-1111-4111-8111-111111111111';

  it('a 180-day timeline over the limit pages, names the next call, and loses nothing', async () => {
    const md = timelineMarkdown();
    expect(md.length).toBeGreaterThan(LIMIT * 2);
    const { call } = harness({ getStrategicTimelineMarkdown: vi.fn(async () => md) });
    const first = text(await call('get_strategic_timeline', { project_id: P, days: '180' }));
    expect(first.length).toBeLessThanOrEqual(LIMIT);
    expect(first).toContain(`get_strategic_timeline {"project_id":"${P}","days":"180","page":2}`);
    const pages = Number(/Page 1 of (\d+)/.exec(first)?.[1]);
    let joined = body(first);
    for (let p = 2; p <= pages; p++)
      joined += body(
        text(await call('get_strategic_timeline', { project_id: P, days: '180', page: p })),
      );
    expect(joined).toBe(md);
  });

  it('a heading-less landscape list pages at line boundaries', async () => {
    const md = [
      '# Competitive Landscape',
      '',
      ...Array.from(
        { length: 400 },
        (_, i) =>
          `- Rival ${i} — activity ${i}, importance 3, trailing signals ${i}; latest: ${'x'.repeat(60)}`,
      ),
    ].join('\n');
    const { call } = harness({ getLandscapeMarkdown: vi.fn(async () => md) });
    const first = text(await call('get_competitive_landscape', { project_id: P }));
    expect(first.length).toBeLessThanOrEqual(LIMIT);
    const pages = Number(/Page 1 of (\d+)/.exec(first)?.[1]);
    expect(pages).toBeGreaterThan(1);
    let joined = body(first);
    for (let p = 2; p <= pages; p++)
      joined += body(text(await call('get_competitive_landscape', { project_id: P, page: p })));
    expect(joined).toBe(md);
  });

  it('timeline JSON over the limit stays valid JSON and says how to get the rest', async () => {
    const events = Array.from({ length: 400 }, (_, i) => ({
      id: `e-${i}`,
      title: `Google Play heartbeat ${i} ${'y'.repeat(80)}`,
      evidenceUrl: `https://evidence.example/${i}`,
    }));
    const { call } = harness({
      getStrategicTimeline: vi.fn(async () => ({
        data: { days: 180, events, moves: [], lanes: [] },
      })),
    });
    const out = text(await call('get_strategic_timeline', { project_id: P, format: 'json' }));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    expect(parsed._truncation_message).toContain('format "markdown"');
    expect(JSON.stringify(parsed)).toContain('400');
  });
});

describe('get_universe_company — valid JSON, every layer, capped arrays, layers filter', () => {
  const LAYERS = [
    'identity',
    'pricing',
    'features',
    'ads',
    'socialInfluencers',
    'reviews',
    'fundingHiring',
    'rankings',
    'signals',
    'momentum',
  ];

  it('the fixture is at full scale (over the limit compact)', () => {
    expect(JSON.stringify({ data: exampleScaleCompany() }).length).toBeGreaterThan(LIMIT);
  });

  it('example.com by default: valid JSON under the limit carrying EVERY layer, long arrays capped with counts', async () => {
    const { call } = harness({
      getUniverseCompany: vi.fn(async () => ({ data: exampleScaleCompany() })),
    });
    const out = text(await call('get_universe_company', { domain: 'example.com' }));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(out);
    for (const layer of LAYERS) expect(parsed.data, layer).toHaveProperty(layer);
    expect(parsed.data.reviews.appStore.rating).toBe(4.62);
    expect(parsed.data.fundingHiring.openRoles).toBe(312);
    expect(parsed.data.socialInfluencers.recentPosts.length).toBeLessThanOrEqual(5);
    expect(parsed._capped['socialInfluencers.recentPosts']).toMatchObject({ kept: 5, total: 34 });
    expect(parsed._omitted).toBeUndefined();
  });

  it('layers returns only the named layers plus the identifying fields', async () => {
    const { call } = harness({
      getUniverseCompany: vi.fn(async () => ({ data: exampleScaleCompany() })),
    });
    const parsed = JSON.parse(
      text(
        await call('get_universe_company', {
          domain: 'example.com',
          layers: ['social', 'reviews'],
        }),
      ),
    );
    expect(parsed.data.domain).toBe('example.com');
    expect(parsed.data.name).toBe('Example Co');
    expect(parsed.data).toHaveProperty('socialInfluencers');
    expect(parsed.data).toHaveProperty('reviews');
    for (const other of ['identity', 'pricing', 'ads', 'rankings', 'momentum'])
      expect(parsed.data, other).not.toHaveProperty(other);
    // One layer asked for gets more of its long arrays than the default view.
    expect(parsed.data.socialInfluencers.recentPosts.length).toBeGreaterThan(5);
  });

  it('41-style near-identical identity.sources collapse to a few, with the count said', async () => {
    const { call } = harness({
      getUniverseCompany: vi.fn(async () => ({ data: demoSeedCompany() })),
    });
    const parsed = JSON.parse(text(await call('get_universe_company', { domain: 'tasks.test' })));
    expect(parsed.data.identity.sources.length).toBeLessThanOrEqual(3);
    expect(parsed._capped['identity.sources'].total).toBe(40);
  });

  it('still oversized after caps: whole layers are dropped and listed with the call that fetches each', async () => {
    const huge = { ...exampleScaleCompany(), reviews: { blob: 'r'.repeat(40_000) } };
    const { call } = harness({ getUniverseCompany: vi.fn(async () => ({ data: huge })) });
    const out = text(await call('get_universe_company', { domain: 'example.com' }));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(out);
    expect(parsed.data).not.toHaveProperty('reviews');
    expect(parsed.data).toHaveProperty('pricing');
    const omitted = parsed._omitted.find((o: { field: string }) => o.field === 'reviews');
    expect(omitted.call).toBe(
      'get_universe_company {"domain":"example.com","layers":["reviews"]}',
    );
  });
});

describe('descriptions say what each tool is for and promise only what it returns', () => {
  const { description } = harness({});

  it('list_projects answers "what products/projects do I have"; list_competitors answers "which competitors am I tracking"', () => {
    expect(description('list_projects')).toMatch(/what products\/projects do I have/i);
    expect(description('list_projects')).not.toMatch(/what am I tracking/i);
    expect(description('list_competitors')).toMatch(/which competitors am I tracking/i);
  });

  it('list_competitors points at the per-competitor reads and says how to pick the top competitor', () => {
    const d = description('list_competitors');
    for (const tool of ['get_battlecard', 'get_report', 'get_competitor_intelligence'])
      expect(d).toContain(tool);
    expect(d).toMatch(/threat_level.*then.*momentum_score/is);
    expect(d).toContain('next_offset');
  });

  it('project-scoped tools say to call list_projects first for the id', () => {
    for (const name of ['list_reports', 'get_strategic_timeline', 'get_competitive_landscape'])
      expect(description(name), name).toMatch(/call list_projects first/i);
  });

  it('get_competitor_intelligence promises fields only where measured, and names source_report_id', () => {
    const d = description('get_competitor_intelligence');
    expect(d).toMatch(/present only when measured/i);
    expect(d).toContain('source_report_id');
    expect(d).not.toMatch(
      /snapshot for one tracked competitor — SWOT, pricing, tech stack, social stats, reviews, and key findings\./,
    );
  });

  it('get_battlecard documents the report-sourced variant', () => {
    const d = description('get_battlecard');
    expect(d).toContain('source');
    expect(d).toContain('"report"');
    expect(d).toContain('report_id');
  });

  it('get_battlecard names the three card statuses and the section fields', () => {
    const d = description('get_battlecard');
    for (const word of ['"ready"', '"partial"', '"withheld"', '"not_generated"'])
      expect(d).toContain(word);
    for (const field of ['sections_empty', 'sections_locked', 'withheld_reason'])
      expect(d).toContain(field);
    expect(d).toMatch(/Do not treat "partial" or "withheld" as a complete card/);
  });

  it('get_report, get_universe_company and the timeline describe their new arguments', () => {
    expect(description('get_report')).toContain('page');
    expect(description('get_report')).toContain('competitor');
    expect(description('get_universe_company')).toContain('layers');
    expect(description('get_strategic_timeline')).toContain('page');
    expect(description('get_competitive_landscape')).toContain('page');
    expect(description('list_universe_companies')).toMatch(/slug/);
  });
});

describe('a 401 names the server the key went to', () => {
  it('the message names the URL and says a key only works on the server that issued it', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'INVALID_KEY', message: 'API key is invalid or has been revoked' },
          }),
          { status: 401 },
        ),
    ) as unknown as typeof fetch;
    const client = new RivalizeClient(
      { apiKey: 'rk_live_secret_401', apiUrl: 'https://rivalize.ai', allowWrites: false },
      fetchImpl,
    );
    const { call } = harness(client as unknown as Record<string, unknown>);
    const res = await call('list_projects');
    expect(res.isError).toBe(true);
    const t = text(res);
    expect(t).toContain('https://rivalize.ai');
    expect(t).toMatch(/only works on the (Rivalize )?server that issued it/i);
    expect(t).toContain('RIVALIZE_API_URL');
    expect(t).not.toContain('rk_live_secret_401');
  });
});

describe('a universe 404 for a domain already tracked in the account', () => {
  const tracked = {
    ...competitorRow(7, 'Sales Enablement'),
    name: 'Northpeak',
    website: 'https://www.northpeak.example/pricing',
  };
  const notFound = vi.fn(async () => {
    throw new RivalizeApiError(404, 'Universe company not found', 'NOT_FOUND');
  });

  it('teardown says it is tracked (naming the project) and points at the account reads, not "add it"', async () => {
    const { call } = harness({
      getUniverseCompany: notFound,
      listCompetitors: vi.fn(async () => ({ data: [competitorRow(1), tracked] })),
    });
    const t = text(await call('teardown_competitor', { domain: 'northpeak.example' }));
    expect(t).toContain('already tracked');
    expect(t).toContain('"Northpeak"');
    expect(t).toContain('Sales Enablement');
    expect(t).toContain(`get_competitor_intelligence {"competitor_id":"${tracked.id}"}`);
    expect(t).toContain('get_report');
    expect(t).not.toMatch(/Add it as a competitor/i);
  });

  it('finds the match on a later page of a paging server', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => competitorRow(100 + i));
    const listCompetitors = vi.fn(async (p: { offset?: number }) =>
      (p.offset ?? 0) === 0
        ? { data: page1, pagination: { total: 101, limit: 100, offset: 0 } }
        : { data: [tracked], pagination: { total: 101, limit: 100, offset: 100 } },
    );
    const { call } = harness({ getUniverseCompany: notFound, listCompetitors });
    const t = text(await call('get_universe_company', { domain: 'https://northpeak.example' }));
    expect(listCompetitors).toHaveBeenCalledTimes(2);
    expect(t).toContain('already tracked');
  });

  it('companion: an untracked domain keeps the add-it message', async () => {
    const { call } = harness({
      getUniverseCompany: notFound,
      listCompetitors: vi.fn(async () => ({ data: [competitorRow(1)] })),
    });
    const t = text(await call('teardown_competitor', { domain: 'northpeak.example' }));
    expect(t).toContain('is not in the Rivalize universe yet');
    expect(t).toContain('Rivalize dashboard');
  });

  it('companion: a failing competitor lookup degrades to the add-it message, not an error', async () => {
    const { call } = harness({
      getUniverseCompany: notFound,
      listCompetitors: vi.fn(async () => {
        throw new RivalizeApiError(500, 'boom', 'INTERNAL');
      }),
    });
    const res = await call('teardown_competitor', { domain: 'northpeak.example' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('is not in the Rivalize universe yet');
  });
});

describe('hints are chosen by error code', () => {
  const P = '11111111-1111-4111-8111-111111111111';
  const failWith = (code: string, message: string) =>
    vi.fn(async () => {
      throw new RivalizeApiError(404, message, code);
    });

  it('LANDSCAPE_WEEK_NOT_FOUND points at availableWeeks, not "verify the id"', async () => {
    const { call } = harness({
      getLandscapeMarkdown: failWith(
        'LANDSCAPE_WEEK_NOT_FOUND',
        'No stored position for that week.',
      ),
    });
    const t = text(await call('get_competitive_landscape', { project_id: P, week: '2026-09-21' }));
    expect(t).toContain('LANDSCAPE_WEEK_NOT_FOUND');
    expect(t).toContain('availableWeeks');
    expect(t).toMatch(/without week/i);
    expect(t).not.toContain('Verify the id/domain');
  });

  it('PROJECT_NOT_FOUND points at list_projects', async () => {
    const { call } = harness({
      getStrategicTimelineMarkdown: failWith('PROJECT_NOT_FOUND', 'Project not found.'),
    });
    const t = text(await call('get_strategic_timeline', { project_id: P }));
    expect(t).toContain('list_projects');
    expect(t).not.toContain('Verify the id/domain');
  });
});

describe('a whitespace-only domain is rejected before any call', () => {
  it('teardown and get_universe_company reject "   " without calling the API', async () => {
    const getUniverseCompany = vi.fn(async () => ({ data: { domain: 'x.co', name: 'X' } }));
    const { call } = harness({ getUniverseCompany });
    for (const tool of ['teardown_competitor', 'get_universe_company']) {
      const res = await call(tool, { domain: '   ' });
      expect(res.isError, tool).toBe(true);
      expect(text(res)).not.toContain('not in the Rivalize universe');
    }
    expect(getUniverseCompany).not.toHaveBeenCalled();
  });

  it('companion: surrounding whitespace is trimmed, not rejected', async () => {
    const getUniverseCompany = vi.fn(async () => ({
      data: { domain: 'linear.app', name: 'Linear' },
    }));
    const { call } = harness({ getUniverseCompany });
    await call('get_universe_company', { domain: '  linear.app ' });
    expect(getUniverseCompany).toHaveBeenCalledWith('linear.app');
  });
});

describe('the timeline lane filter reaches the API', () => {
  const P = '11111111-1111-4111-8111-111111111111';

  function capturingClient(body: string) {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new RivalizeClient(
      { apiKey: 'rk_live_lanes', apiUrl: 'https://api.example.test', allowWrites: false },
      fetchImpl,
    );
    return { client, urls };
  }

  it('markdown and json both send lanes as one comma list', async () => {
    const md = capturingClient('# Timeline');
    await harness(md.client as unknown as Record<string, unknown>).call('get_strategic_timeline', {
      project_id: P,
      lanes: ['pricing', 'funding'],
    });
    expect(md.urls).toHaveLength(1);
    expect(new URL(md.urls[0]).searchParams.get('lanes')).toBe('pricing,funding');
    expect(new URL(md.urls[0]).searchParams.get('format')).toBe('markdown');

    const json = capturingClient(JSON.stringify({ data: { lanes: [] } }));
    await harness(json.client as unknown as Record<string, unknown>).call(
      'get_strategic_timeline',
      { project_id: P, lanes: ['people'], format: 'json' },
    );
    expect(json.urls).toHaveLength(1);
    expect(new URL(json.urls[0]).searchParams.get('lanes')).toBe('people');
  });

  it('companion: no lanes argument sends no lanes parameter', async () => {
    const md = capturingClient('# Timeline');
    await harness(md.client as unknown as Record<string, unknown>).call('get_strategic_timeline', {
      project_id: P,
    });
    expect(md.urls).toHaveLength(1);
    expect(new URL(md.urls[0]).searchParams.has('lanes')).toBe(false);
  });

  it('a paged, lane-filtered timeline names the lanes in the next call', async () => {
    const md = timelineMarkdown();
    const { call } = harness({ getStrategicTimelineMarkdown: vi.fn(async () => md) });
    const first = text(await call('get_strategic_timeline', { project_id: P, lanes: ['product'] }));
    expect(first).toContain(
      `get_strategic_timeline {"project_id":"${P}","lanes":["product"],"page":2}`,
    );
  });
});
