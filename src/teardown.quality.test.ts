/**
 * teardown_competitor output-quality tests. The teardown must be about the
 * right entity, dated, faithful to the data, and must ABSTAIN where data is
 * thin. Fabricated claims are worse than missing sections.
 *
 * A never-enriched profile must not get absence-derived weakness claims ("no
 * public pricing", "no active ads") for layers nobody checked; the
 * never-enriched spec below locks that abstention in.
 */

import { describe, expect, it } from 'vitest';
import { renderTeardown } from './teardown.js';

const NOW = Date.parse('2026-07-11T00:00:00Z');

const RICH = {
  domain: 'notion.so',
  name: 'Notion',
  description: 'The AI workspace.',
  identity: { industry: 'Productivity' },
  momentum: { momentum: 80.4, delta: 2.1, signalCount: 5 },
  features: { positioning: ['The AI workspace that works for you.'], themes: ['AI'] },
  pricing: {
    hasPricingPage: true,
    plans: [
      { name: 'Plus', price: '$10' },
      { name: 'Business', price: '$20' },
    ],
  },
  ads: {
    isAdvertising: true,
    activeAdCount: 28,
    platforms: ['meta'],
    creatives: [{ text: 'Meet the night shift.' }],
  },
  socialInfluencers: {
    followerCounts: { linkedin: 120_000 },
    postingFrequency: { linkedin: '4/week' },
  },
  reviews: { appStore: { rating: 4.7, reviewCount: 9000 }, recentReviewThemes: ['love the AI'] },
  fundingHiring: { openRoles: 42, hiringVelocity: 'accelerating' },
  lastEnrichedAt: '2026-07-09T00:00:00Z',
};

describe('teardown quality', () => {
  it('the teardown is about the requested entity — name and domain from the payload only', () => {
    const md = renderTeardown(RICH, { nowMs: NOW });
    expect(md).toContain('# Competitor Teardown — Notion');
    expect(md).toContain('notion.so');
    // Falls back to identity.companyName, then domain — never an invented name.
    const noName = renderTeardown(
      { domain: 'acme.io', identity: { companyName: 'Acme Inc' } },
      { nowMs: NOW },
    );
    expect(noName).toContain('# Competitor Teardown — Acme Inc');
    const domainOnly = renderTeardown({ domain: 'acme.io' }, { nowMs: NOW });
    expect(domainOnly).toContain('# Competitor Teardown — acme.io');
  });

  it('leads with freshness dating when lastEnrichedAt is present, and omits it when absent', () => {
    const md = renderTeardown(RICH, { nowMs: NOW });
    expect(md).toContain('**Last refreshed:** 2 days ago');
    // The API can send Postgres timestamptz text; it must still date the teardown.
    const pgText = renderTeardown(
      { ...RICH, lastEnrichedAt: '2026-07-09 05:26:05.162+00' },
      { nowMs: NOW },
    );
    expect(pgText).toContain('**Last refreshed:** yesterday');
    const undated = renderTeardown({ domain: 'x.co', name: 'X' }, { nowMs: NOW });
    expect(undated).not.toContain('Last refreshed');
  });

  it('no renderer artifacts (undefined/null/NaN/[object Object]) on adversarial part-typed payloads', () => {
    const hostile = {
      domain: 'weird.co',
      name: 42, // number where string expected
      description: null,
      momentum: { momentum: 'not-a-number', delta: undefined },
      pricing: { plans: [{ name: null, price: { nested: true } }, 'not-an-object'] },
      features: { positioning: 'not-an-array', themes: [null, 5] },
      ads: {
        activeAdCount: '12',
        creatives: [null, { text: ['array', 'text'] }],
        platforms: [null, 7, 'X'],
      },
      socialInfluencers: {
        followerCounts: { x: Number.NaN, y: 'many', z: null, linkedin: '900' },
        postingFrequency: { a: null, b: { nested: true } },
      },
      reviews: {
        appStore: { rating: '4.5', reviewCount: 'lots' },
        recentReviewThemes: 'not-an-array',
      },
      fundingHiring: { openRoles: '3' },
      lastEnrichedAt: 'not-a-date',
    };
    const md = renderTeardown(hostile as Record<string, unknown>, { nowMs: NOW });
    // Non-vacuity: the hostile layers really were read (under the keys the API sends).
    expect(md).toContain('## Their ads');
    expect(md).toContain('linkedin: 900 followers');
    expect(md).toContain('4.5★');
    expect(md).toContain('3 open role');
    expect(md).not.toContain('undefined');
    expect(md).not.toMatch(/\bnull\b/);
    expect(md).not.toContain('NaN');
    expect(md).not.toContain('[object Object]');
  });

  it('every concrete figure in the output comes from the payload (data fidelity)', () => {
    const md = renderTeardown(RICH, { nowMs: NOW });
    // Present-in-payload figures render verbatim…
    expect(md).toContain('$10');
    expect(md).toContain('$20');
    expect(md).toContain('28 active ad(s)');
    // Counts read as the dashboard shows them (toLocaleString grouping).
    expect(md).toContain('linkedin: 120,000 followers');
    expect(md).toContain('4.7★');
    expect(md).toContain('(9,000 reviews)');
    expect(md).toContain('42 open role(s)');
    expect(md).toContain('Momentum: 80.4/100 (+2.1 vs last)');
    // …and no dollar figures beyond the payload's two plans.
    const dollarFigures = md.match(/\$\d+/g) ?? [];
    expect([...new Set(dollarFigures)].sort()).toEqual(['$10', '$20']);
  });

  it('an App Store rating reads to one decimal, as on the dashboard', () => {
    const md = renderTeardown(
      { ...RICH, reviews: { appStore: { rating: 3.22222, reviewCount: 14595 } } },
      { nowMs: NOW },
    );
    expect(md).toContain('App Store: 3.2★ (14,595 reviews)');
    expect(md).not.toContain('3.22222');
  });

  it('sections only render for layers present — a pricing-only profile has no ads/social/reviews/hiring sections', () => {
    const md = renderTeardown(
      {
        domain: 'lean.co',
        name: 'Lean',
        pricing: { plans: [{ name: 'Solo', price: '$5' }] },
        lastEnrichedAt: '2026-07-10T00:00:00Z',
      },
      { nowMs: NOW },
    );
    expect(md).toContain('## Their pricing');
    expect(md).not.toContain('## Their social');
    expect(md).not.toContain('## Reviews');
    expect(md).not.toContain('## Hiring');
    expect(md).not.toContain('what they are spending to test'); // no ads section header
  });

  it('hostile payload strings render inertly without crashing', () => {
    const md = renderTeardown(
      {
        domain: 'evil.co',
        name: '<script>alert(1)</script>',
        features: { positioning: ['[click me](javascript:alert(1))', '[31mANSI[0m'] },
        pricing: { plans: [{ name: '`rm -rf /`', price: '$0' }] },
        lastEnrichedAt: '2026-07-10T00:00:00Z',
      },
      { nowMs: NOW },
    );
    // Content is passed through as inert text — the renderer must simply not die
    // and not transform hostile strings into anything else.
    expect(md).toContain('<script>alert(1)</script>');
    expect(md).toContain('[click me](javascript:alert(1))'); // reached the renderer unchanged
    expect(md.length).toBeGreaterThan(100);
  });

  it('a maximal profile renders fast with bounded output (per-section caps hold)', () => {
    const big = {
      ...RICH,
      features: {
        positioning: Array.from({ length: 500 }, (_, i) => `theme-${i}`),
        themes: Array.from({ length: 500 }, (_, i) => `claim-${i}`),
      },
      pricing: {
        plans: Array.from({ length: 300 }, (_, i) => ({ name: `Plan ${i}`, price: `$${i}` })),
      },
      ads: {
        activeAdCount: 1000,
        creatives: Array.from({ length: 1000 }, (_, i) => ({
          text: `hook ${i} ${'x'.repeat(80)}`,
        })),
      },
      socialInfluencers: {
        ...RICH.socialInfluencers,
        recentPosts: Array.from({ length: 500 }, (_, i) => ({ text: `post ${i}` })),
      },
    };
    const t0 = performance.now();
    const md = renderTeardown(big, { nowMs: NOW });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(100);
    // Bullets are capped (8 per section, 4 for posts) — output stays agent-sized.
    // Each section rendered (positive companions), then was capped.
    expect(md).toContain('theme-7');
    expect(md).not.toContain('theme-8'); // 9th theme cut
    expect(md).toContain('hook 7');
    expect(md).not.toContain('hook 8'); // 9th creative cut
    expect(md).toContain('post 3');
    expect(md).not.toContain('post 4'); // 5th post cut
    expect(md).toContain('1,000 creatives observed');
    expect(md.length).toBeLessThan(10_000);
  });

  // ── Never-enriched profiles ──────────────────────────────────────────────
  // A NEVER-ENRICHED profile (no lastEnrichedAt, no layer freshness) must not
  // carry absence-derived competitive claims: nobody can assert "they hide
  // their pricing" about a company whose pricing was never checked.
  // Absence-weaknesses are gated on enrichment evidence.
  it('never-enriched profile produces NO absence-derived weakness claims', () => {
    const md = renderTeardown({ domain: 'ghost.co', name: 'Ghost' }, { nowMs: NOW });
    expect(md).not.toContain('No pricing page found on their site');
    // This weakness has had more than one wording. Pinning only the CURRENT
    // string would let a revert slip past the guard, so both shapes are
    // refused: the rule is about the CLAIM, not the sentence carrying it.
    expect(md).not.toContain('No public pricing');
    expect(md).not.toContain('transparency gap');
    expect(md).not.toContain('No active paid ads detected');
  });

  it('companion: measured-data weaknesses still render for thin profiles (low momentum IS real data)', () => {
    const md = renderTeardown(
      { domain: 'thin.co', name: 'Thin', momentum: { momentum: 12 } },
      { nowMs: NOW },
    );
    expect(md).toContain('Low momentum (12/100)');
  });
});
