/**
 * Competitor teardown: render a universe company profile as a single framed
 * Markdown teardown for an agent. Not just their ads but their whole playbook
 * (positioning, pricing, ads, social, reviews, hiring, momentum), all
 * source-backed and dated, plus weaknesses to attack.
 *
 * Defensive by construction: any layer may be absent/thin (a competitor not yet
 * deeply enriched), so every field is guarded and the doc degrades gracefully.
 *
 * Reads the keys GET /v1/universe/companies/:domain actually returns: `ads`,
 * `socialInfluencers`, `reviews`, `fundingHiring`, `features.positioning`.
 * Reading a key the payload does not carry would make a section silently
 * disappear, and worse, make an absence branch assert "no active paid ads" for
 * a company that advertises. Numbers are formatted as the Rivalize dashboard
 * formats them, so the agent and the dashboard read the same figures.
 */

type Dict = Record<string, unknown>;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Stored crawl text carries HTML entities and inline tags ("that&#x27;s",
 * "<strong>"). Decode the entities and drop simple inline tags so the
 * Markdown reads as the page did.
 */
function decodeHtml(s: string): string {
  return s
    .replace(/<\/?(?:strong|b|em|i|span|br)\b[^>]*>/gi, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code =
          e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function str(v: unknown): string {
  if (typeof v === 'string') return decodeHtml(v).trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v))
    return v
      .filter((x) => typeof x === 'string')
      .join(' ')
      .trim();
  return '';
}
function obj(v: unknown): Dict {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function strList(v: unknown): string[] {
  return list(v).map(str).filter(Boolean);
}
/**
 * A number from the payload, or null when there is none. `Number(null)` is 0,
 * so a naive conversion would print an unscored momentum (`momentum: null`) as
 * "Momentum: 0/100" and generate a "Low momentum" weakness. Only a number or a
 * numeric string is a measurement.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const DAY_MS = 86_400_000;
/** An ad counts as active only if it was seen within this window. */
const ACTIVE_AD_WINDOW_DAYS = 30;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * `features.positioning[0]` is often the page <title> ("Home \ Example Co"),
 * which is not positioning and certainly not a hook. A short line that starts
 * with Home/Welcome, or whose separator-delimited parts include the company
 * name or domain, is a page title.
 */
function isPageTitle(line: string, name: string, domain: string): boolean {
  if (line.length > 90) return false;
  if (/^(home|homepage|welcome)\b/i.test(line)) return true;
  const parts = line.split(/\s+[\\|–—·:-]\s+|\s*[\\|]\s*/).map((p) => p.trim().toLowerCase());
  if (parts.length < 2) return false;
  const keys = [
    name.toLowerCase(),
    domain.toLowerCase(),
    domain.toLowerCase().split('.')[0],
  ].filter(Boolean);
  return parts.some((p) => keys.includes(p));
}
/** A count as the dashboard shows it: `14,595`, not `14.6K`. */
function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}
/**
 * Parse a timestamp as the API may send it: ISO 8601, or Postgres's text form
 * `2026-06-11 05:26:05.162+00`. A plain `.replace(' ', 'T')` turns the latter
 * into `…T…+00`, which is not ISO and parses as Invalid Date, so "Last
 * refreshed" would silently vanish from the teardown.
 */
function parseTimestamp(s: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(
    s,
  );
  const d = m ? new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? '00'}`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysAgo(iso: unknown, nowMs: number): string {
  const s = str(iso);
  if (!s) return '';
  const d = parseTimestamp(s);
  if (!d) return '';
  const days = Math.max(0, Math.floor((nowMs - d.getTime()) / 86_400_000));
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}
function bullets(items: string[], max = 8): string {
  return items
    .slice(0, max)
    .map((i) => `- ${i}`)
    .join('\n');
}

export interface TeardownOptions {
  nowMs: number;
  origin?: string;
  /** Whether the add_competitor tool is registered (writes enabled). Default false. */
  canAddCompetitor?: boolean;
}

/**
 * Render a universe company object (the shape returned by
 * GET /v1/universe/companies/:domain) as an agent-ready teardown.
 */
/**
 * How to get a company enriched. Names add_competitor only when that tool is
 * registered: pointing an agent at a tool it does not have sends it looking for
 * one (writes are off by default).
 */
export function enrichmentHint(canAddCompetitor = false): string {
  return canAddCompetitor
    ? 'Use add_competitor to queue enrichment, then re-run this teardown.'
    : 'Add it as a competitor in your Rivalize dashboard to queue enrichment, then re-run this teardown.';
}

export function renderTeardown(company: Dict, opts: TeardownOptions): string {
  const origin = (opts.origin || 'https://rivalize.ai').replace(/\/$/, '');
  const name = str(company.name) || str(obj(company.identity).companyName) || str(company.domain);
  const domain = str(company.domain);
  const out: string[] = [];
  const weaknesses: string[] = [];

  // Absence-derived claims ("no public pricing", "no active ads") are only
  // honest when Rivalize actually looked. A profile counts as
  // enriched when it carries enrichment evidence — lastEnrichedAt or any
  // per-layer freshness marker. Never-enriched profiles ABSTAIN: layer absence
  // means "not yet gathered", not a competitive weakness. Weaknesses derived
  // from MEASURED data (e.g. a low momentum score present in the payload)
  // still render regardless.
  const enriched =
    Boolean(str(company.lastEnrichedAt)) || Object.keys(obj(company.layerFreshness)).length > 0;

  // ---- Header + freshness ----
  out.push(`# Competitor Teardown — ${name}`);
  out.push('');
  const desc = str(company.description);
  if (desc) out.push(desc);
  out.push('');
  const meta: string[] = [];
  const industry = str(obj(company.identity).industry);
  if (industry) meta.push(`**Industry:** ${industry}`);
  if (domain) meta.push(`**Site:** ${domain}`);
  const refreshed = daysAgo(company.lastEnrichedAt, opts.nowMs);
  if (refreshed) meta.push(`**Last refreshed:** ${refreshed}`);
  out.push(meta.join('  \n'));
  out.push('');
  out.push(
    `> Everything Rivalize has observed on ${name} — positioning, pricing, ads, social, reviews, hiring, momentum. Source-backed and continuously monitored, not a one-shot guess.`,
  );
  if (!enriched) {
    out.push('');
    out.push(
      `> **Not yet enriched.** Rivalize has not gathered layer data (pricing, ads, social, reviews, hiring) for ${name} yet — missing sections mean "not yet checked", not observed gaps. ${enrichmentHint(opts.canAddCompetitor)}`,
    );
  }
  // A profile seeded for demonstration must not read as observed data.
  // The universe API marks such a row `isDemo` and withholds its placeholders,
  // naming them in `demoWithheld`; older payloads carry only the seed markers.
  const demoSeed =
    company.isDemo === true ||
    obj(company.signals).demoSeed === true ||
    strList(company.sourceTags).includes('demo-snapshot');
  if (demoSeed) {
    const withheld = strList(company.demoWithheld);
    out.push('');
    out.push(
      `> **Includes demo seed data.** Parts of ${name}'s profile were seeded for demonstration, not observed by Rivalize's collectors; treat its figures as placeholders until the profile is re-enriched.${withheld.length ? ` Placeholder values withheld: ${withheld.join(', ')}.` : ''}`,
    );
  }

  // ---- Momentum ----
  const mom = obj(company.momentum);
  const score = num(mom.momentum);
  if (score === null && Object.keys(mom).length > 0) {
    // Unscored is not zero. Say so, and derive no weakness from it.
    const reason = str(mom.reason).replace(/[-_]+/g, ' ');
    out.push('');
    out.push(`## Momentum: not scored${reason ? ` (${reason})` : ''}`);
  }
  if (score !== null) {
    const delta = num(mom.delta);
    const signals = num(mom.signalCount);
    out.push('');
    out.push(
      `## Momentum: ${score}/100${delta !== null ? ` (${delta >= 0 ? '+' : ''}${delta} vs last)` : ''}${signals ? ` — ${signals} signals` : ''}`,
    );
    if (score < 30)
      weaknesses.push(`Low momentum (${score}/100) — they're not accelerating; a window to move.`);
  }

  // ---- Positioning (their hooks) ----
  const features = obj(company.features);
  const positioning = strList(features.positioning).filter((l) => !isPageTitle(l, name, domain));
  const themes = strList(features.themes);
  if (positioning.length || themes.length) {
    out.push('');
    out.push('## How they position');
    if (positioning.length) out.push(bullets(positioning));
    if (themes.length) out.push(`\n**Themes:**\n${bullets(themes)}`);
  }

  // ---- Pricing ----
  const plans = list(obj(company.pricing).plans);
  if (plans.length) {
    out.push('');
    out.push('## Their pricing');
    out.push(
      bullets(
        plans
          .map((p) => {
            const pl = obj(p);
            const n = str(pl.name);
            let price = str(pl.price) || str(pl.priceText);
            // The collector writes quote-based tiers as price "custom";
            // say what that means rather than dropping or mis-reading it.
            if (/^(custom|contact( sales| us)?|quote|on request)$/i.test(price))
              price = 'custom pricing (contact sales)';
            // The billing period, when the payload carries one.
            const period = str(pl.billingPeriod) || str(pl.period);
            const priced =
              price && period && !price.includes('custom') ? `${price} ${period}` : price;
            return [n, priced].filter(Boolean).join(' — ');
          })
          .filter(Boolean),
      ),
    );
  } else if (enriched && obj(company.pricing).hasPricingPage === false) {
    // Measured absence: the crawl looked for a pricing page and found none.
    // This is a fact about the crawl, not a claim about the company. No
    // extracted plans is NOT that fact: most of those companies have a pricing
    // page the extractor could not read into tiers.
    weaknesses.push(
      'No pricing page found on their site — check whether transparent pricing is a wedge.',
    );
  }

  // ---- Ads (the centerpiece) ----
  const ads = obj(company.ads);
  const activeAds = num(ads.activeAdCount);
  // The universe API serves a count it cannot place inside the 30-day window
  // as `activeAdCount: null`, keeping the number in `observedAdCount`.
  const observedAds = num(ads.observedAdCount);
  const creatives = list(ads.creatives);
  const adPlatforms = strList(ads.platforms);
  // The same "is advertising" predicate the universe API uses: ANY observed
  // signal counts.
  const advertising =
    ads.isAdvertising === true ||
    (activeAds ?? 0) > 0 ||
    (observedAds ?? 0) > 0 ||
    adPlatforms.length > 0 ||
    creatives.length > 0;
  if (advertising) {
    out.push('');
    out.push('## Their ads (what they are spending to test)');
    const adMeta: string[] = [];
    // The API marks a count that filled one results page as a lower bound
    // (`activeAdCountIsLowerBound`). It reads "at least 40", never "40":
    // there may be far more.
    const atLeast = ads.activeAdCountIsLowerBound === true ? 'at least ' : '';
    // "Active" means seen in the last 30 days. A creative last seen eleven
    // months ago must not be reported as "1 active ad(s)".
    const windowStart = opts.nowMs - ACTIVE_AD_WINDOW_DAYS * DAY_MS;
    const seenAt = (c: unknown) => parseTimestamp(str(obj(c).lastSeen));
    const dated = creatives.filter((c) => seenAt(c) !== null);
    const isRecent = (c: unknown) => (seenAt(c)?.getTime() ?? 0) >= windowStart;
    if (dated.length > 0) {
      const recent = dated.filter(isRecent);
      if (recent.length > 0) {
        adMeta.push(
          `${recent.length === activeAds ? atLeast : ''}${fmtCount(recent.length)} active ad(s) (seen in the last ${ACTIVE_AD_WINDOW_DAYS} days)`,
        );
      } else {
        const last = dated
          .map((c) => seenAt(c) as Date)
          .reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
        adMeta.push(
          `no ad seen in the last ${ACTIVE_AD_WINDOW_DAYS} days (last seen ${isoDay(last)})`,
        );
      }
    } else if ((activeAds ?? 0) > 0 || (activeAds === null && (observedAds ?? 0) > 0)) {
      // No per-ad dates: the count is as of the ads layer's last check.
      const count = (activeAds ?? observedAds) as number;
      const checked =
        parseTimestamp(str(obj(company.layerFreshness).ads)) ??
        parseTimestamp(str(company.lastEnrichedAt));
      if (activeAds === null || (checked && checked.getTime() < windowStart)) {
        adMeta.push(
          `${atLeast}${fmtCount(count)} ad(s) reported active when last checked${checked ? ` on ${isoDay(checked)} (${daysAgo(checked.toISOString(), opts.nowMs)})` : ''}; not re-checked in the last ${ACTIVE_AD_WINDOW_DAYS} days`,
        );
      } else {
        adMeta.push(`${atLeast}${fmtCount(count)} active ad(s)`);
      }
    }
    if (adPlatforms.length) adMeta.push(adPlatforms.join(', '));
    if (creatives.length) adMeta.push(`${fmtCount(creatives.length)} creatives observed`);
    if (adMeta.length) out.push(adMeta.join(' · '));
    // Hooks are AD COPY. Only creative text qualifies, and only from ads
    // still running when the creatives are dated; older copy is labelled.
    const copy = (c: unknown) => {
      const cc = obj(c);
      return str(cc.text) || str(cc.headline) || str(cc.body) || str(cc.caption);
    };
    const running = dated.length > 0 ? creatives.filter(isRecent) : creatives;
    const creativeLines = running.slice(0, 8).map(copy).filter(Boolean);
    if (creativeLines.length) out.push(`\n**Hooks they're running:**\n${bullets(creativeLines)}`);
    if (dated.length > 0) {
      const earlier = creatives
        .filter((c) => !isRecent(c))
        .slice(0, 4)
        .map(copy)
        .filter(Boolean);
      if (earlier.length)
        out.push(
          `\n**Ad copy seen earlier (not in the last ${ACTIVE_AD_WINDOW_DAYS} days):**\n${bullets(earlier)}`,
        );
    }
  } else if (enriched && Object.keys(ads).length > 0) {
    // Measured absence: the ads layer was collected and carries no signal.
    weaknesses.push(
      'No active paid ads detected — they may be under-investing in paid acquisition.',
    );
  }

  // ---- Social ----
  const social = obj(company.socialInfluencers);
  const followerCounts = obj(social.followerCounts);
  const postingFrequency = obj(social.postingFrequency);
  const followerLines = Object.entries(followerCounts)
    .map(([platform, n]) => [platform, num(n)] as const)
    .filter(([, n]) => n !== null && n > 0)
    .map(([platform, n]) => `${platform}: ${fmtCount(n as number)} followers`);
  const cadenceLines = Object.entries(postingFrequency)
    .map(([platform, f]) => (str(f) ? `${platform} ${str(f)}` : ''))
    .filter(Boolean);
  if (followerLines.length || cadenceLines.length) {
    out.push('');
    out.push('## Their social');
    const sMeta: string[] = [...followerLines];
    if (cadenceLines.length) sMeta.push(`posting: ${cadenceLines.join(', ')}`);
    out.push(sMeta.join(' · '));
    const posts = list(social.recentPosts)
      .slice(0, 4)
      .map((p) => str(obj(p).text))
      .filter(Boolean);
    if (posts.length) out.push(`\n**Recent posts:**\n${bullets(posts, 4)}`);
  }

  // ---- Reviews ----
  const reviews = obj(company.reviews);
  const appStore = obj(reviews.appStore);
  const themesR = strList(reviews.recentReviewThemes);
  const rating = num(appStore.rating);
  const reviewCount = num(appStore.reviewCount);
  if (rating !== null || themesR.length) {
    out.push('');
    out.push('## Reviews');
    // One decimal, as the dashboard shows it (a stored 3.22222 reads 3.2).
    if (rating !== null)
      out.push(
        `App Store: ${rating.toFixed(1)}★${reviewCount !== null ? ` (${fmtCount(reviewCount)} reviews)` : ''}`,
      );
    if (themesR.length) out.push(`\n**What customers say:**\n${bullets(themesR)}`);
  }

  // ---- Hiring ----
  const hiring = obj(company.fundingHiring);
  const openRoles = num(hiring.openRoles);
  if (openRoles) {
    out.push('');
    out.push(`## Hiring (where they're investing)`);
    out.push(
      `${openRoles} open role(s)${str(hiring.hiringVelocity) ? ` · ${str(hiring.hiringVelocity)}` : ''}`,
    );
  }

  // ---- Weaknesses to attack ----
  if (weaknesses.length) {
    out.push('');
    out.push('## Weaknesses to attack');
    out.push(bullets(weaknesses));
  }

  // ---- Drill down ----
  out.push('');
  out.push('---');
  out.push('');
  out.push('## Go deeper');
  // The route this MCP itself reads (the public route is a different,
  // reduced payload), on the configured origin.
  out.push(
    `Pull the full profile with get_universe_company {"domain":"${domain}"} (add "layers" for one layer in depth). It is the same data as \`GET ${origin}/api/v1/universe/companies/${domain}\` with your API key.`,
  );

  return out.join('\n');
}
