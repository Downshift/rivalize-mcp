/**
 * Client network tests: list paging parameters, errors that name the server
 * and the network cause, corporate-proxy support, and the pinned version.
 * fetch is mocked entirely; no real proxy, no network.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RivalizeApiError, RivalizeClient } from './client.js';
import { createProxyAwareFetch, proxyFromEnv, type UndiciLike } from './proxy.js';
import { VERSION } from './version.js';

const CONFIG = {
  apiKey: 'rk_live_client_qa_secret',
  apiUrl: 'https://api.example.test',
  allowWrites: false,
};

describe('list_competitors paging reaches the API as limit/offset', () => {
  it('sends limit and offset as query params with project_id', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const client = new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch);
    await client.listCompetitors({ projectId: 'p-1', limit: 25, offset: 50 });
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(
      'https://api.example.test/api/v1/competitors?project_id=p-1&limit=25&offset=50',
    );
  });

  it('companion: no params means no query string', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const client = new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch);
    await client.listCompetitors();
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(
      'https://api.example.test/api/v1/competitors',
    );
  });
});

describe('errors name the server and the network cause', () => {
  it('a 401 carries the URL it was sent to', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'INVALID_KEY', message: 'nope' } }), {
          status: 401,
        }),
    );
    const client = new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch);
    const err = (await client.listProjects().catch((e) => e)) as RivalizeApiError;
    expect(err).toBeInstanceOf(RivalizeApiError);
    expect(err.status).toBe(401);
    expect(err.apiUrl).toBe('https://api.example.test');
  });

  it('a network failure names the URL and err.cause.code (ECONNREFUSED)', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause });
    });
    const client = new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch);
    const err = (await client.listProjects().catch((e) => e)) as RivalizeApiError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toContain('https://api.example.test');
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).not.toContain('rk_live_client_qa_secret');
  });

  it('ENOTFOUND with no cause message still names the code', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    });
    const client = new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch);
    const err = (await client.listProjects().catch((e) => e)) as RivalizeApiError;
    expect(err.message).toContain('ENOTFOUND');
  });
});

describe('HTTPS_PROXY / HTTP_PROXY are honoured', () => {
  it('reads the proxy from the standard env vars, HTTPS first, either case', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://proxy.corp:8080' })).toBe('http://proxy.corp:8080');
    expect(proxyFromEnv({ https_proxy: 'http://lower:3128' })).toBe('http://lower:3128');
    expect(proxyFromEnv({ HTTP_PROXY: 'http://plain:3128' })).toBe('http://plain:3128');
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' })).toBe(
      'http://a:1',
    );
    expect(proxyFromEnv({ HTTPS_PROXY: '  ' })).toBeUndefined();
    expect(proxyFromEnv({})).toBeUndefined();
  });

  it('with a proxy set, requests go through undici fetch with an EnvHttpProxyAgent dispatcher (loaded once)', async () => {
    class FakeAgent {}
    const undiciFetch = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const load = vi.fn(
      async (): Promise<UndiciLike> => ({
        fetch: undiciFetch as unknown as UndiciLike['fetch'],
        EnvHttpProxyAgent: FakeAgent,
      }),
    );
    const f = createProxyAwareFetch({ HTTPS_PROXY: 'http://proxy.corp:8080' }, load);
    expect(f).not.toBe(globalThis.fetch);
    const client = new RivalizeClient(CONFIG, f);
    await client.listProjects();
    await client.listProjects();
    expect(load).toHaveBeenCalledTimes(1);
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    const [url, init] = undiciFetch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe('https://api.example.test/api/v1/projects');
    expect(init.dispatcher).toBeInstanceOf(FakeAgent);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer rk_live_client_qa_secret',
    );
  });

  it('companion: with no proxy env the global fetch is used and undici is never loaded', () => {
    const load = vi.fn();
    expect(createProxyAwareFetch({}, load as never)).toBe(globalThis.fetch);
    expect(load).not.toHaveBeenCalled();
  });

  it('a proxy failure surfaces as a network error naming the proxy host (credentials stripped) and the cause code', async () => {
    const undiciFetch = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    });
    const f = createProxyAwareFetch(
      { HTTPS_PROXY: 'http://user:s3cret@proxy.corp:8080' },
      async () => ({
        fetch: undiciFetch as unknown as UndiciLike['fetch'],
        EnvHttpProxyAgent: class {},
      }),
    );
    const err = (await new RivalizeClient(CONFIG, f).listProjects().catch((e) => e)) as Error;
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).toContain('proxy.corp:8080');
    expect(err.message).not.toContain('s3cret');
  });

  it('if undici cannot be loaded the error says so and names the env var', async () => {
    const f = createProxyAwareFetch({ HTTPS_PROXY: 'http://proxy.corp:8080' }, async () => {
      throw new Error('Cannot find module undici');
    });
    const err = (await new RivalizeClient(CONFIG, f).listProjects().catch((e) => e)) as Error;
    expect(err.message).toContain('HTTPS_PROXY');
    expect(err.message).toContain('undici');
  });
});

describe('version 0.3.1 is pinned in one place', () => {
  it('package.json, the VERSION constant and the User-Agent agree', async () => {
    const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.version).toBe('0.3.1');
    expect(VERSION).toBe(pkg.version);
    expect(pkg.dependencies.undici).toMatch(/^\^7\./);
    const fetchImpl = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    await new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch).listProjects();
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('rivalize-mcp/0.3.1');
  });
});
