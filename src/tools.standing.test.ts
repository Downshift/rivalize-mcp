/**
 * `list_competitors` and a rival's standing.
 *
 * A server that returns `brief` on each competitor row may answer
 * `brief.state: "deferred"` for a row whose standing it has not read yet;
 * asking for the same page again fills it in. An agent rarely asks again, so
 * the tool does, a bounded number of times, and returns what is still
 * `deferred` after that as such. The API's fields pass through untouched: the
 * tool computes no standing of its own.
 *
 * A server that returns no `brief` must see exactly the earlier behaviour: one
 * request per call, and the rows returned as sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasDeferredRow, LIST_DEFERRED_RETRIES, LIST_DEFERRED_RETRY_MS, registerTools } from './tools.js';

type Result = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function harness(client: unknown, opts: Record<string, unknown> = { deferredRetryMs: 0 }) {
  const tools = new Map<string, { description: string; handler: Handler }>();
  const server = {
    registerTool(name: string, config: { description: string }, handler: Handler) {
      tools.set(name, { description: config.description, handler });
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes for the SDK server and client
  registerTools(server as any, client as any, opts as any);
  const entry = tools.get('list_competitors');
  if (!entry) throw new Error('list_competitors not registered');
  return entry;
}

const READ = {
  state: 'read',
  standing: 'ahead',
  standing_label: 'Ahead of you',
  standing_reason: 'They lead on 4, you lead on 1.',
  momentum_score: 38,
  momentum_band: 'high',
  momentum_reason: 'Activity score 38.',
  as_of: '2026-09-28T10:00:00.000Z',
  from_latest_run: false,
  reason: null,
};
const DEFERRED = { ...READ, state: 'deferred', standing: null, standing_label: null };

const row = (brief: unknown, threat = 'high', score: number | null = 38) => ({
  id: 'c1',
  name: 'Northwind Ledger',
  website: 'https://www.northwind-ledger.example/',
  threat_level: threat,
  momentum_score: score,
  brief,
});

const page = (brief: unknown, threat = 'high', score: number | null = 38) => ({
  data: [row(brief, threat, score)],
  pagination: { total: 1, limit: 100, offset: 0 },
});

/** Rows as a server without `brief` returns them. */
const LEGACY_ROWS = [
  {
    id: 'c1',
    project_id: 'p1',
    project_name: 'Ledgerly',
    name: 'Northwind Ledger',
    website: 'https://www.northwind-ledger.example/',
    threat_level: 'high',
    momentum_score: 38,
  },
  {
    id: 'c2',
    project_id: 'p1',
    project_name: 'Ledgerly',
    name: 'Fabrikam Books',
    website: 'https://fabrikam-books.example/',
    threat_level: 'unknown',
    momentum_score: null,
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('list_competitors and deferred rows', () => {
  it('asks the same page again while a row is deferred, and returns the settled page', async () => {
    const listCompetitors = vi
      .fn()
      .mockResolvedValueOnce(page(DEFERRED, 'unknown', null))
      .mockResolvedValueOnce(page(READ));
    const out = await harness({ listCompetitors }).handler({ project_id: 'p1', limit: 100, offset: 0 });

    expect(listCompetitors).toHaveBeenCalledTimes(2);
    for (const call of listCompetitors.mock.calls) {
      expect(call[0]).toEqual({ projectId: 'p1', limit: 100, offset: 0 });
    }
    const body = JSON.parse(out.content[0]?.text ?? 'null');
    expect(body.data[0].brief).toEqual(READ);
    expect(body.data[0].threat_level).toBe('high');
    expect(body.data[0].momentum_score).toBe(38);
  });

  it('a page with no deferred row is asked once', async () => {
    const listCompetitors = vi.fn().mockResolvedValue(page(READ));
    await harness({ listCompetitors }).handler({});
    expect(listCompetitors).toHaveBeenCalledTimes(1);
  });

  it('stops after a bounded number of asks and returns what is still deferred', async () => {
    const listCompetitors = vi.fn().mockResolvedValue(page(DEFERRED, 'unknown', null));
    const out = await harness({ listCompetitors }).handler({});
    expect(LIST_DEFERRED_RETRIES).toBe(4);
    expect(listCompetitors).toHaveBeenCalledTimes(1 + LIST_DEFERRED_RETRIES);
    const body = JSON.parse(out.content[0]?.text ?? 'null');
    expect(body.data[0].brief.state).toBe('deferred');
    expect(body.data[0].threat_level).toBe('unknown');
  });

  it('waits 1.5 s between asks by default', async () => {
    vi.useFakeTimers();
    const listCompetitors = vi
      .fn()
      .mockResolvedValueOnce(page(DEFERRED, 'unknown', null))
      .mockResolvedValueOnce(page(READ));
    const pending = harness({ listCompetitors }, {}).handler({});

    expect(LIST_DEFERRED_RETRY_MS).toBe(1_500);
    await vi.advanceTimersByTimeAsync(LIST_DEFERRED_RETRY_MS - 1);
    expect(listCompetitors).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listCompetitors).toHaveBeenCalledTimes(2);
    const body = JSON.parse((await pending).content[0]?.text ?? 'null');
    expect(body.data[0].brief.state).toBe('read');
  });

  it('a deferred row anywhere on the page triggers the re-ask, next to rows without brief', async () => {
    const mixed = { data: [LEGACY_ROWS[0], row(DEFERRED, 'unknown', null)] };
    const settled = { data: [LEGACY_ROWS[0], row(READ)] };
    const listCompetitors = vi.fn().mockResolvedValueOnce(mixed).mockResolvedValueOnce(settled);
    await harness({ listCompetitors }).handler({});
    expect(listCompetitors).toHaveBeenCalledTimes(2);
  });

  it('hasDeferredRow reads brief.state only', () => {
    expect(hasDeferredRow(page(DEFERRED))).toBe(true);
    expect(hasDeferredRow(page(READ))).toBe(false);
    expect(hasDeferredRow({ data: [{ id: 'c1' }] })).toBe(false);
    expect(hasDeferredRow({ data: [{ id: 'c1', brief: null }] })).toBe(false);
    expect(hasDeferredRow({ data: LEGACY_ROWS })).toBe(false);
    expect(hasDeferredRow(null)).toBe(false);
  });
});

describe('list_competitors against a server that returns no brief', () => {
  // Default options (the real 1.5 s wait) under fake timers: any re-ask would
  // show up as an extra call once every timer has run.
  it('asks once and returns the rows exactly as sent', async () => {
    vi.useFakeTimers();
    const listCompetitors = vi.fn().mockResolvedValue({
      data: LEGACY_ROWS,
      pagination: { total: 2, limit: 50, offset: 0 },
    });
    const pending = harness({ listCompetitors }, {}).handler({ project_id: 'p1' });
    await vi.runAllTimersAsync();
    const out = await pending;

    expect(listCompetitors).toHaveBeenCalledTimes(1);
    expect(out.isError).toBeUndefined();
    const text = out.content[0]?.text ?? '';
    const body = JSON.parse(text);
    expect(body.data).toEqual(LEGACY_ROWS);
    expect(body.pagination).toMatchObject({ total: 2, offset: 0, returned: 2, next_offset: null });
    expect(text).not.toMatch(/brief|standing|deferred/);
  });

  it('a bare array response (no pagination, no brief) is also asked once', async () => {
    vi.useFakeTimers();
    const listCompetitors = vi.fn().mockResolvedValue({ data: LEGACY_ROWS });
    const pending = harness({ listCompetitors }, {}).handler({});
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(listCompetitors).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.content[0]?.text ?? 'null').data).toEqual(LEGACY_ROWS);
  });
});

describe('list_competitors description', () => {
  const { description } = harness({ listCompetitors: vi.fn() });

  it('ranks by brief.standing when present, otherwise by momentum_score', () => {
    expect(description).toMatch(/rank by brief\.standing when present/i);
    expect(description).toMatch(/"ahead" first, then "even", then "behind"/);
    expect(description).toMatch(/otherwise by momentum_score/i);
  });

  it('says threat_level is only the band of momentum_score and never offers it as a ranking', () => {
    expect(description).toMatch(/threat_level is only that score's band/);
    expect(description).not.toMatch(/highest threat_level/i);
    expect(description).not.toMatch(/threat_level first/i);
  });

  it('describes brief as optional, so it stays true for a server that sends none', () => {
    expect(description).toMatch(/brief where the server provides it/i);
    expect(description).toMatch(/brief, when present,/i);
  });
});
