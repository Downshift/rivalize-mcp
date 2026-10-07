import { describe, expect, it } from 'vitest';
import { renderTeardown } from './teardown.js';

const NOW = Date.parse('2026-06-27T00:00:00Z');

// The shape GET /v1/universe/companies/:domain returns (the profile plus the
// momentum block). Fixtures in an invented shape would keep this suite green
// while the teardown read keys the real payload never carries.
const company = {
  domain: 'notion.so',
  name: 'Notion',
  description: 'The AI workspace.',
  identity: { industry: 'Productivity', companyName: 'Notion' },
  momentum: { momentum: 80.4, delta: -0.7, signalCount: 3 },
  features: {
    featureNames: ['Docs', 'AI'],
    positioning: ['The AI workspace that works for you.'],
    themes: ['AI', 'collaboration'],
  },
  pricing: {
    hasPricingPage: true,
    plans: [
      { name: 'Free', price: '$0' },
      { name: 'Plus', price: '$10' },
    ],
  },
  ads: {
    isAdvertising: true,
    activeAdCount: 28,
    platforms: ['meta', 'google'],
    creatives: [{ text: 'Meet the night shift.', platform: 'meta' }],
  },
  socialInfluencers: {
    followerCounts: { linkedin: 120000, twitter: 8208 },
    postingFrequency: { linkedin: '4/week' },
    recentPosts: [{ text: 'hi' }],
  },
  reviews: { appStore: { rating: 4.7, reviewCount: 9000 }, recentReviewThemes: ['love the AI'] },
  fundingHiring: { openRoles: 42, hiringVelocity: 'accelerating' },
  lastEnrichedAt: '2026-06-25T00:00:00Z',
};

/**
 * The ENRICHED branch, where the absence weakness is actually emitted. The
 * never-enriched guards below say nothing about the sentence itself: changing
 * `teardown.ts` back to "No public pricing surfaced - a transparency gap you
 * can exploit" would leave all of them green, because that profile never
 * reaches this line.
 *
 * The claim being refused is not the wording but the shape: the crawl observed
 * that it reached no pricing page. That does not establish that the company
 * keeps prices private, and "a transparency gap" would say it had.
 */
describe('renderTeardown — the pricing-absence weakness', () => {
  const enrichedWithoutPricing = { ...company, pricing: { hasPricingPage: false } };

  it('states what the crawl found, and claims nothing about the company', () => {
    const md = renderTeardown(enrichedWithoutPricing, { nowMs: NOW });
    // non-vacuity: the enriched absence branch really did fire
    expect(md).toContain('No pricing page found on their site');
    for (const forbidden of [
      'transparency gap',
      'No public pricing',
      'does not publish',
      'keeps pricing private',
      'not public',
    ]) {
      expect(md.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('no extracted plans is not "no pricing page" — the claim needs hasPricingPage === false', () => {
    const hasPageNoPlans = renderTeardown(
      { ...company, pricing: { hasPricingPage: true, plans: [] } },
      { nowMs: NOW },
    );
    expect(hasPageNoPlans).toContain('# Competitor Teardown — Notion');
    expect(hasPageNoPlans).not.toContain('No pricing page found');
    const unmeasured = renderTeardown({ ...company, pricing: {} }, { nowMs: NOW });
    expect(unmeasured).toContain('# Competitor Teardown — Notion');
    expect(unmeasured).not.toContain('No pricing page found');
  });
});

describe('renderTeardown — the ads-absence weakness', () => {
  it('renders the ads section for an advertiser whose only signal is its platforms, and makes no absence claim', () => {
    const md = renderTeardown(
      {
        ...company,
        ads: { isAdvertising: false, activeAdCount: 0, platforms: ['google'], creatives: [] },
      },
      { nowMs: NOW },
    );
    expect(md).toContain('## Their ads');
    expect(md).toContain('google');
    expect(md).not.toContain('No active paid ads detected');
  });

  it('claims no ads only when the ads layer was collected and carries no signal', () => {
    const measured = renderTeardown(
      { ...company, ads: { isAdvertising: false, activeAdCount: 0, platforms: [], creatives: [] } },
      { nowMs: NOW },
    );
    expect(measured).toContain('No active paid ads detected');
    expect(measured).not.toContain('## Their ads');
    const uncollected = renderTeardown({ ...company, ads: {} }, { nowMs: NOW });
    expect(uncollected).toContain('# Competitor Teardown — Notion');
    expect(uncollected).not.toContain('No active paid ads detected');
  });
});

describe('renderTeardown', () => {
  it('renders a full framed teardown from a universe company', () => {
    const md = renderTeardown(company, { nowMs: NOW, origin: 'https://rivalize.ai' });
    expect(md).toContain('# Competitor Teardown — Notion');
    expect(md).toContain('Momentum: 80.4/100');
    expect(md).toContain('How they position'); // hooks
    expect(md).toContain('The AI workspace that works for you.'); // features.positioning
    expect(md).toContain('$10'); // pricing
    expect(md).toContain('28 active ad(s)'); // ads centerpiece
    expect(md).toContain('meta, google'); // ad platforms
    expect(md).toContain('Meet the night shift.'); // ad creative hook
    expect(md).toContain('linkedin: 120,000 followers'); // social, per platform
    expect(md).toContain('linkedin 4/week'); // posting frequency
    expect(md).toContain('4.7★'); // reviews
    expect(md).toContain('love the AI'); // recentReviewThemes
    expect(md).toContain('42 open role'); // hiring
    // drill-down: the v1 route the MCP itself reads, not the public one
    expect(md).toContain('/api/v1/universe/companies/notion.so');
  });

  it('degrades gracefully + surfaces weaknesses on a thin profile', () => {
    const md = renderTeardown(
      { domain: 'thin.co', name: 'Thin', momentum: { momentum: 12 } },
      {
        nowMs: NOW,
      },
    );
    expect(md).toContain('# Competitor Teardown — Thin');
    expect(md).toContain('Weaknesses to attack');
    expect(md).toContain('Low momentum'); // 12/100 flagged — measured data stays
    // This profile was never enriched (no lastEnrichedAt), so absence-derived
    // claims about layers nobody checked must NOT render.
    expect(md).not.toContain('No pricing page found on their site');
    // This weakness has had more than one wording. Pinning only the CURRENT
    // string would let a revert slip past the guard, so both shapes are
    // refused: the rule is about the CLAIM, not the sentence carrying it.
    expect(md).not.toContain('No public pricing');
    expect(md).not.toContain('transparency gap');
    expect(md).not.toContain('No active paid ads detected');
    expect(md).toContain('Not yet enriched');
    expect(md).not.toContain('undefined');
  });

  it('the not-yet-enriched banner names add_competitor only when that tool exists', () => {
    const ghost = { domain: 'ghost.co', name: 'Ghost' };
    const readOnly = renderTeardown(ghost, { nowMs: NOW });
    expect(readOnly).toContain('Not yet enriched');
    expect(readOnly).toContain('Rivalize dashboard');
    expect(readOnly).not.toContain('add_competitor');
    const writes = renderTeardown(ghost, { nowMs: NOW, canAddCompetitor: true });
    expect(writes).toContain('Not yet enriched');
    expect(writes).toContain('Use add_competitor');
  });
});
