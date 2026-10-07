/**
 * Tool error-surface + payload-guard tests. Handler-level, mock
 * RivalizeClient: no real REST, no metered work.
 *
 * The 25K context-flood guard reduces non-array payloads, shrinks arrays until
 * they fit, and bounds structuredContent; the three oversized-payload specs
 * lock that in.
 */

import { describe, expect, it, vi } from 'vitest';
import { RivalizeApiError } from './client.js';
import { registerTools } from './tools.js';

const API_KEY = 'rk_live_errors_suite_secret';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function harness(clientOverrides: Record<string, unknown> = {}, allowWrites = false) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
    },
  };
  const client = {
    listUniverseCompanies: vi.fn(async () => ({
      data: [],
      pagination: { total: 0, limit: 50, offset: 0 },
      filters: {},
    })),
    getUniverseCompany: vi.fn(async () => ({ data: { domain: 'x.co', name: 'X' } })),
    listCompetitors: vi.fn(async () => ({ data: [] })),
    getCompetitorIntelligence: vi.fn(async () => ({ data: {} })),
    addCompetitor: vi.fn(async () => ({ data: { job_id: 'j-1' } })),
    ...clientOverrides,
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes
  registerTools(server as any, client as any, { allowWrites });
  return { tools, client };
}

const UUID = '11111111-1111-1111-1111-111111111111';

describe('empty-data behavior', () => {
  it('empty universe → clean non-error result with an empty list', async () => {
    const { tools } = harness();
    const res = await tools.get('list_universe_companies')!({});
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.data).toEqual([]);
    expect(parsed.pagination.total).toBe(0);
  });

  it('empty competitor list → clean non-error result', async () => {
    const { tools } = harness();
    const res = await tools.get('list_competitors')!({});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).data).toEqual([]);
  });

  it('teardown for a null profile, read-only → points at the dashboard, never at a tool it lacks', async () => {
    const { tools } = harness({ getUniverseCompany: vi.fn(async () => ({ data: null })) });
    expect(tools.has('add_competitor')).toBe(false);
    const res = await tools.get('teardown_competitor')!({ domain: 'unknown.io' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('No universe profile for "unknown.io"');
    expect(res.content[0].text).toContain('Rivalize dashboard');
    expect(res.content[0].text).not.toContain('add_competitor');
    expect(res.content[0].text).not.toContain('# Competitor Teardown');
  });

  it('teardown for a null profile, writes enabled → add_competitor suggestion', async () => {
    const { tools } = harness({ getUniverseCompany: vi.fn(async () => ({ data: null })) }, true);
    const res = await tools.get('teardown_competitor')!({ domain: 'unknown.io' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('add_competitor');
    expect(res.content[0].text).not.toContain('# Competitor Teardown');
  });

  it('a never-enriched profile through the teardown tool follows the write setting', async () => {
    const ghost = {
      getUniverseCompany: vi.fn(async () => ({ data: { domain: 'ghost.co', name: 'Ghost' } })),
    };
    const readOnly = (
      await harness(ghost).tools.get('teardown_competitor')!({ domain: 'ghost.co' })
    ).content[0].text;
    expect(readOnly).toContain('Not yet enriched');
    expect(readOnly).not.toContain('add_competitor');
    const writes = (
      await harness(ghost, true).tools.get('teardown_competitor')!({ domain: 'ghost.co' })
    ).content[0].text;
    expect(writes).toContain('Not yet enriched');
    expect(writes).toContain('Use add_competitor');
  });

  it('no read-only error or hint names add_competitor', async () => {
    const { tools } = harness({
      listCompetitors: vi.fn(async () => {
        throw new RivalizeApiError(403, 'Plan required', 'PLAN_REQUIRED');
      }),
    });
    const res = await tools.get('list_competitors')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('higher plan');
    expect(res.content[0].text).not.toContain('add_competitor');
  });

  it('teardown for a domain not in the universe → says so, says how to add it, fabricates nothing', async () => {
    const { tools } = harness({
      getUniverseCompany: vi.fn(async () => {
        throw new RivalizeApiError(404, 'Universe company not found', 'NOT_FOUND');
      }),
    });
    const res = await tools.get('teardown_competitor')!({ domain: 'gone.io' });
    const text = res.content[0].text;
    expect(text).toContain('"gone.io" is not in the Rivalize universe yet');
    expect(text).toContain('Rivalize dashboard');
    // The universe is shared — "another account" was the account-scoped hint, and wrong here.
    expect(text).not.toContain('another account');
    expect(text).not.toContain('# Competitor Teardown');
  });

  it('a non-404 failure on the teardown still surfaces as an error', async () => {
    const { tools } = harness({
      getUniverseCompany: vi.fn(async () => {
        throw new RivalizeApiError(500, 'boom', 'INTERNAL');
      }),
    });
    const res = await tools.get('teardown_competitor')!({ domain: 'gone.io' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('500');
  });
});

describe('error-status surfacing (per REST status class)', () => {
  it('401: invalid/revoked key → check-your-key hint, exactly one client call (no retry storm)', async () => {
    const failing = vi.fn(async () => {
      throw new RivalizeApiError(401, 'Invalid API key', 'UNAUTHORIZED');
    });
    const { tools } = harness({ listUniverseCompanies: failing });
    const res = await tools.get('list_universe_companies')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('401');
    expect(res.content[0].text).toContain('RIVALIZE_API_KEY');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('get_universe_company 404 → not-in-universe answer, not the account-scoped hint', async () => {
    const { tools } = harness({
      getUniverseCompany: vi.fn(async () => {
        throw new RivalizeApiError(404, 'Universe company not found', 'NOT_FOUND');
      }),
    });
    const res = await tools.get('get_universe_company')!({ domain: 'nope.io' });
    expect(res.content[0].text).toContain('"nope.io" is not in the Rivalize universe yet');
    expect(res.content[0].text).not.toContain('another account');
  });

  it('companion: an account-scoped 404 names its code and the list_ call', async () => {
    const { tools } = harness({
      getCompetitorIntelligence: vi.fn(async () => {
        throw new RivalizeApiError(404, 'Competitor not found', 'NOT_FOUND');
      }),
    });
    const res = await tools.get('get_competitor_intelligence')!({
      competitor_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Error (404 COMPETITOR_NOT_FOUND)');
    expect(res.content[0].text).toContain('Call list_competitors');
    expect(res.content[0].text).not.toContain('Verify the id/domain');
  });

  it('429 → wait-before-retrying guidance with the API message intact', async () => {
    const { tools } = harness({
      listCompetitors: vi.fn(async () => {
        throw new RivalizeApiError(
          429,
          'Rate limit exceeded: 100 requests/hour on the free plan',
          'RATE_LIMITED',
        );
      }),
    });
    const res = await tools.get('list_competitors')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('429');
    expect(res.content[0].text).toContain('100 requests/hour');
    expect(res.content[0].text).toContain('wait before retrying');
  });

  it('add_competitor 429 daily cap message passes through verbatim', async () => {
    const { tools } = harness(
      {
        addCompetitor: vi.fn(async () => {
          throw new RivalizeApiError(
            429,
            'Free plan is limited to 10 add_competitor calls per day',
            'RATE_LIMITED',
          );
        }),
      },
      true,
    );
    const res = await tools.get('add_competitor')!({ project_id: UUID, urls: ['https://r.co'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('10 add_competitor calls per day');
  });

  it('add_competitor 402 out-of-credits surfaces with status + message', async () => {
    const { tools } = harness(
      {
        addCompetitor: vi.fn(async () => {
          throw new RivalizeApiError(402, 'Insufficient credits', 'INSUFFICIENT_CREDITS');
        }),
      },
      true,
    );
    const res = await tools.get('add_competitor')!({ project_id: UUID, urls: ['https://r.co'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('402');
    expect(res.content[0].text).toContain('Insufficient credits');
  });

  it('add_competitor 409 plan competitor-limit surfaces with status + message', async () => {
    const { tools } = harness(
      {
        addCompetitor: vi.fn(async () => {
          throw new RivalizeApiError(
            409,
            'Adding these competitors would exceed your plan limit (1)',
            'LIMIT_EXCEEDED',
          );
        }),
      },
      true,
    );
    const res = await tools.get('add_competitor')!({ project_id: UUID, urls: ['https://r.co'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('409');
    expect(res.content[0].text).toContain('plan limit');
  });

  it('403 PLAN_REQUIRED names what free includes + the pricing URL (never "API needs Pro")', async () => {
    const { tools } = harness({
      getCompetitorIntelligence: vi.fn(async () => {
        throw new RivalizeApiError(403, 'This requires the Starter plan', 'PLAN_REQUIRED');
      }),
    });
    const res = await tools.get('get_competitor_intelligence')!({ competitor_id: UUID });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('free API keys include rate-limited reads');
    expect(res.content[0].text).toContain('rivalize.ai/pricing');
    expect(res.content[0].text).not.toMatch(/requires a Pro or Agency plan/i);
  });
});

describe('secret non-leakage across every error class', () => {
  it('the API key never appears in any tool output for statuses 0/401/403/404/429/500', async () => {
    for (const [status, code] of [
      [0, 'NETWORK_ERROR'],
      [401, 'UNAUTHORIZED'],
      [403, 'PLAN_REQUIRED'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [500, 'INTERNAL'],
    ] as const) {
      const { tools } = harness({
        listUniverseCompanies: vi.fn(async () => {
          throw new RivalizeApiError(status, `synthetic ${code}`, code);
        }),
      });
      const res = await tools.get('list_universe_companies')!({});
      // The full key must never leak. (The literal prefix "rk_live_" IS allowed
      // to appear — the 401 hint legitimately names the expected key format.)
      expect(JSON.stringify(res), `status ${status}`).not.toContain(API_KEY);
    }
  });
});

describe('context-flood guard (25K CHARACTER_LIMIT)', () => {
  it('under-limit payloads pass through untouched (no regression), compactly serialized', async () => {
    const payload = { data: { domain: 'x.co', blob: 'y'.repeat(1000) } };
    const { tools } = harness({ getUniverseCompany: vi.fn(async () => payload) });
    const res = await tools.get('get_universe_company')!({ domain: 'x.co' });
    expect(res.content[0].text).toBe(JSON.stringify(payload));
    expect(JSON.parse(res.content[0].text)._truncated).toBeUndefined();
  });

  it('oversized ARRAY payloads get flagged and reduced, with the resume offset stated', async () => {
    // list_reports rows are not slimmed (universe rows are), so the generic
    // list path is what this exercises.
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, blob: 'z'.repeat(400) }));
    const { tools } = harness({
      listReports: vi.fn(async () => ({
        data: rows,
        pagination: { total: 100, limit: 100, offset: 0 },
      })),
    });
    const res = await tools.get('list_reports')!({});
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed._truncated).toBe(true);
    expect(parsed.data.length).toBeLessThan(100);
    expect(parsed.pagination.next_offset).toBe(parsed.data.length);
    expect(parsed.pagination.limit).toBe(parsed.data.length);
  });

  // ── Oversized payloads ─────────────────────────────────────────────────
  // A single huge object, arrays that one halving cannot fit, and
  // structuredContent must all land under the limit. These three specs lock
  // that in.
  it('a 60KB single-object payload is actually reduced below the limit', async () => {
    const { tools } = harness({
      getUniverseCompany: vi.fn(async () => ({
        data: { domain: 'x.co', blob: 'x'.repeat(60_000) },
      })),
    });
    const res = await tools.get('get_universe_company')!({ domain: 'x.co' });
    // Desired: whenever the guard fires, the text really is bounded
    // (allow modest overhead for the truncation notice).
    expect(res.content[0].text.length).toBeLessThanOrEqual(26_000);
  });

  it('arrays where one halving is insufficient still land under the limit', async () => {
    const rows = [{ blob: 'a'.repeat(30_000) }, { blob: 'b'.repeat(30_000) }];
    const { tools } = harness({
      listUniverseCompanies: vi.fn(async () => ({
        data: rows,
        pagination: { total: 2, limit: 50, offset: 0 },
        filters: {},
      })),
    });
    const res = await tools.get('list_universe_companies')!({});
    expect(res.content[0].text.length).toBeLessThanOrEqual(26_000);
  });

  it('structuredContent must not smuggle the full oversized payload past the guard', async () => {
    const { tools } = harness({
      getUniverseCompany: vi.fn(async () => ({
        data: { domain: 'x.co', blob: 'x'.repeat(60_000) },
      })),
    });
    const res = await tools.get('get_universe_company')!({ domain: 'x.co' });
    const structuredSize = JSON.stringify(res.structuredContent ?? {}).length;
    expect(structuredSize).toBeLessThanOrEqual(26_000);
  });
});

describe('teardown links follow the configured API origin', () => {
  function teardownWith(opts: Record<string, unknown>) {
    const tools = new Map<string, Handler>();
    const server = {
      registerTool(name: string, _config: unknown, handler: Handler) {
        tools.set(name, handler);
      },
    };
    const client = {
      getUniverseCompany: vi.fn(async () => ({ data: { domain: 'x.co', name: 'X' } })),
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural fakes
    registerTools(server as any, client as any, opts as any);
    return tools.get('teardown_competitor')!({ domain: 'x.co' });
  }

  it('a self-hosted origin is used for every link, and rivalize.ai never appears', async () => {
    const res = await teardownWith({ origin: 'https://self-hosted.rivalize.example' });
    const text = res.content[0].text;
    expect(text).toContain('https://self-hosted.rivalize.example/api/v1/universe/companies/x.co');
    expect(text).not.toContain('https://rivalize.ai/');
  });

  it('companion: with no origin the links default to https://rivalize.ai', async () => {
    const res = await teardownWith({});
    expect(res.content[0].text).toContain('https://rivalize.ai/api/v1/universe/companies/x.co');
  });
});

describe('API error text is not doubled', () => {
  it('a 403 whose message already names the upgrade gets no second hint and no ".."', async () => {
    const { tools } = harness({
      getBattlecard: vi.fn(async () => {
        throw new RivalizeApiError(
          403,
          'Sales battlecards requires the Pro plan or higher. Your plan: free. Upgrade at https://rivalize.ai/pricing for sales battlecards.',
          'PLAN_REQUIRED',
        );
      }),
    });
    const res = await tools.get('get_battlecard')!({ competitor_id: UUID });
    const text = res.content[0].text;
    expect(res.isError).toBe(true);
    expect(text).toContain('requires the Pro plan');
    expect(text).not.toContain('..');
    expect(text.match(/rivalize\.ai\/pricing/g)?.length).toBe(1);
  });

  // The API's timeline 402 (its TIMELINE_UPGRADE_MESSAGES) names the read a lower plan
  // CAN make, so the agent retries instead of giving up. It must arrive whole:
  // one closing period, no generic plan hint appended.
  it.each([
    [
      'HISTORY_REQUIRES_PRO',
      'Full history (90 or 180 days) requires Pro. Your plan can read the last 30 days for one competitor: days=30 with competitorId.',
    ],
    [
      'ALL_COMPETITORS_REQUIRES_PRO',
      'Every competitor at once requires Pro. Your plan can read one competitor at a time: pass competitorId (days=30).',
    ],
  ])('the timeline 402 %s reaches the agent whole, naming the allowed retry', async (code, message) => {
    const { tools } = harness({
      getStrategicTimelineMarkdown: vi.fn(async () => {
        throw new RivalizeApiError(402, message, code);
      }),
    });
    const res = await tools.get('get_strategic_timeline')!({ project_id: UUID });
    const text = res.content[0].text;
    expect(res.isError).toBe(true);
    expect(text).toBe(`Error (402 ${code}): ${message}`);
    expect(text).toContain('competitorId');
    expect(text).toContain('days=30');
    expect(text).not.toContain('..');
    expect(text).not.toContain('higher plan');
  });
});
