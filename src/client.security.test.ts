/**
 * RivalizeClient security + resilience tests. fetch is fully mocked.
 *
 * The SSRF line: user-supplied domains/ids are attacker-controlled
 * (any MCP prompt can smuggle one) — they must never change the request host
 * or traverse the path of the configured API origin.
 */

import { describe, expect, it, vi } from 'vitest';
import { RivalizeApiError, RivalizeClient } from './client.js';

const API_KEY = 'rk_live_security_suite_secret';
const CONFIG = { apiKey: API_KEY, apiUrl: 'https://api.rivalize.example' };

function capturingFetch(status = 200, body: unknown = { data: {} }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('no SSRF via user-supplied identifiers', () => {
  const hostileInputs = [
    'https://evil.com/steal',
    '../../admin/keys',
    'localhost:6379',
    'evil.com@rivalize.ai',
    'notion.so#@internal',
    'notion.so?admin=true',
  ];

  it('getUniverseCompany: hostile domains stay percent-encoded path segments on the configured origin', async () => {
    for (const hostile of hostileInputs) {
      const { impl, calls } = capturingFetch();
      const client = new RivalizeClient(CONFIG, impl);
      await client.getUniverseCompany(hostile);
      const url = new URL(calls[0].url);
      expect(url.origin, hostile).toBe('https://api.rivalize.example');
      expect(url.pathname.startsWith('/api/v1/universe/companies/'), hostile).toBe(true);
      // No traversal survived encoding: the segment contains no RAW slash, so
      // `..%2F..` is one opaque segment — it cannot climb the path. (Literal
      // dots are legal inside a segment; the raw '/' is what enables traversal.)
      const segment = url.pathname.slice('/api/v1/universe/companies/'.length);
      expect(segment, hostile).not.toContain('/');
      expect(segment, hostile).not.toMatch(/\.\.\//);
      expect(calls[0].url, hostile).toBe(
        `https://api.rivalize.example/api/v1/universe/companies/${encodeURIComponent(hostile)}`,
      );
    }
  });

  it('listCompetitors + addCompetitor: hostile project ids are encoded, host fixed', async () => {
    const hostile = '../projects/../../admin?x=1';
    const { impl, calls } = capturingFetch(202, { data: {} });
    const client = new RivalizeClient(CONFIG, impl);
    await client.listCompetitors(hostile);
    await client.addCompetitor(hostile, ['https://r.co']);
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.origin).toBe('https://api.rivalize.example');
      // Raw '../' never survives — the encoded id is a single opaque segment.
      expect(url.pathname).not.toMatch(/\.\.\//);
    }
    // listCompetitors carries the id in the query string, encoded…
    expect(calls[0].url).toBe(
      `https://api.rivalize.example/api/v1/competitors?project_id=${encodeURIComponent(hostile)}`,
    );
    // …addCompetitor in the path, encoded.
    expect(new URL(calls[1].url).pathname).toContain(encodeURIComponent(hostile));
  });

  it('CR/LF in user input cannot inject headers or split the request line', async () => {
    const hostile = 'notion.so\r\nX-Injected: 1\r\n';
    const { impl, calls } = capturingFetch();
    const client = new RivalizeClient(CONFIG, impl);
    await client.getUniverseCompany(hostile);
    expect(calls[0].url).not.toContain('\r');
    expect(calls[0].url).not.toContain('\n');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(['Authorization', 'Content-Type', 'User-Agent']);
  });
});

describe('the key travels ONLY in the Authorization header', () => {
  it('requests carry Bearer auth; error objects never contain the key', async () => {
    const { impl, calls } = capturingFetch(500, 'upstream exploded');
    const client = new RivalizeClient(CONFIG, impl);
    const err = await client.listCompetitors().catch((e: RivalizeApiError) => e);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(err).toBeInstanceOf(RivalizeApiError);
    expect(err.message).not.toContain(API_KEY);
    expect(JSON.stringify({ ...err })).not.toContain(API_KEY);
  });

  it('network-failure errors name the base URL but never the key', async () => {
    const impl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED`);
    }) as unknown as typeof fetch;
    const client = new RivalizeClient(CONFIG, impl);
    const err = await client.listCompetitors().catch((e: RivalizeApiError) => e);
    expect(err.message).toContain('https://api.rivalize.example');
    expect(err.message).not.toContain(API_KEY);
  });
});

describe('hostile/degenerate response bodies', () => {
  it('an HTML 502 page (proxy/CDN) maps to a clean RivalizeApiError, not a parse crash', async () => {
    const { impl } = capturingFetch(502, '<html><body><h1>502 Bad Gateway</h1></body></html>');
    const client = new RivalizeClient(CONFIG, impl);
    const err = await client.listUniverseCompanies().catch((e: RivalizeApiError) => e);
    expect(err).toBeInstanceOf(RivalizeApiError);
    expect(err.status).toBe(502);
  });

  // An EMPTY statusText ('' on any constructed Response and on HTTP/2
  // origins) must fall through to the `HTTP ${status}` fallback instead of
  // short-circuiting the `??` chain with an empty message.
  it('non-JSON error bodies still yield a non-empty message (HTTP <status> fallback)', async () => {
    const { impl } = capturingFetch(502, '<html><body><h1>502 Bad Gateway</h1></body></html>');
    const client = new RivalizeClient(CONFIG, impl);
    const err = await client.listUniverseCompanies().catch((e: RivalizeApiError) => e);
    expect((err as RivalizeApiError).message).toBeTruthy();
  });

  it('non-JSON 200 body resolves without throwing (parsed as undefined, not a crash)', async () => {
    const { impl } = capturingFetch(200, 'plain text, not json');
    const client = new RivalizeClient(CONFIG, impl);
    await expect(client.listCompetitors()).resolves.toBeUndefined();
  });

  it('an empty error body still produces a status-bearing error', async () => {
    const { impl } = capturingFetch(429, '');
    const client = new RivalizeClient(CONFIG, impl);
    const err = await client.listCompetitors().catch((e: RivalizeApiError) => e);
    expect(err).toBeInstanceOf(RivalizeApiError);
    expect(err.status).toBe(429);
  });

  it('an empty 200 body resolves without throwing', async () => {
    const { impl } = capturingFetch(200, '');
    const client = new RivalizeClient(CONFIG, impl);
    await expect(client.listCompetitors()).resolves.toBeUndefined();
  });
});
