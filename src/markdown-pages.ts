/**
 * Paging for the long Markdown documents the tools return.
 *
 * A 20-competitor report is ~116,000 characters. Cutting it at 25,000 would end
 * inside the sixth competitor, so ~15 of 20 competitor sections would never
 * reach the agent and it would have no way to ask for them. Instead a long
 * document is split into pages at heading boundaries (falling back to
 * paragraph, then line, then character boundaries for a single oversized
 * section). Every page is under the limit, carries a header naming
 * its position, what remains and the exact next call, and lists the sections on
 * later pages. Page bodies are exact contiguous slices of the document, so the
 * pages concatenate back to the original byte for byte. A document under the
 * limit is returned unchanged, with no header.
 */

export const CHARACTER_LIMIT = 25_000;

/** Separates a page header from the page body (an HTML comment: invisible when rendered). */
export const PAGE_BODY_MARKER = '\n\n<!-- page-body -->\n';

export interface PageOptions {
  /** 1-based page; defaults to 1. */
  page?: number;
  limit?: number;
  /** The exact tool call that returns a given page. */
  nextCall: (page: number) => string;
  /** What the document is, for the header ("report", "timeline"). */
  what: string;
}

export interface PageResult {
  text: string;
  page: number;
  pages: number;
  isError?: boolean;
}

interface Heading {
  pos: number;
  level: number;
  title: string;
}

/** Headings outside fenced code blocks, with their character offsets. */
function scanHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let pos = 0;
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    } else if (fence === null) {
      const h = /^(#{1,6})[ \t]+(.+?)[ \t#]*\r?$/.exec(line);
      if (h) out.push({ pos, level: h[1].length, title: cleanTitle(h[2]) });
    }
    pos += line.length + 1;
  }
  return out;
}

function cleanTitle(raw: string): string {
  return raw.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

interface Piece {
  start: number;
  end: number;
  /** TOC label for the section this piece starts (null for preamble/plain text). */
  label: string | null;
}

/** Cut [start, end) into pieces no longer than `budget`, at the gentlest boundary available. */
function splitRange(md: string, start: number, end: number, budget: number): number[] {
  const cuts: number[] = [];
  let at = start;
  while (end - at > budget) {
    const window = md.slice(at, at + budget);
    let cut = window.lastIndexOf('\n\n');
    if (cut > budget / 4) cut += 2;
    else {
      cut = window.lastIndexOf('\n');
      if (cut > budget / 4) cut += 1;
      else cut = budget;
    }
    at += cut;
    cuts.push(at);
  }
  return cuts;
}

function buildPieces(md: string, budget: number): Piece[] {
  const headings = scanHeadings(md);
  const bounds: Array<{ pos: number; label: string | null }> = [{ pos: 0, label: null }];
  for (const h of headings) {
    if (h.pos === 0) {
      bounds[0].label = h.level <= 3 ? h.title : null;
      continue;
    }
    bounds.push({ pos: h.pos, label: h.level <= 3 ? h.title : null });
  }
  const pieces: Piece[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i].pos;
    const end = i + 1 < bounds.length ? bounds[i + 1].pos : md.length;
    if (end <= start) continue;
    const cuts = splitRange(md, start, end, budget);
    let s = start;
    let label = bounds[i].label;
    for (const c of [...cuts, end]) {
      pieces.push({ start: s, end: c, label });
      s = c;
      label = bounds[i].label ? `${bounds[i].label} (continued)` : null;
    }
  }
  return pieces;
}

interface Page {
  start: number;
  end: number;
  labels: string[];
}

function packPages(pieces: Piece[], budget: number): Page[] {
  const pages: Page[] = [];
  let cur: Page | null = null;
  for (const p of pieces) {
    if (cur && p.end - cur.start > budget) {
      pages.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: p.start, end: p.end, labels: [] };
    cur.end = p.end;
    if (p.label) cur.labels.push(p.label);
  }
  if (cur) pages.push(cur);
  return pages;
}

const fmt = (n: number) => n.toLocaleString('en-US');
const TOC_MAX = 2_500;

function header(pages: Page[], n: number, total: number, opts: PageOptions): string {
  const m = pages.length;
  const page = pages[n - 1];
  const range = `characters ${fmt(page.start + 1)}–${fmt(page.end)} of ${fmt(total)}`;
  if (n === m) {
    return `> **Page ${n} of ${m}** of this ${opts.what} (last page): ${range}. Earlier pages: call ${opts.nextCall(1)} and so on.`;
  }
  const remaining = total - page.end;
  const where = n + 1 === m ? `page ${m}` : `pages ${n + 1}–${m}`;
  const lines = [
    `> **Page ${n} of ${m}** of this ${opts.what}: ${range}; ${fmt(remaining)} characters remain on ${where}.`,
    `> Next: call ${opts.nextCall(n + 1)}`,
  ];
  let toc = '';
  for (let p = n + 1; p <= m; p++) {
    const labels = pages[p - 1].labels;
    const entry = `> p${p}: ${labels.length ? labels.join('; ') : '(continuation)'}`;
    if (toc.length + entry.length > TOC_MAX) {
      toc += `\n> … and pages up to ${m}`;
      break;
    }
    toc += `\n${entry}`;
  }
  lines.push(`> Sections on later pages:${toc}`);
  return lines.join('\n');
}

export function paginateMarkdown(md: string, opts: PageOptions): PageResult {
  const limit = opts.limit ?? CHARACTER_LIMIT;
  const want = opts.page ?? 1;
  if (md.length <= limit) {
    if (want === 1) return { text: md, page: 1, pages: 1 };
    return {
      text: `Page ${want} does not exist: this ${opts.what} has 1 page. Call ${opts.nextCall(1)}.`,
      page: want,
      pages: 1,
      isError: true,
    };
  }

  // Pack with a budget that leaves room for the header, then verify every
  // rendered page; tighten and repack in the rare case a header outgrew it.
  let budget = limit - (TOC_MAX + 600 + PAGE_BODY_MARKER.length);
  for (let attempt = 0; attempt < 8; attempt++) {
    const pages = packPages(buildPieces(md, budget), budget);
    const rendered = pages.map(
      (p, i) =>
        `${header(pages, i + 1, md.length, opts)}${PAGE_BODY_MARKER}${md.slice(p.start, p.end)}`,
    );
    const over = Math.max(...rendered.map((t) => t.length - limit));
    if (over <= 0) {
      if (want > pages.length) {
        return {
          text: `Page ${want} does not exist: this ${opts.what} has ${pages.length} pages. Call ${opts.nextCall(1)} to start.`,
          page: want,
          pages: pages.length,
          isError: true,
        };
      }
      return { text: rendered[want - 1], page: want, pages: pages.length };
    }
    budget -= over + 100;
  }
  throw new Error('paginateMarkdown: could not fit pages under the limit');
}

export interface SectionSelection {
  md: string;
  matched: string[];
  available: string[];
}

function normalizeHeading(title: string): string {
  return title
    .toLowerCase()
    .replace(/^vs\.?\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The sections whose heading names `query` (case-insensitive; "vs <name>"
 * battlecard headings count), each with its sub-sections, preceded by the
 * document's preamble (title, generation date). An exact heading match wins;
 * only when there is none does a whole-word match count, so "Bain" never
 * selects "Bainbridge".
 */
export function selectSections(md: string, query: string): SectionSelection {
  const headings = scanHeadings(md);
  const q = normalizeHeading(query);
  const available = headings.filter((h) => h.level === 2).map((h) => h.title);
  let hits = headings.filter((h) => normalizeHeading(h.title) === q);
  if (hits.length === 0 && q) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(q)}($|[^a-z0-9])`);
    hits = headings.filter((h) => re.test(normalizeHeading(h.title)));
  }
  if (hits.length === 0) return { md: '', matched: [], available };

  const firstSection = headings.find((h) => h.level >= 2);
  const preamble = md.slice(0, firstSection ? firstSection.pos : md.length).trimEnd();
  const ranges: Array<[number, number]> = [];
  for (const h of hits) {
    const after = headings.find((x) => x.pos > h.pos && x.level <= h.level);
    const range: [number, number] = [h.pos, after ? after.pos : md.length];
    const last = ranges[ranges.length - 1];
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push(range);
  }
  const body = ranges.map(([s, e]) => md.slice(s, e).trimEnd()).join('\n\n');
  return {
    md: preamble ? `${preamble}\n\n${body}\n` : `${body}\n`,
    matched: hits.map((h) => h.title),
    available,
  };
}
