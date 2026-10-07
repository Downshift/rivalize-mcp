/**
 * RivalizeClient tests.
 *
 * `fetch` is mocked entirely: no real REST calls.
 * Verifies auth header forwarding, URL/query construction, the standard
 * `{ data }` envelope passthrough, and error-envelope → RivalizeApiError mapping.
 */

import { describe, expect, it, vi } from 'vitest';
import { RivalizeApiError, RivalizeClient } from './client.js';

const CONFIG = { apiKey: 'rk_live_test123', apiUrl: 'https://example.test' };

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('RivalizeClient', () => {
  it('forwards the Bearer API key and builds the universe list URL with query', async () => {
    const fetchImpl = mockFetch(200, { data: [], pagination: {}, filters: {} });
    const client = new RivalizeClient(CONFIG, fetchImpl);

    await client.listUniverseCompanies({ q: 'linear', layer: 'pricing', limit: 10 });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe(
      'https://example.test/api/v1/universe/companies?q=linear&layer=pricing&limit=10',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rk_live_test123');
  });

  it('encodes the domain in the universe detail path', async () => {
    const fetchImpl = mockFetch(200, { data: { domain: 'notion.so' } });
    const client = new RivalizeClient(CONFIG, fetchImpl);

    await client.getUniverseCompany('https://www.notion.so/product');

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(
      'https://example.test/api/v1/universe/companies/https%3A%2F%2Fwww.notion.so%2Fproduct',
    );
  });

  it('POSTs add_competitor with a urls body', async () => {
    const fetchImpl = mockFetch(202, { data: { job_id: 'j-1', competitors_added: 1 } });
    const client = new RivalizeClient(CONFIG, fetchImpl);

    const res = await client.addCompetitor('p-1', ['https://x.com']);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://example.test/api/v1/projects/p-1/competitors');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ urls: ['https://x.com'] });
    expect((res as { data: { job_id: string } }).data.job_id).toBe('j-1');
  });

  it('maps a REST error envelope to RivalizeApiError with status + code', async () => {
    const fetchImpl = mockFetch(403, {
      error: {
        code: 'PLAN_REQUIRED',
        message: 'Webhook access requires the Starter plan or higher',
      },
    });
    const client = new RivalizeClient(CONFIG, fetchImpl);

    await expect(client.listUniverseCompanies()).rejects.toMatchObject({
      name: 'RivalizeApiError',
      status: 403,
      code: 'PLAN_REQUIRED',
    });
  });

  it('wraps a fetch/network failure as a NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new RivalizeClient(CONFIG, fetchImpl);

    const err = await client.listCompetitors().catch((e) => e);
    expect(err).toBeInstanceOf(RivalizeApiError);
    expect((err as RivalizeApiError).code).toBe('NETWORK_ERROR');
  });
});

describe('Markdown formats come back as text, on the format=markdown URL', () => {
  it('timeline and landscape request format=markdown and return the raw body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('# Strategic timeline\n- a move', { status: 200 }),
    );
    const client = new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch);
    const md = await client.getStrategicTimelineMarkdown('p-1', 30, 'c-1');
    expect(md).toBe('# Strategic timeline\n- a move');
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toBe(
      'https://example.test/api/v1/projects/p-1/timeline?days=30&competitorId=c-1&format=markdown',
    );
    await client.getLandscapeMarkdown('p-1', '2026-09-14');
    expect(String((fetchImpl.mock.calls[1] as unknown[])[0])).toBe(
      'https://example.test/api/v1/projects/p-1/landscape?week=2026-09-14&format=markdown',
    );
  });

  it('a Markdown request still throws the API error on failure', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'PLAN_REQUIRED', message: 'Pro required' } }),
          { status: 402 },
        ),
    );
    const client = new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch);
    await expect(client.getStrategicTimelineMarkdown('p-1', 90)).rejects.toMatchObject({
      status: 402,
      message: 'Pro required',
    });
  });
});
