/**
 * Corporate-proxy support.
 *
 * Node's global fetch ignores HTTPS_PROXY (it only honours it under
 * NODE_USE_ENV_PROXY=1 on recent Node releases), so a user behind a proxy would
 * get "fetch failed" with the reason dropped. When a proxy variable is set, requests
 * go through undici's own `fetch` with an `EnvHttpProxyAgent` dispatcher, which
 * reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY the standard way.
 *
 * Why undici as a dependency: it is the HTTP client Node's fetch is built on,
 * has no dependencies of its own, and `EnvHttpProxyAgent` is exactly the
 * behaviour wanted. Its own `fetch` is used (not the global one) because a
 * dispatcher from the npm package is not guaranteed to be compatible with the
 * copy bundled inside Node. It is imported lazily, only when a proxy is set, so
 * the common path loads nothing extra. ^7 supports every Node 22 (undici 8
 * requires Node >= 22.19, narrower than this package's engines).
 */

type Env = Record<string, string | undefined>;

export interface UndiciLike {
  fetch: (input: string, init?: Record<string, unknown>) => Promise<Response>;
  EnvHttpProxyAgent: new () => unknown;
}

export type UndiciLoader = () => Promise<UndiciLike>;

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

/** The proxy URL from the environment, HTTPS before HTTP, either case. */
export function proxyFromEnv(env: Env): string | undefined {
  for (const key of PROXY_VARS) {
    const v = env[key]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** host:port of a proxy URL, never its credentials. */
function proxyHost(proxy: string): string {
  try {
    return new URL(proxy).host || 'the configured proxy';
  } catch {
    return 'the configured proxy';
  }
}

// A variable specifier keeps TypeScript from resolving the module at compile
// time; it is a runtime dependency loaded only when a proxy is configured.
const UNDICI = 'undici';
const loadUndici: UndiciLoader = async () => (await import(UNDICI)) as UndiciLike;

/**
 * The fetch the client should use: the global fetch when no proxy is set,
 * otherwise undici's fetch through an EnvHttpProxyAgent (loaded once).
 * Failures name the proxy host and keep the original `cause`.
 */
export function createProxyAwareFetch(env: Env, load: UndiciLoader = loadUndici): typeof fetch {
  const proxy = proxyFromEnv(env);
  if (!proxy) return globalThis.fetch;
  const host = proxyHost(proxy);
  let ready: Promise<{ fetch: UndiciLike['fetch']; dispatcher: unknown }> | undefined;

  const proxied = async (input: unknown, init?: RequestInit): Promise<Response> => {
    ready ??= load()
      .then((m) => ({ fetch: m.fetch, dispatcher: new m.EnvHttpProxyAgent() }))
      .catch((err: unknown) => {
        ready = undefined;
        throw new Error(
          `HTTPS_PROXY/HTTP_PROXY is set (${host}) but the proxy support module undici could not be loaded: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    const { fetch: undiciFetch, dispatcher } = await ready;
    try {
      return await undiciFetch(String(input), { ...(init as Record<string, unknown>), dispatcher });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
      throw new TypeError(`${message} (via proxy ${host})`, { cause });
    }
  };
  return proxied as unknown as typeof fetch;
}
