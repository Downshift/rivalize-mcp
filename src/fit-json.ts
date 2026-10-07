/**
 * Fit a JSON tool response under the character limit WITHOUT lying about it.
 *
 * Two naive approaches both mislead an agent. Halving `data` arrays while
 * leaving `pagination` at the requested limit makes `list_universe_companies
 * {limit:100}` return 10 rows that read `pagination.limit: 100`, so an agent
 * paging `offset += limit` skips 90 rows. Hard-cutting an object that cannot
 * be halved returns invalid JSON that is missing half its layers.
 *
 * Here: output is compact. A list keeps the longest prefix of rows that fits
 * and states `returned`, `total` and `next_offset` (the offset of the first row
 * NOT shown), and `pagination.limit` is corrected to what came back. An object
 * first has long arrays capped (each cap recorded in `_capped` with kept/total),
 * then loses whole fields, largest first, each listed in `_omitted` with its
 * size and the call that fetches it. The result is always valid JSON.
 */

import { CHARACTER_LIMIT } from './markdown-pages.js';

export interface FitOptions {
  limit?: number;
  /** The tool call that fetches a field `fitJson` had to leave out. */
  omitHint?: (field: string) => string;
  /** How to narrow the request, appended to the truncation message. */
  narrowHint?: string;
  /** Fields never dropped (identity of the thing being returned). */
  protectedKeys?: string[];
}

export interface FitResult {
  text: string;
  structured?: Record<string, unknown>;
}

type Dict = Record<string, unknown>;

interface Pagination {
  total: number;
  offset: number;
  limit?: number;
  [k: string]: unknown;
}

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPagination(v: unknown): v is Pagination {
  return isDict(v) && typeof v.total === 'number' && typeof v.offset === 'number';
}

const size = (v: unknown) => JSON.stringify(v).length;

/**
 * A list response from a server that does not page (no `pagination`): apply
 * limit/offset locally so the agent can still walk it. A server that pages is
 * taken as served.
 */
export function normalizeListPage(res: Dict, args: { limit?: number; offset?: number }): Dict {
  if (isPagination(res.pagination) || !Array.isArray(res.data)) return res;
  const rows = res.data;
  const offset = args.offset ?? 0;
  const data =
    args.limit !== undefined ? rows.slice(offset, offset + args.limit) : rows.slice(offset);
  return {
    ...res,
    data,
    pagination: { total: rows.length, limit: args.limit ?? data.length, offset },
  };
}

/** Add `returned` and `next_offset` to a paged list (null when nothing follows). */
function withPagingFields(out: Dict): Dict {
  if (!(Array.isArray(out.data) && isPagination(out.pagination))) return out;
  const p = out.pagination;
  const returned = out.data.length;
  const next = p.offset + returned;
  return {
    ...out,
    pagination: { ...p, returned, next_offset: next < p.total ? next : null },
  };
}

function fitList(out: Dict, limit: number, opts: FitOptions): FitResult {
  const rows = out.data as unknown[];
  const p = isPagination(out.pagination) ? out.pagination : null;
  const offset = p?.offset ?? 0;
  const total = p?.total ?? rows.length;
  const build = (n: number): Dict => {
    const next = offset + n;
    const message = `Response exceeded ${limit} characters, so ${n} of the ${rows.length} rows fetched are shown (${total} in total). Continue with offset=${next}: it resumes exactly at the first row not shown.${opts.narrowHint ? ` ${opts.narrowHint}` : ''}`;
    const reduced: Dict = { _truncated: true, _truncation_message: message, ...out };
    reduced.data = rows.slice(0, n);
    if (p) {
      reduced.pagination = {
        ...p,
        limit: n,
        requested_limit: p.limit ?? rows.length,
        returned: n,
        next_offset: next,
      };
    } else {
      reduced.returned = n;
      reduced.total = rows.length;
      reduced.next_offset = n;
    }
    return reduced;
  };
  // Largest prefix that fits (size is monotone in n).
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(build(mid)) <= limit) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0 && rows.length > 0) {
    // Even one row is too big: reduce that row like an object.
    const one = build(1);
    const row = rows[0];
    if (isDict(row)) {
      const budget = limit - (size(one) - size(row)) - 200;
      const r = reduceObject(row, budget, opts);
      one.data = [r.value];
      if (r.capped.length || r.omitted.length)
        one._row_reduced = { capped: r.capped, omitted: r.omitted };
      if (size(one) <= limit) return { text: JSON.stringify(one), structured: one };
    }
    const none = build(0);
    return { text: JSON.stringify(none), structured: none };
  }
  const reduced = build(lo);
  return { text: JSON.stringify(reduced), structured: reduced };
}

interface Reduction {
  value: Dict;
  capped: Array<{ path: string; kept: number; total: number }>;
  omitted: Array<{ field: string; chars: number; call?: string }>;
}

const ARRAY_CAP = 10;

function capArrays(
  value: unknown,
  path: string,
  depth: number,
  capped: Reduction['capped'],
): unknown {
  if (Array.isArray(value)) {
    const kept = value.length > ARRAY_CAP ? value.slice(0, ARRAY_CAP) : value;
    if (kept.length < value.length) capped.push({ path, kept: kept.length, total: value.length });
    return depth < 4 ? kept.map((v, i) => capArrays(v, `${path}[${i}]`, depth + 1, capped)) : kept;
  }
  if (isDict(value) && depth < 4) {
    const out: Dict = {};
    for (const [k, v] of Object.entries(value))
      out[k] = capArrays(v, path ? `${path}.${k}` : k, depth + 1, capped);
    return out;
  }
  return value;
}

/** Cap long arrays, then drop whole fields (largest first) until `value` fits `budget`. */
function reduceObject(value: Dict, budget: number, opts: FitOptions): Reduction {
  const capped: Reduction['capped'] = [];
  const omitted: Reduction['omitted'] = [];
  let v = value;
  if (size(v) > budget) v = capArrays(v, '', 0, capped) as Dict;
  const protectedKeys = new Set(opts.protectedKeys ?? []);
  while (size(v) > budget) {
    const candidates = Object.entries(v)
      .filter(([k]) => !protectedKeys.has(k))
      .map(([k, x]) => [k, size(x)] as const)
      .sort((a, b) => b[1] - a[1]);
    if (candidates.length === 0) break;
    const [field, chars] = candidates[0];
    const { [field]: _dropped, ...rest } = v;
    v = rest;
    omitted.push({ field, chars, ...(opts.omitHint ? { call: opts.omitHint(field) } : {}) });
  }
  return { value: v, capped, omitted };
}

function fitObject(out: Dict, limit: number, opts: FitOptions): FitResult {
  const nested = isDict(out.data);
  const target = (nested ? out.data : out) as Dict;
  const wrapperChars = nested ? size(out) - size(target) : 0;
  // Leave room for the markers this function adds.
  const budget = limit - wrapperChars - 2_000;
  const r = reduceObject(target, budget, opts);
  const priorCapped = isDict(out._capped) ? out._capped : {};
  const cappedMap: Dict = { ...priorCapped };
  // Paths are relative to `data` when the payload is `{ data: {...} }`.
  for (const c of r.capped) cappedMap[c.path] = { kept: c.kept, total: c.total };
  const parts = [`Response exceeded ${limit} characters. Nothing was cut mid-value:`];
  if (r.capped.length) parts.push('long arrays were capped (see _capped for kept/total);');
  if (r.omitted.length)
    parts.push(
      'whole fields were left out and are listed in _omitted with the call that fetches each;',
    );
  if (opts.narrowHint) parts.push(opts.narrowHint);
  const { _capped: _c, ...outRest } = out;
  const reduced: Dict = {
    _truncated: true,
    _truncation_message: parts.join(' '),
    ...(Object.keys(cappedMap).length ? { _capped: cappedMap } : {}),
    ...(r.omitted.length ? { _omitted: r.omitted } : {}),
    ...(nested ? { ...outRest, data: r.value } : r.value),
  };
  return { text: JSON.stringify(reduced), structured: reduced };
}

export function fitJson(output: Dict, opts: FitOptions = {}): FitResult {
  const limit = opts.limit ?? CHARACTER_LIMIT;
  const out = withPagingFields(output);
  const text = JSON.stringify(out);
  if (text.length <= limit) return { text, structured: out };
  return Array.isArray(out.data) ? fitList(out, limit, opts) : fitObject(out, limit, opts);
}
