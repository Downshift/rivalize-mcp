/**
 * Payloads with the shape and scale of real Rivalize API responses. The
 * companies and text are fictitious; the structure, array lengths and sizes
 * are what the API serves for a well-covered company and a large report:
 *
 *   - a v1 universe LIST row: ~850 chars compact, 2 categories, 7
 *     layerFreshness keys, a 140-190 char description;
 *   - a large universe DETAIL profile (`exampleScaleCompany`, example.com):
 *     over 30,000 chars compact; socialInfluencers.recentPosts = 34 posts
 *     (nearly half the payload), ads.creatives = 1 (lastSeen 2025-06-28, empty
 *     text), identity.topPages = 12, rankings.asoApps = 2;
 *   - a demo-seeded DETAIL profile (`demoSeedCompany`): identity.sources = 40
 *     near-identical entries, demo seed (`signals.demoSeed`),
 *     `momentum: { momentum: null, reason }`, 3 plans with no billing period
 *     and no Enterprise tier;
 *   - a report's agent Markdown: ~114,000 chars, 20 `## <competitor>` sections
 *     of 3.4-5.4 KB, then `## Battlecards…` with 15 `### vs <competitor>`.
 */

const ISO = (d: string) => `${d}T05:39:12.730Z`;

function sentence(seed: number, words: number): string {
  const vocab = [
    'platform',
    'teams',
    'enterprise',
    'model',
    'pricing',
    'launch',
    'customers',
    'workflow',
    'agents',
    'safety',
    'research',
    'release',
    'growth',
    'market',
    'carbon',
    'advisory',
    'credits',
    'reporting',
    'data',
    'integration',
  ];
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(vocab[(seed * 7 + i * 13) % vocab.length]);
  return out.join(' ');
}

function source(url: string, quote: string, src: string, day: string) {
  return {
    url,
    tier: 'primary',
    quote,
    source: src,
    fetchedAt: ISO(day),
    sourceUrl: url,
    confidence: 0.85,
  };
}

const LAYER_FRESHNESS = {
  ads: ISO('2026-06-08'),
  social: ISO('2026-06-08'),
  pricing: '2026-06-10T09:51:35.667Z',
  reviews: ISO('2026-06-08'),
  features: ISO('2026-06-08'),
  identity: ISO('2026-06-08'),
  rankings: ISO('2026-06-08'),
};

/** One row as GET /v1/universe/companies returns it. */
export function universeListRow(i: number): Record<string, unknown> {
  const name = `Company ${String(i).padStart(4, '0')}`;
  const domain = `company-${i}.example`;
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    domain,
    name,
    slug: `company-${i}`,
    homepageUrl: `https://${domain}`,
    description: `${name} builds ${sentence(i, 17)}.`,
    primaryCategory: 'AI infrastructure',
    freshnessTier: 'warm',
    priorityScore: 100 - (i % 50),
    lastEnrichedAt: '2026-06-10T10:13:27.211+00:00',
    layerFreshness: LAYER_FRESHNESS,
    categories: [
      { slug: 'ai-dev-tools', name: 'AI dev-tools' },
      { slug: 'ai-infra', name: 'AI infrastructure' },
    ],
  };
}

/** A large universe profile (example.com) at the scale the API serves. */
export function exampleScaleCompany(): Record<string, unknown> {
  const site = 'https://example.com';
  const posts = Array.from({ length: 34 }, (_, i) => ({
    url: `https://twitter.com/i/status/20629796074486827${String(i).padStart(2, '0')}`,
    text: `New Example Co post ${i}: ${sentence(i, 26)}. Read more: https://t.co/ab${i}`,
    platform: 'twitter',
    postedAt: 'Fri Jun 05 19:27:21 +0000 2026',
    likes: 1000 + i,
    reposts: 100 + i,
    replies: 10 + i,
  }));
  return {
    id: '7c1d0d8e-0000-4000-8000-000000000001',
    domain: 'example.com',
    name: 'Example Co',
    slug: 'example-co',
    homepageUrl: site,
    description:
      "Example Co is a data and research company that's working to build reliable, explainable, and auditable reporting systems.",
    primaryCategory: 'AI dev-tools',
    freshnessTier: 'warm',
    priorityScore: 100,
    lastEnrichedAt: '2026-06-10T09:51:35.667+00:00',
    layerFreshness: { ...LAYER_FRESHNESS, fundingHiring: '2026-06-08T00:42:37.058Z' },
    categories: [{ slug: 'ai-dev-tools', name: 'AI dev-tools' }],
    status: 'active',
    sourceTags: ['manual', 'recursive_discovery'],
    discovery: { via: 'recursive_discovery', seed: 'example.org', depth: 1, note: sentence(3, 40) },
    sourceUrls: [site, `${site}/news`, `${site}/careers`],
    identity: {
      logoUrl: `${site}/favicon.ico`,
      industry: 'AI dev-tools',
      companyName: 'Example Co',
      sources: Array.from({ length: 8 }, (_, i) =>
        source(
          site,
          `Example Co is a data and research company ${i}`,
          'faircrawl:web',
          '2026-06-07',
        ),
      ),
      topPages: Array.from({ length: 12 }, (_, i) => ({
        url: `${site}/page-${i}`,
        title: `Page ${i} \\ Example Co`,
        snippet: sentence(i, 20),
      })),
    },
    pricing: {
      sources: Array.from({ length: 3 }, (_, i) =>
        source(
          `${site}/pricing`,
          `Pricing page found ${i}`,
          'faircrawl:pricing-page',
          '2026-06-10',
        ),
      ),
      hasFreeTier: true,
      hasFreeTrial: false,
      pricingModel: 'freemium',
      hasPricingPage: true,
    },
    features: {
      sources: Array.from({ length: 2 }, (_, i) =>
        source(site, `Example Co is a research company ${i}`, 'faircrawl:web', '2026-06-07'),
      ),
      positioning: [
        'Home \\ Example Co',
        'Example Co is a data and research company that&#x27;s working to build reliable, explainable, and auditable reporting systems.',
      ],
      featureNames: ['Developer docs', 'Read the story'],
    },
    ads: {
      sources: [
        source(
          'https://adstransparency.google.com?region=anywhere&domain=example.com',
          '1 Google ad via Transparency Center',
          'google-ads-transparency',
          '2026-06-08',
        ),
      ],
      creatives: [
        {
          id: 'CR05796431564250284033',
          text: '',
          source: 'google-ads-transparency',
          lastSeen: '2025-06-28T19:56:05.000Z',
          mediaUrl: `https://displayads-formats.googleusercontent.com/ads/preview/content.js?${'x'.repeat(420)}`,
          platform: 'google',
          videoUrl: `https://displayads-formats.googleusercontent.com/ads/preview/content.js?${'y'.repeat(420)}`,
        },
      ],
      platforms: ['google'],
      activeAdCount: 1,
      isAdvertising: true,
      inferredThemes: [],
    },
    socialInfluencers: {
      sources: Array.from({ length: 7 }, (_, i) =>
        source(
          `https://twitter.com/ExampleCoHQ?${i}`,
          `Example Co on X ${i}`,
          'social:x',
          '2026-06-08',
        ),
      ),
      recentPosts: posts,
      followerCounts: { twitter: 1_214_000, linkedin: 980_000 },
      postingFrequency: { twitter: 'daily' },
    },
    reviews: {
      appStore: { rating: 4.62, reviewCount: 41_230 },
      recentReviewThemes: ['fast answers', 'usage limits'],
      sources: [
        source(
          'https://apps.apple.com/app/example-co',
          'Example Co for iOS',
          'appstore',
          '2026-06-08',
        ),
      ],
    },
    fundingHiring: {
      openRoles: 312,
      hiringVelocity: 'accelerating',
      sources: [source(`${site}/careers`, '312 open roles', 'greenhouse', '2026-06-08')],
    },
    rankings: {
      aso: { keyword: 'ai assistant', rank: 3, country: 'us', note: sentence(5, 60) },
      asoApps: Array.from({ length: 2 }, (_, i) => ({
        id: `app-${i}`,
        name: `Example Co ${i}`,
        note: sentence(i, 70),
      })),
      sources: Array.from({ length: 2 }, (_, i) =>
        source('https://apps.apple.com', `ASO ${i} ${sentence(i, 30)}`, 'aso', '2026-06-08'),
      ),
      categoryRank: 1,
      notes: sentence(9, 160),
    },
    signals: {
      freshnessScore: 80,
      reviewVelocity: 100,
      adVelocityScore: 5,
      hiringVelocityScore: 100,
      socialMomentumScore: 100,
    },
    nextRefreshAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-10T09:51:35.667Z',
    momentum: {
      momentum: 52.2,
      signalCount: 3,
      signals: { ads: 41.7, hiring: 95, social: 35.5, funding: null, productChange: null },
      delta: -0.2,
      methodologyVersion: 'v1.1',
      scoredAt: '2026-06-10T00:00:00.000Z',
    },
  };
}

/** A demo-seeded profile: 40 near-identical identity sources, null momentum. */
export function demoSeedCompany(): Record<string, unknown> {
  return {
    domain: 'tasks.test',
    name: 'Tasker',
    description: 'Tasker is a purpose-built tool for planning and tracking projects.',
    primaryCategory: 'Project management',
    lastEnrichedAt: '2026-06-11T13:20:40.6+00:00',
    layerFreshness: {
      ads: '2026-06-09T00:00:00.000Z',
      social: '2026-06-09T00:00:00.000Z',
      pricing: '2026-06-11T13:20:40.600Z',
    },
    sourceTags: ['demo-snapshot', 'manual', 'public-company'],
    identity: {
      companyName: 'Tasker',
      sources: Array.from({ length: 40 }, (_, i) => ({
        url: 'https://tasks.test',
        tier: 'secondary',
        quote: 'Tasker',
        source: 'manual',
        fetchedAt: `2026-07-01T02:22:${String(i % 60).padStart(2, '0')}.687Z`,
        sourceUrl: 'https://tasks.test',
        confidence: 0.9,
      })),
    },
    pricing: {
      plans: [
        { name: 'Free', price: '$0', features: [] },
        { name: 'Basic', price: '$10', features: [] },
        { name: 'Business', price: '$16', features: [] },
      ],
      hasFreeTier: true,
      hasPricingPage: true,
    },
    features: { themes: ['work management', 'collaboration', 'AI'] },
    ads: { platforms: ['Meta', 'Google'], activeAdCount: 3 },
    reviews: { summary: 'Public review snapshot available.' },
    fundingHiring: { hiringSignal: 'Public roles monitored.' },
    rankings: { categoryRank: 20 },
    signals: { demoSeed: true },
    momentum: { momentum: null, reason: 'below-signal-threshold' },
  };
}

// Fictitious names, each as long as a real competitor name would be, so every
// section keeps a realistic size.
export const REPORT_COMPETITORS = [
  'Northwind Carbon',
  'QX Advisory Services',
  '7Meters Labs',
  'KTV Partners',
  'Halloway Group',
  'Carbon Vault Co',
  'Quorl',
  'Moravia Labs',
  'QFT Advisory',
  'Brightly One',
  'Aurelaris',
  'Riverbend Climate',
  'Sylvane Data',
  'Bainbridge',
  'ClimateAnchors Plus',
  'Gridimpacts',
  'QRS Global',
  'Aerofilter Air',
  'Zed Climate',
  'TLX Institute',
];

/** A competitor section of realistic size (3.4-5.4 KB). */
function competitorSection(name: string, i: number): string {
  const lines = [`## ${name}`];
  lines.push(`**Site:** https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example/`);
  lines.push(`**Momentum:** ${10 + i}/100 (12 pages analyzed)`);
  lines.push('**Pricing:** No public pricing tiers found: Custom (via web search)');
  lines.push('');
  lines.push('**Strengths**');
  const bullets = 11 + (i % 7);
  for (let b = 0; b < bullets; b++) lines.push(`- ${name} ${sentence(i + b, 26)} [${b + 1}]`);
  lines.push('');
  lines.push('**Key findings**');
  for (let b = 0; b < 4; b++) lines.push(`- ${sentence(i * 3 + b, 30)}`);
  lines.push('');
  return lines.join('\n');
}

/** A report's agent Markdown at realistic scale (~114 KB, 20 competitors). */
export function twentyCompetitorReportMarkdown(): string {
  const parts: string[] = [];
  parts.push(
    [
      '# Rivalize Competitive Intelligence Report',
      '',
      `This is a **Rivalize** report prepared for **carbon-co** on their competitors **${REPORT_COMPETITORS.join(', ')}**.`,
      '',
      '**Generated:** October 1, 2026 (today)  ',
      '**Grounding:** findings are pulled from real sources, not generated',
      '',
      "> Why this beats a one-shot research report: it's **fresh**, **broad**, and **actionable**.",
      '',
      '## TL;DR',
      `carbon-co's biggest measured threat: ${REPORT_COMPETITORS[11]} fields 400 employees.`,
      '',
      '## Biggest threat',
      `${REPORT_COMPETITORS[11]} fields 400 employees.`,
      '',
      '## Your blind spots',
      '- No owned content / blog presence was found for you; 11 of 16 rivals measured there are active.',
      '',
      '---',
      '',
    ].join('\n'),
  );
  REPORT_COMPETITORS.forEach((name, i) => {
    parts.push(competitorSection(name, i));
  });
  parts.push('## Battlecards (sales-ready, every claim cited)\n');
  REPORT_COMPETITORS.slice(0, 15).forEach((name, i) => {
    const lines = [`### vs ${name}`];
    for (let b = 0; b < 4 + (i % 10); b++)
      lines.push(`- Why we win: ${sentence(i + b, 24)} [${b + 1}]`);
    lines.push('');
    parts.push(lines.join('\n'));
  });
  parts.push('## What carbon-co should do\n- Publish one creator-voice post.\n');
  parts.push(`## Ask Rivalize to go deeper\n${sentence(2, 120)}\n`);
  return parts.join('\n');
}
