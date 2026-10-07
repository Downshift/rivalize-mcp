/**
 * MCP tool-handler tests.
 *
 * Drives the registered tool handlers directly against a MOCK RivalizeClient:
 * no real REST calls, no metered add_competitor or enrichment enqueue (report
 * generation and competitor scraping are always mocked in tests).
 *
 * Covers: tool registration, read shaping, the add_competitor write wrapper
 * returning a job_id, and clean error surfacing (mapping from REST status to
 * an agent-readable error).
 */

import { describe, expect, it, vi } from 'vitest';
import { RivalizeApiError } from './client.js';
import { READ_TOOL_NAMES, registerTools, TOOL_NAMES, WRITE_TOOL_NAMES } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

interface RegisteredTool {
  config: { annotations?: Record<string, boolean> };
  handler: Handler;
}

/** Minimal fake McpServer that records registerTool calls. */
function makeFakeServer() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: RegisteredTool['config'], handler: Handler) {
      tools.set(name, { config, handler });
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fake for the SDK server
  return { server: server as any, tools };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    listUniverseCompanies: vi.fn(async () => ({
      data: [{ domain: 'linear.app', name: 'Linear' }],
      pagination: { total: 1, limit: 50, offset: 0 },
      filters: { q: null, category: null, layer: null },
    })),
    getUniverseCompany: vi.fn(async () => ({ data: { domain: 'linear.app', name: 'Linear' } })),
    listCompetitors: vi.fn(async () => ({ data: [{ id: 'c-1', name: 'Rival Co' }] })),
    getCompetitorIntelligence: vi.fn(async () => ({
      data: { competitor_name: 'Rival Co', momentum_score: 42, intelligence: {} },
    })),
    addCompetitor: vi.fn(async () => ({
      data: { competitors_added: 1, competitors_skipped: 0, job_id: 'job-123', message: 'queued' },
    })),
    getStrategicTimeline: vi.fn(async () => ({ data: { lanes: [], moves: [], events: [] } })),
    getLandscape: vi.fn(async () => ({ data: { positions: [], availableWeeks: [] } })),
    getStrategicTimelineMarkdown: vi.fn(
      async () => '# Strategic timeline\n\n- Pricing: cut Plus to $8',
    ),
    getLandscapeMarkdown: vi.fn(async () => '# Competitive landscape\n\n- Arcads: rising'),
    listProjects: vi.fn(async () => ({
      data: [{ id: 'p-1', name: 'My Product', competitor_count: 3 }],
    })),
    listReports: vi.fn(async () => ({
      data: [{ id: 'r-1', product_name: 'My Product', status: 'completed' }],
      pagination: { total: 1, limit: 20, offset: 0 },
    })),
    getReportIntelligence: vi.fn(async () => ({
      data: {
        id: 'r-1',
        markdown: '# Rivalize Competitive Intelligence Report\n\n## TL;DR\nThey lead.',
      },
    })),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: structural fake for the client
  } as any;
}

describe('registerTools', () => {
  it('by default registers exactly the read tools — add_competitor is absent', () => {
    const { server, tools } = makeFakeServer();
    registerTools(server, makeClient());
    expect([...tools.keys()].sort()).toEqual([...READ_TOOL_NAMES].sort());
    expect(tools.size).toBe(13);
    expect(tools.has('add_competitor')).toBe(false);
    // The new discovery + report tools are named, not just counted.
    expect(tools.has('list_projects')).toBe(true);
    expect(tools.has('list_reports')).toBe(true);
    expect(tools.has('get_report')).toBe(true);
  });

  it('allowWrites registers the read tools plus add_competitor', () => {
    const { server, tools } = makeFakeServer();
    registerTools(server, makeClient(), { allowWrites: true });
    expect([...tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES.length).toBe(READ_TOOL_NAMES.length + WRITE_TOOL_NAMES.length);
    expect(tools.has('add_competitor')).toBe(true);
  });

  it('every read tool is registered by name', () => {
    const { server, tools } = makeFakeServer();
    registerTools(server, makeClient());
    for (const name of READ_TOOL_NAMES) {
      expect(tools.has(name)).toBe(true);
    }
    // The timeline and landscape tools were added side by side. Name both
    // explicitly: a count check alone stays green if a change drops one tool
    // and its TOOL_NAMES entry together.
    expect(tools.has('get_strategic_timeline')).toBe(true);
    expect(tools.has('get_competitive_landscape')).toBe(true);
  });

  it('marks read tools readOnly and add_competitor as a write', () => {
    const { server, tools } = makeFakeServer();
    registerTools(server, makeClient(), { allowWrites: true });
    for (const name of READ_TOOL_NAMES) {
      expect(tools.get(name)?.config.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(tools.get('list_universe_companies')?.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('get_competitor_intelligence')?.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('add_competitor')?.config.annotations?.readOnlyHint).toBe(false);
  });

  it('list_universe_companies returns real universe data through the tool', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);

    const res = await tools.get('list_universe_companies')!.handler({ q: 'linear' });

    expect(client.listUniverseCompanies).toHaveBeenCalledWith({ q: 'linear' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.data).toBeDefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.data[0].domain).toBe('linear.app');
  });

  it('get_universe_company forwards the domain and shapes the result', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);

    const res = await tools.get('get_universe_company')!.handler({ domain: 'linear.app' });

    expect(client.getUniverseCompany).toHaveBeenCalledWith('linear.app');
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.data.name).toBe('Linear');
  });

  it('list_competitors passes an optional project_id filter', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);

    await tools.get('list_competitors')!.handler({ project_id: 'p-1' });
    expect(client.listCompetitors).toHaveBeenCalledWith({
      projectId: 'p-1',
      limit: undefined,
      offset: undefined,
    });
  });

  it('get_strategic_timeline returns the compact agent Markdown by default', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);
    const res = await tools.get('get_strategic_timeline')!.handler({
      project_id: 'p-1',
      days: '30',
      competitor_id: 'c-1',
    });
    expect(client.getStrategicTimelineMarkdown).toHaveBeenCalledWith('p-1', 30, 'c-1', undefined);
    expect(client.getStrategicTimeline).not.toHaveBeenCalled();
    expect(res.content[0].text.startsWith('# Strategic timeline')).toBe(true);
  });

  it('get_strategic_timeline returns the JSON when asked, defaulting to 90 days', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);
    const res = await tools
      .get('get_strategic_timeline')!
      .handler({ project_id: 'p-1', format: 'json' });
    expect(client.getStrategicTimeline).toHaveBeenCalledWith('p-1', 90, undefined, undefined);
    expect(client.getStrategicTimelineMarkdown).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text).data.lanes).toEqual([]);
  });

  it('get_competitive_landscape returns Markdown by default and JSON when asked', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);
    const md = await tools.get('get_competitive_landscape')!.handler({ project_id: 'p-1' });
    expect(client.getLandscapeMarkdown).toHaveBeenCalledWith('p-1', undefined);
    expect(md.content[0].text.startsWith('# Competitive landscape')).toBe(true);
    const json = await tools
      .get('get_competitive_landscape')!
      .handler({ project_id: 'p-1', format: 'json' });
    expect(client.getLandscape).toHaveBeenCalledWith('p-1', undefined);
    expect(JSON.parse(json.content[0].text).data.positions).toEqual([]);
  });

  it('list_projects calls the projects endpoint and returns its JSON', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);
    const res = await tools.get('list_projects')!.handler({});
    expect(client.listProjects).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).data[0].id).toBe('p-1');
  });

  it('list_reports maps snake_case args to the client', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);
    const res = await tools
      .get('list_reports')!
      .handler({ project_id: 'p-1', limit: 5, offset: 10 });
    expect(client.listReports).toHaveBeenCalledWith({ projectId: 'p-1', limit: 5, offset: 10 });
    expect(JSON.parse(res.content[0].text).pagination.total).toBe(1);
  });

  it('get_report returns the report Markdown as text, not a JSON wrapper', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client);
    const res = await tools.get('get_report')!.handler({ report_id: 'r-1' });
    expect(client.getReportIntelligence).toHaveBeenCalledWith('r-1');
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.startsWith('# Rivalize Competitive Intelligence Report')).toBe(true);
    expect(res.content[0].text).toContain('They lead.');
  });

  it('get_report bounds an oversized report, says how much is left and how to get it', async () => {
    const { server, tools } = makeFakeServer();
    const huge = `# Report\n${'x'.repeat(40_000)}`;
    const client = makeClient({
      getReportIntelligence: vi.fn(async () => ({ data: { markdown: huge } })),
    });
    registerTools(server, client);
    const text = (await tools.get('get_report')!.handler({ report_id: 'r-1' })).content[0].text;
    expect(text.length).toBeLessThanOrEqual(25_000);
    expect(text.startsWith('> **Page 1 of 2**')).toBe(true);
    expect(text).toContain('# Report');
    expect(text).toMatch(/[\d,]+ characters remain on page 2/);
    expect(text).toContain('get_report {"report_id":"r-1","page":2}');
  });

  it('get_report flags a response with no Markdown as an error rather than returning nothing', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient({
      getReportIntelligence: vi.fn(async () => ({ data: { id: 'r-1' } })),
    });
    registerTools(server, client);
    const res = await tools.get('get_report')!.handler({ report_id: 'r-1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('no readable content');
  });

  it('add_competitor write tool returns a non-null job_id (enrichment is enqueued server-side, mocked here)', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient();
    registerTools(server, client, { allowWrites: true });

    const res = await tools.get('add_competitor')!.handler({
      project_id: '11111111-1111-1111-1111-111111111111',
      urls: ['https://newrival.com'],
    });

    expect(client.addCompetitor).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', [
      'https://newrival.com',
    ]);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.data.job_id).toBe('job-123');
    expect(parsed.data.competitors_added).toBe(1);
  });

  it('a 403 plan-gate error from REST surfaces as a clear, actionable tool error', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient({
      listUniverseCompanies: vi.fn(async () => {
        // Reads are free on every plan: a 403 only happens on paid-only
        // capabilities (webhooks, report triggers). The hint must point at
        // the upgrade path, not claim API access itself needs Pro/Agency.
        throw new RivalizeApiError(
          403,
          'Webhooks require the Starter plan or higher',
          'PLAN_REQUIRED',
        );
      }),
    });
    registerTools(server, client);

    const res = await tools.get('list_universe_companies')!.handler({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('403');
    expect(res.content[0].text).toContain('free API keys include rate-limited reads');
    expect(res.content[0].text).toContain('rivalize.ai/pricing');
  });

  it('a 404 (tenant-isolation) error surfaces cleanly, not as raw data', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient({
      getCompetitorIntelligence: vi.fn(async () => {
        throw new RivalizeApiError(404, 'Competitor not found', 'NOT_FOUND');
      }),
    });
    registerTools(server, client);

    const res = await tools.get('get_competitor_intelligence')!.handler({
      competitor_id: '22222222-2222-2222-2222-222222222222',
    });
    expect(res.isError).toBe(true);
    // The coded 404 that names the list_ call returning valid ids.
    expect(res.content[0].text).toContain('Error (404 COMPETITOR_NOT_FOUND)');
    expect(res.content[0].text).toContain('Call list_competitors');
    expect(res.content[0].text).toContain('your account');
  });

  it('a network failure surfaces a reachability error', async () => {
    const { server, tools } = makeFakeServer();
    const client = makeClient({
      listCompetitors: vi.fn(async () => {
        throw new RivalizeApiError(0, 'Could not reach the Rivalize API', 'NETWORK_ERROR');
      }),
    });
    registerTools(server, client);

    const res = await tools.get('list_competitors')!.handler({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('reach the Rivalize API');
  });
});
