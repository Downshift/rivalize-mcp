/**
 * The teardown says "at least 40" for an ad count the API marks as a lower
 * bound (one full results page was read; there may be far more).
 *
 * The marker is `ads.activeAdCountIsLowerBound`, stamped by the API on
 * GET /v1/universe/companies/:domain. The client reads the flag and nothing
 * else; it does not try to infer a bound from the count itself.
 */
import { describe, expect, it } from 'vitest';
import { renderTeardown } from './teardown.js';

const NOW = Date.parse('2026-09-30T00:00:00Z');

const company = (ads: Record<string, unknown>) => ({
  domain: 'busyads.example',
  name: 'Busy Ads',
  ads,
  lastEnrichedAt: '2026-09-29T00:00:00Z',
});

describe('renderTeardown — ad count bound', () => {
  it('a flagged count is a lower bound', () => {
    const md = renderTeardown(
      company({
        isAdvertising: true,
        activeAdCount: 40,
        activeAdCountIsLowerBound: true,
        platforms: ['google'],
        creatives: [],
      }),
      { nowMs: NOW },
    );
    expect(md).toContain('at least 40 active ad(s)');
  });

  it('an unflagged count is printed as an exact count', () => {
    const md = renderTeardown(
      company({
        isAdvertising: true,
        activeAdCount: 17,
        activeAdCountIsLowerBound: false,
        platforms: ['google'],
        creatives: [],
      }),
      { nowMs: NOW },
    );
    expect(md).toContain('17 active ad(s)');
    expect(md).not.toContain('at least');
  });
});
