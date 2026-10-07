import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';

describe('resolveConfig', () => {
  it('resolves a valid key with the default API url', () => {
    const cfg = resolveConfig({ RIVALIZE_API_KEY: 'rk_live_abc' } as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('rk_live_abc');
    expect(cfg.apiUrl).toBe('https://rivalize.ai');
  });

  it('honors RIVALIZE_API_URL and strips trailing slashes', () => {
    const cfg = resolveConfig({
      RIVALIZE_API_KEY: 'rk_live_abc',
      RIVALIZE_API_URL: 'http://localhost:3000/',
    } as NodeJS.ProcessEnv);
    expect(cfg.apiUrl).toBe('http://localhost:3000');
  });

  it('throws an actionable error when the key is missing', () => {
    expect(() => resolveConfig({} as NodeJS.ProcessEnv)).toThrow(/RIVALIZE_API_KEY is required/);
  });

  it('rejects a key without the rk_live_ prefix', () => {
    expect(() => resolveConfig({ RIVALIZE_API_KEY: 'sk_test_nope' } as NodeJS.ProcessEnv)).toThrow(
      /rk_live_/,
    );
  });
});

describe('writes are off unless explicitly enabled', () => {
  const KEY = { RIVALIZE_API_KEY: 'rk_live_abc' };
  it('defaults to read-only when RIVALIZE_MCP_ALLOW_WRITES is unset', () => {
    expect(resolveConfig({ ...KEY }).allowWrites).toBe(false);
  });
  it.each(['1', 'true', 'TRUE', ' yes '])('enables writes for %j', (v) => {
    expect(resolveConfig({ ...KEY, RIVALIZE_MCP_ALLOW_WRITES: v }).allowWrites).toBe(true);
  });
  it.each(['', '0', 'false', 'no', 'on', 'enabled'])('stays read-only for %j', (v) => {
    expect(resolveConfig({ ...KEY, RIVALIZE_MCP_ALLOW_WRITES: v }).allowWrites).toBe(false);
  });
  it('the missing-key message does not advertise a write tool', () => {
    expect(() => resolveConfig({})).toThrow(/rate-limited read access/);
    expect(() => resolveConfig({})).not.toThrow(/add_competitor/);
  });
});
