/**
 * The report and project reads: `get_report` with `section`, `get_freshness`
 * and `get_evidence`, against a mocked client and a mocked fetch. No real API
 * call.
 *
 * The tool names and arguments are a public contract that clients code
 * against; `server.protocol.test.ts` pins them over the real MCP protocol.
 */
import { describe, expect, it, vi } from 'vitest';
import { RivalizeApiError, RivalizeClient } from './client.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function harness(client: Record<string, unknown>) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes for the SDK server and client
  registerTools(server as any, client as any);
  return (name: string) => {
    const h = tools.get(name);
    if (!h) throw new Error(`${name} is not registered`);
    return h;
  };
}

const PROJECT = '11111111-1111-4111-8111-111111111111';
const COMPETITOR = '33333333-3333-4333-8333-333333333333';
const WHOLE =
  '# Rivalize Competitive Intelligence Report\n\n## TL;DR\nThey lead.\n\n## Notion\n**Pricing:** Plus: $10';
const PRICING =
  '# Rivalize Competitive Intelligence Report\n\n> Section **pricing** (Pricing, per competitor) of this report.\n\n## Pricing, per competitor\n\n### Notion\n**Pricing:** Plus: $10\n\n### Jira\n**Pricing:** Standard: $8\n';

describe('get_report without section is unchanged', () => {
  it('asks for the whole report with exactly the old call, and returns its Markdown untouched', async () => {
    const getReportIntelligence = vi.fn(async () => ({
      data: { id: 'r-1', markdown: WHOLE, sections: [{ id: 'tldr', title: 'TL;DR' }] },
    }));
    const res = await harness({ getReportIntelligence })('get_report')({ report_id: 'r-1' });
    expect(getReportIntelligence).toHaveBeenCalledTimes(1);
    expect(getReportIntelligence.mock.calls[0]).toEqual(['r-1']);
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: WHOLE }]);
  });

  it('the client sends no section parameter', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":{"markdown":"x"}}', { status: 200 }));
    const client = new RivalizeClient(
      { apiKey: 'rk_live_x', apiUrl: 'https://api.example.test' },
      fetchImpl as unknown as typeof fetch,
    );
    await client.getReportIntelligence('r-1');
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      'https://api.example.test/api/v1/reports/r-1/intelligence',
    );
  });
});

describe('get_report with section', () => {
  it('asks the API for the section and returns it', async () => {
    const getReportIntelligence = vi.fn(async () => ({
      data: { id: 'r-1', section: 'pricing', markdown: PRICING },
    }));
    const res = await harness({ getReportIntelligence })('get_report')({
      report_id: 'r-1',
      section: 'pricing',
    });
    expect(getReportIntelligence.mock.calls[0]).toEqual(['r-1', 'pricing']);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe(PRICING);
  });

  it('the client encodes the section name', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":{"markdown":"x"}}', { status: 200 }));
    const client = new RivalizeClient(
      { apiKey: 'rk_live_x', apiUrl: 'https://api.example.test' },
      fetchImpl as unknown as typeof fetch,
    );
    await client.getReportIntelligence('r-1', 'key findings');
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      'https://api.example.test/api/v1/reports/r-1/intelligence?section=key+findings',
    );
  });

  it('section and competitor combine: that competitor’s part of the section', async () => {
    // Answers like the API: the section only when it is asked for.
    const getReportIntelligence = vi.fn(async (_id: string, section?: string) =>
      section === 'pricing'
        ? { data: { id: 'r-1', section: 'pricing', markdown: PRICING } }
        : { data: { id: 'r-1', markdown: `${WHOLE}\n\n## Jira\n**Pricing:** Standard: $8` } },
    );
    const res = await harness({ getReportIntelligence })('get_report')({
      report_id: 'r-1',
      section: 'pricing',
      competitor: 'Jira',
    });
    const text = res.content[0].text;
    expect(text).toContain('> Section **pricing**');
    expect(text).toContain('### Jira\n**Pricing:** Standard: $8');
    expect(text).not.toContain('Plus: $10');
  });

  it('an unknown section is an error that names the valid sections and how to retry', async () => {
    // Answers like the API: the 400 only when a section is asked for.
    const getReportIntelligence = vi.fn(async (_id: string, section?: string) => {
      if (section === undefined) return { data: { id: 'r-1', markdown: WHOLE } };
      throw new RivalizeApiError(
        400,
        `Unknown section "${section}". Sections in this report: tldr, pricing, battlecards.`,
        'UNKNOWN_SECTION',
      );
    });
    const res = await harness({ getReportIntelligence })('get_report')({
      report_id: 'r-1',
      section: 'positioning',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      'Error (400 UNKNOWN_SECTION): Unknown section "positioning". Sections in this report: tldr, pricing, battlecards. Retry get_report with one of those sections, or without section for the whole report.',
    );
  });

  it('a server that ignores section is never passed off as the section', async () => {
    const getReportIntelligence = vi.fn(async () => ({ data: { id: 'r-1', markdown: WHOLE } }));
    const res = await harness({ getReportIntelligence })('get_report')({
      report_id: 'r-1',
      section: 'pricing',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('does not serve report sections yet');
    expect(res.content[0].text).not.toContain('They lead.');
  });

  it('a long section pages with a next call that keeps the section', async () => {
    const long = `# T\n\n## Pricing, per competitor\n\n${Array.from(
      { length: 60 },
      (_, i) => `### Co ${i}\n**Pricing:** ${'x'.repeat(600)}`,
    ).join('\n\n')}\n`;
    const getReportIntelligence = vi.fn(async () => ({
      data: { id: 'r-1', section: 'pricing', markdown: long },
    }));
    const text = (
      await harness({ getReportIntelligence })('get_report')({
        report_id: 'r-1',
        section: 'pricing',
      })
    ).content[0].text;
    expect(text).toContain('get_report {"report_id":"r-1","section":"pricing","page":2}');
    expect(text).toContain('of this report section "pricing"');
  });
});

describe('get_freshness', () => {
  it('reads the project freshness and returns it as JSON', async () => {
    const payload = {
      data: {
        project_id: PROJECT,
        latest_report: null,
        competitors: [
          {
            competitor_id: COMPETITOR,
            status: 'never_observed',
            last_observed_at: null,
            last_observed_by: null,
          },
        ],
      },
    };
    const getProjectFreshness = vi.fn(async () => payload);
    const res = await harness({ getProjectFreshness })('get_freshness')({ project_id: PROJECT });
    expect(getProjectFreshness.mock.calls[0]).toEqual([PROJECT]);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual(payload);
  });

  it('the client reads GET /v1/projects/:id/freshness', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":{}}', { status: 200 }));
    await new RivalizeClient(
      { apiKey: 'rk_live_x', apiUrl: 'https://api.example.test' },
      fetchImpl as unknown as typeof fetch,
    ).getProjectFreshness(PROJECT);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      `https://api.example.test/api/v1/projects/${PROJECT}/freshness`,
    );
  });

  it('a project not in the account says how to find one', async () => {
    const getProjectFreshness = vi.fn(async () => {
      throw new RivalizeApiError(404, 'Project not found.', 'PROJECT_NOT_FOUND');
    });
    const res = await harness({ getProjectFreshness })('get_freshness')({ project_id: PROJECT });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Call list_projects');
  });
});

describe('get_evidence', () => {
  it('the home product: no competitor id is sent', async () => {
    const getEvidence = vi.fn(async () => ({
      data: { subject: { kind: 'product' }, sources: [] },
    }));
    await harness({ getEvidence })('get_evidence')({ project_id: PROJECT });
    expect(getEvidence.mock.calls[0]).toEqual([PROJECT, undefined]);
  });

  it('a competitor: its id is sent, and the client puts it on the query', async () => {
    const getEvidence = vi.fn(async () => ({ data: { subject: { kind: 'competitor' } } }));
    await harness({ getEvidence })('get_evidence')({
      project_id: PROJECT,
      competitor_id: COMPETITOR,
    });
    expect(getEvidence.mock.calls[0]).toEqual([PROJECT, COMPETITOR]);

    const fetchImpl = vi.fn(async () => new Response('{"data":{}}', { status: 200 }));
    const client = new RivalizeClient(
      { apiKey: 'rk_live_x', apiUrl: 'https://api.example.test' },
      fetchImpl as unknown as typeof fetch,
    );
    await client.getEvidence(PROJECT, COMPETITOR);
    await client.getEvidence(PROJECT);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      `https://api.example.test/api/v1/projects/${PROJECT}/evidence?competitor_id=${COMPETITOR}`,
    );
    expect((fetchImpl.mock.calls[1] as unknown[])[0]).toBe(
      `https://api.example.test/api/v1/projects/${PROJECT}/evidence`,
    );
  });

  it('a competitor that is not in the account is a 404 that points at list_competitors', async () => {
    const getEvidence = vi.fn(async () => {
      throw new RivalizeApiError(404, 'Competitor not found.', 'COMPETITOR_NOT_FOUND');
    });
    const res = await harness({ getEvidence })('get_evidence')({
      project_id: PROJECT,
      competitor_id: COMPETITOR,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      'Error (404 COMPETITOR_NOT_FOUND): Competitor not found. Call list_competitors for the ids of the competitors in your account.',
    );
  });
});
