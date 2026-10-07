/**
 * Unit tests for the Markdown pager and the JSON fitter. The tool-level
 * behaviour is in tools.responses.test.ts; these pin the edge cases the tools
 * cannot easily reach.
 */

import { describe, expect, it } from 'vitest';
import { fitJson } from './fit-json.js';
import { CHARACTER_LIMIT, paginateMarkdown, selectSections } from './markdown-pages.js';

const next = (p: number) => `get_report {"report_id":"r","page":${p}}`;
const BODY = '\n\n<!-- page-body -->\n';

describe('paginateMarkdown', () => {
  it('a single section larger than a page is split at paragraph/line boundaries, losslessly', () => {
    const big = `# T\n\n## Huge\n${Array.from({ length: 2000 }, (_, i) => `- line ${i} ${'z'.repeat(30)}`).join('\n')}\n`;
    const first = paginateMarkdown(big, { nextCall: next, what: 'report' });
    expect(first.pages).toBeGreaterThan(2);
    let joined = '';
    for (let p = 1; p <= first.pages; p++) {
      const r = paginateMarkdown(big, { page: p, nextCall: next, what: 'report' });
      expect(r.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
      joined += r.text.slice(r.text.indexOf(BODY) + BODY.length);
    }
    expect(joined).toBe(big);
    // A continued section is named as such in the table of contents.
    expect(first.text).toContain('Huge (continued)');
  });

  it('one enormous line with no break is still cut into pages that add back up', () => {
    const big = 'x'.repeat(60_000);
    const first = paginateMarkdown(big, { nextCall: next, what: 'report' });
    let joined = '';
    for (let p = 1; p <= first.pages; p++) {
      const r = paginateMarkdown(big, { page: p, nextCall: next, what: 'report' });
      expect(r.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
      joined += r.text.slice(r.text.indexOf(BODY) + BODY.length);
    }
    expect(joined).toBe(big);
  });

  it('headings inside a code fence do not split a section', () => {
    const md = `## A\n\`\`\`\n## not a heading\n\`\`\`\n## B\ntext`;
    const sel = selectSections(md, 'A');
    expect(sel.md).toContain('## not a heading');
    expect(sel.md).not.toContain('## B');
  });
});

describe('selectSections', () => {
  const md =
    '# Report\n\nintro\n\n## Bain\nb\n\n## Bain Capital\nbc\n\n## Bainbridge\nbb\n\n## Battlecards\n\n### vs Bain\nvb\n\n### vs Bain Capital\nvbc\n';

  it('an exact heading match wins over a whole-word match (Bain is not Bain Capital)', () => {
    const sel = selectSections(md, 'bain');
    expect(sel.matched).toEqual(['Bain', 'vs Bain']);
    expect(sel.md).toContain('## Bain\nb');
    expect(sel.md).toContain('### vs Bain\nvb');
    expect(sel.md).not.toContain('Bain Capital');
    expect(sel.md).not.toContain('Bainbridge');
    expect(sel.md.startsWith('# Report\n\nintro')).toBe(true);
  });

  it('with no exact match, a whole-word match counts and a prefix does not', () => {
    const sel = selectSections(md, 'capital');
    expect(sel.matched).toEqual(['Bain Capital', 'vs Bain Capital']);
    expect(selectSections(md, 'bainb').matched).toEqual([]);
  });

  it('available lists the section headings', () => {
    expect(selectSections(md, 'zzz').available).toEqual(
      expect.arrayContaining(['Bain', 'Bainbridge', 'Battlecards']),
    );
  });
});

describe('fitJson', () => {
  it('an under-limit payload is returned whole and compact', () => {
    const out = { data: { a: 1, b: [1, 2] } };
    const r = fitJson(out);
    expect(r.text).toBe(JSON.stringify(out));
    expect(r.structured).toEqual(out);
  });

  it('never cuts JSON mid-stream: a 60 KB single field is dropped and listed', () => {
    const r = fitJson({ data: { domain: 'x.co', blob: 'x'.repeat(60_000) } });
    expect(r.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    const parsed = JSON.parse(r.text);
    expect(parsed.data.domain).toBe('x.co');
    expect(parsed.data.blob).toBeUndefined();
    expect(parsed._omitted[0]).toMatchObject({ field: 'blob' });
    expect(parsed._omitted[0].chars).toBeGreaterThan(60_000);
  });

  it('a list with no pagination still says how many rows it returned of how many', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, blob: 'q'.repeat(400) }));
    const parsed = JSON.parse(fitJson({ data: rows }).text);
    expect(parsed._truncated).toBe(true);
    expect(parsed.returned).toBe(parsed.data.length);
    expect(parsed.total).toBe(200);
    expect(parsed.next_offset).toBe(parsed.data.length);
  });
});
