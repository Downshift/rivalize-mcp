/**
 * MCP server configuration.
 *
 * The Rivalize MCP server authenticates to the v1 REST API with the caller's
 * `rk_live_*` API key, passed via the environment (no separate auth flow).
 * Three env vars:
 *
 *   RIVALIZE_API_KEY   — required. An `rk_live_*` key from any plan,
 *                        including free (rate-limited reads).
 *   RIVALIZE_API_URL   — optional. Base origin of the API
 *                        (default https://rivalize.ai).
 *   RIVALIZE_MCP_ALLOW_WRITES — optional. `1`/`true`/`yes` registers the write
 *                        tool (add_competitor). OFF by default: the server is
 *                        read-only unless asked, and a write spends credits.
 *
 * Resolution is lazy so the module can be imported in tests without the env set.
 */

const DEFAULT_API_URL = 'https://rivalize.ai';

export interface McpConfig {
  apiKey: string;
  apiUrl: string;
  /** Register write tools (add_competitor). Default false. */
  allowWrites: boolean;
}

/** `1`, `true` or `yes` (any case) turns writes on; anything else, or unset, leaves them off. */
export function parseAllowWrites(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Resolve config from the environment. Throws a clear, actionable error when the
 * API key is missing — this surfaces to the MCP client at startup.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiKey = (env.RIVALIZE_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error(
      'RIVALIZE_API_KEY is required. Set it to your Rivalize `rk_live_*` API key ' +
        '(create one in the dashboard under Settings → API Keys). Free accounts ' +
        'get rate-limited read access — sign up at https://rivalize.ai.',
    );
  }
  if (!apiKey.startsWith('rk_live_')) {
    throw new Error(
      'RIVALIZE_API_KEY does not look like a Rivalize API key (expected an `rk_live_` prefix).',
    );
  }
  const apiUrl = (env.RIVALIZE_API_URL ?? DEFAULT_API_URL).trim().replace(/\/+$/, '');
  return { apiKey, apiUrl, allowWrites: parseAllowWrites(env.RIVALIZE_MCP_ALLOW_WRITES) };
}
