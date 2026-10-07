/**
 * Teardown behaviour on full-scale universe payloads: stale "active" ads, page
 * titles that must not be shown as hooks, the "Go deeper" link, pricing period
 * and Enterprise tiers, and a null momentum that must not read as 0. Payloads
 * have the shape and scale of real universe rows (see __fixtures__/payloads).
 */

import { describe, expect, it } from 'vitest';
import { demoSeedCompany, exampleScaleCompany } from './__fixtures__/payloads.js';
import { renderTeardown } from './teardown.js';

/** The day these profiles are read on. */
const QA_DAY = Date.parse('2026-10-01T12:00:00Z');

function section(md: string, heading: string): string {
  const at = md.indexOf(`## ${heading}`);
  expect(at, heading).toBeGreaterThan(-1);
  const next = md.indexOf('\n## ', at + 3);
  return md.slice(at, next === -1 ? undefined : next);
}

describe('a null momentum is "not scored", never 0', () => {
  it('demo profile (momentum null, below-signal-threshold): no 0/100 and no low-momentum weakness', () => {
    const md = renderTeardown(demoSeedCompany(), { nowMs: QA_DAY });
    expect(md).not.toContain('0/100');
    expect(md).not.toContain('Low momentum');
    expect(md).toContain('Momentum: not scored');
    expect(md).toContain('below signal threshold');
  });

  it('companion: a measured low score still renders and still yields the weakness', () => {
    const md = renderTeardown(
      { domain: 'thin.co', name: 'Thin', momentum: { momentum: 12 } },
      { nowMs: QA_DAY },
    );
    expect(md).toContain('Momentum: 12/100');
    expect(md).toContain('Low momentum (12/100)');
  });

  it('companion: a measured score of exactly 0 is still a score', () => {
    const md = renderTeardown(
      { domain: 'z.co', name: 'Z', momentum: { momentum: 0 } },
      { nowMs: QA_DAY },
    );
    expect(md).toContain('Momentum: 0/100');
  });
});

describe('an ad counts as active only if seen in the last 30 days', () => {
  it('example.com (only creative last seen 2025-06-28): no "active ad(s)", says when it was last seen', () => {
    const md = renderTeardown(exampleScaleCompany(), { nowMs: QA_DAY });
    const ads = section(md, 'Their ads');
    expect(ads).not.toMatch(/\d+ active ad\(s\)/);
    expect(ads).toContain('no ad seen in the last 30 days (last seen 2025-06-28)');
  });

  it('companion: a creative seen 10 days ago is active', () => {
    const company = exampleScaleCompany();
    const ads = company.ads as Record<string, unknown>;
    ads.creatives = [
      { ...(ads.creatives as Array<Record<string, unknown>>)[0], lastSeen: '2026-09-21T00:00:00Z' },
    ];
    const md = renderTeardown(company, { nowMs: QA_DAY });
    expect(section(md, 'Their ads')).toContain('1 active ad(s)');
  });

  it('an unchecked count (no creatives, ads layer last checked 114 days ago) is not called active', () => {
    const md = renderTeardown(demoSeedCompany(), { nowMs: QA_DAY });
    const ads = section(md, 'Their ads');
    expect(ads).not.toContain('3 active ad(s)');
    expect(ads).toContain('3 ad(s) reported active when last checked on 2026-06-09');
    expect(ads).toContain('not re-checked in the last 30 days');
  });
});

describe('hooks are ad copy, never a page title', () => {
  it('example.com: "Home \\ Example Co" is not shown, and no hooks section without ad copy', () => {
    const md = renderTeardown(exampleScaleCompany(), { nowMs: QA_DAY });
    expect(md).not.toContain('Home \\ Example Co');
    expect(md).not.toContain("Hooks they're running");
    expect(md).not.toContain('their hooks');
    // The real positioning sentence stays, with its HTML entity decoded.
    expect(section(md, 'How they position')).toContain(
      "Example Co is a data and research company that's working",
    );
  });

  it('companion: recent creative copy is shown as the hook', () => {
    const company = exampleScaleCompany();
    (company.ads as Record<string, unknown>).creatives = [
      { text: 'Meet Example Co, your research partner.', lastSeen: '2026-09-25T00:00:00Z' },
    ];
    const md = renderTeardown(company, { nowMs: QA_DAY });
    expect(section(md, 'Their ads')).toContain("Hooks they're running");
    expect(section(md, 'Their ads')).toContain('Meet Example Co, your research partner.');
  });
});

describe('"Go deeper" points at the route the MCP itself reads', () => {
  it('names get_universe_company and the v1 route on the configured origin', () => {
    const md = renderTeardown(exampleScaleCompany(), {
      nowMs: QA_DAY,
      origin: 'https://self-hosted.rivalize.example',
    });
    const deeper = section(md, 'Go deeper');
    expect(deeper).toContain('get_universe_company');
    expect(deeper).toContain(
      'https://self-hosted.rivalize.example/api/v1/universe/companies/example.com',
    );
    expect(md).not.toContain('/api/public/universe/companies');
  });
});

describe('pricing keeps the billing period and contact-sales tiers the payload carries', () => {
  it('renders period and an Enterprise/custom tier when present', () => {
    const md = renderTeardown(
      {
        domain: 'acme.io',
        name: 'Acme',
        lastEnrichedAt: '2026-09-30T00:00:00Z',
        pricing: {
          plans: [
            { name: 'Basic', price: '$10', billingPeriod: 'per user / month' },
            { name: 'Business', price: '$16', period: 'monthly' },
            { name: 'Enterprise', price: 'custom' },
          ],
        },
      },
      { nowMs: QA_DAY },
    );
    const pricing = section(md, 'Their pricing');
    expect(pricing).toContain('Basic — $10 per user / month');
    expect(pricing).toContain('Business — $16 monthly');
    expect(pricing).toContain('Enterprise — custom pricing (contact sales)');
  });

  it('demo profile (no period, no Enterprise in the payload): nothing is invented', () => {
    const pricing = section(
      renderTeardown(demoSeedCompany(), { nowMs: QA_DAY }),
      'Their pricing',
    );
    expect(pricing).toContain('- Free — $0');
    expect(pricing).toContain('- Basic — $10');
    expect(pricing).toContain('- Business — $16');
    expect(pricing).not.toMatch(/month|Enterprise|contact sales/i);
  });
});

describe('demo seed data is labelled', () => {
  it('demo profile (signals.demoSeed, sourceTags demo-snapshot) carries a demo-data notice', () => {
    const md = renderTeardown(demoSeedCompany(), { nowMs: QA_DAY });
    expect(md).toMatch(/demo seed data/i);
  });

  it('companion: a measured profile carries no such notice', () => {
    const md = renderTeardown(exampleScaleCompany(), { nowMs: QA_DAY });
    expect(md).not.toMatch(/demo seed data/i);
  });
});

/**
 * The universe API's current served shape: a demo row is marked `isDemo` with
 * its placeholders withheld, and a stale count is served as
 * `activeAdCount: null` beside `observedAdCount`.
 */
describe('the universe API as currently served', () => {
  it('a row marked only isDemo carries the demo notice and names what was withheld', () => {
    const md = renderTeardown(
      {
        domain: 'tasks.test',
        name: 'Tasker',
        isDemo: true,
        demoWithheld: ['ads', 'reviews', 'features.themes'],
      },
      { nowMs: QA_DAY },
    );
    expect(md).toContain('Includes demo seed data');
    expect(md).toContain('ads, reviews, features.themes');
  });

  it('activeAdCount null with an older observedAdCount: reported as of its check, never "no ads"', () => {
    const md = renderTeardown(
      {
        domain: 'stale.co',
        name: 'Stale',
        lastEnrichedAt: '2026-06-09T00:00:00.000Z',
        layerFreshness: { ads: '2026-06-09T00:00:00.000Z' },
        ads: { activeAdCount: null, observedAdCount: 3, activeWindowDays: 30 },
      },
      { nowMs: QA_DAY },
    );
    const ads = section(md, 'Their ads');
    expect(ads).toContain('3 ad(s) reported active when last checked on 2026-06-09');
    expect(md).not.toContain('No active paid ads detected');
  });

  it('companion: an ads layer with no count and no creatives is still a measured absence', () => {
    const md = renderTeardown(
      {
        domain: 'quiet.co',
        name: 'Quiet',
        lastEnrichedAt: '2026-09-30T00:00:00.000Z',
        layerFreshness: { ads: '2026-09-30T00:00:00.000Z', pricing: '2026-09-30T00:00:00.000Z' },
        pricing: { plans: [{ name: 'Pro', price: '$10' }] },
        ads: { activeAdCount: 0, observedAdCount: 0, activeWindowDays: 30 },
      },
      { nowMs: QA_DAY },
    );
    expect(md).toContain('No active paid ads detected');
  });
});
