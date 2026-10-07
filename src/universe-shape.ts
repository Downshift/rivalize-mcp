/**
 * Shaping universe payloads for an agent's context.
 *
 * LIST rows: the API row carries ids, slugs, URLs and a timestamp per layer;
 * an agent choosing a company needs far less. A full v1 list row is around 800
 * characters compact; the slim row here keeps domain, name, category, priority,
 * which layers are populated and when, and a short description, so 50 rows fit
 * one response.
 *
 * DETAIL: a well-covered company's profile can exceed 30,000 characters
 * compact, nearly half of it in `socialInfluencers.recentPosts`, and a profile
 * can carry dozens of near-identical `identity.sources`. Long arrays are
 * capped (sources de-duplicated first) and every cap is recorded with
 * kept/total, so nothing disappears silently.
 * `layers` returns only the named layers, with higher caps.
 */

/** Tool-facing layer name → key in the GET /v1/universe/companies/:domain payload. */
export const UNIVERSE_LAYER_KEYS = {
  identity: 'identity',
  pricing: 'pricing',
  features: 'features',
  ads: 'ads',
  social: 'socialInfluencers',
  reviews: 'reviews',
  funding_hiring: 'fundingHiring',
  rankings: 'rankings',
  signals: 'signals',
  momentum: 'momentum',
} as const;

export type UniverseLayerName = keyof typeof UNIVERSE_LAYER_KEYS;

export const UNIVERSE_LAYER_NAMES = Object.keys(UNIVERSE_LAYER_KEYS) as UniverseLayerName[];

const LAYER_PAYLOAD_KEYS = new Set<string>(Object.values(UNIVERSE_LAYER_KEYS));

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function day(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

const DESCRIPTION_MAX = 120;

function shortText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The fields an agent needs to choose a company from a list. */
export function slimUniverseListRow(row: unknown): Dict {
  if (!isDict(row)) return {};
  const freshness = isDict(row.layerFreshness) ? row.layerFreshness : {};
  const dates = Object.values(freshness)
    .map(day)
    .filter((d): d is string => d !== null)
    .sort();
  const categories = Array.isArray(row.categories)
    ? row.categories
        .map((c) => (isDict(c) && typeof c.slug === 'string' ? c.slug : null))
        .filter((s): s is string => s !== null)
    : [];
  return {
    domain: row.domain,
    name: row.name,
    primaryCategory: row.primaryCategory ?? null,
    categories,
    priorityScore: row.priorityScore ?? null,
    lastEnrichedAt: day(row.lastEnrichedAt),
    layers: Object.keys(freshness),
    layersUpdated:
      dates.length === 0
        ? null
        : dates[0] === dates[dates.length - 1]
          ? dates[0]
          : `${dates[0]} to ${dates[dates.length - 1]}`,
    description: shortText(row.description, DESCRIPTION_MAX),
  };
}

export interface CapRecord {
  kept: number;
  total: number;
  /** Distinct entries after de-duplication, when that is what shrank it. */
  distinct?: number;
}

export interface ShapedCompany {
  data: Dict;
  capped: Record<string, CapRecord>;
}

function sourceKey(v: unknown): string {
  if (!isDict(v)) return JSON.stringify(v);
  return JSON.stringify([v.url ?? v.sourceUrl ?? null, v.source ?? null, v.quote ?? null]);
}

function capValue(
  value: unknown,
  key: string,
  path: string,
  depth: number,
  caps: { array: number; sources: number },
  capped: Record<string, CapRecord>,
): unknown {
  if (Array.isArray(value)) {
    let arr = value;
    let distinct: number | undefined;
    if (key === 'sources') {
      const seen = new Set<string>();
      arr = value.filter((v) => {
        const k = sourceKey(v);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (arr.length < value.length) distinct = arr.length;
    }
    const cap = key === 'sources' ? caps.sources : caps.array;
    const kept = arr.slice(0, cap);
    if (kept.length < value.length)
      capped[path] = {
        kept: kept.length,
        total: value.length,
        ...(distinct !== undefined ? { distinct } : {}),
      };
    return kept;
  }
  if (isDict(value) && depth < 3) {
    const out: Dict = {};
    for (const [k, v] of Object.entries(value))
      out[k] = capValue(v, k, `${path}.${k}`, depth + 1, caps, capped);
    return out;
  }
  return value;
}

/**
 * The universe profile with long arrays capped and, when `layers` is given,
 * only those layers (plus the identifying fields, which are never layers).
 */
export function shapeUniverseCompany(
  company: Dict,
  opts: { layers?: UniverseLayerName[] } = {},
): ShapedCompany {
  const wanted = opts.layers?.length
    ? new Set<string>(opts.layers.map((l) => UNIVERSE_LAYER_KEYS[l]))
    : null;
  const caps = wanted ? { array: 20, sources: 10 } : { array: 5, sources: 3 };
  const capped: Record<string, CapRecord> = {};
  const data: Dict = {};
  for (const [k, v] of Object.entries(company)) {
    if (wanted && LAYER_PAYLOAD_KEYS.has(k) && !wanted.has(k)) continue;
    data[k] = capValue(v, k, k, 0, caps, capped);
  }
  return { data, capped };
}

/** `https://www.Example.com/pricing` → `example.com`. */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^[^@/]*@/, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, '').replace(/\.$/, '');
  return s.replace(/^www\./, '');
}
