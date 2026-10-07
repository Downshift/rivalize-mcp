/**
 * Rivalize MCP tools.
 *
 * Each tool is a thin wrapper over an authenticated v1 REST endpoint.
 * READ_TOOL_NAMES are always registered. WRITE_TOOL_NAMES (add_competitor, which
 * spends credits and queues analysis) are registered only when writes are
 * enabled; they are off by default, so the server is read-only unless asked.
 *
 * Tool handlers do no business logic: they validate input (Zod), call the REST
 * client, and shape the response. Tenant isolation, plan gating and rate limits
 * are all enforced by the Rivalize API.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RivalizeApiError, type RivalizeClient } from './client.js';
import { type FitOptions, fitJson, normalizeListPage } from './fit-json.js';
import { paginateMarkdown, selectSections } from './markdown-pages.js';
import { enrichmentHint, renderTeardown } from './teardown.js';
import {
  normalizeDomain,
  shapeUniverseCompany,
  slimUniverseListRow,
  UNIVERSE_LAYER_KEYS,
  UNIVERSE_LAYER_NAMES,
  type UniverseLayerName,
} from './universe-shape.js';

/**
 * The longest a DNS name can be (RFC 1035). A longer domain cannot exist, and
 * without the bound an oversized argument travels to the API only to fail there
 * (or at the edge, as a 431 or 502).
 */
export const MAX_DOMAIN_LENGTH = 253;

/** How much of the caller's input a message quotes back. */
export const ECHO_MAX = 64;

const NUL = '\u0000';
const NUL_MESSAGE = 'must not contain a NUL (U+0000) character';

/**
 * A NUL in a free-text argument would reach the API, whose database cannot
 * store one, and come back as a 500. No domain, search term, slug, id or
 * section name contains one, so it is refused before any request.
 */
function noNul(s: string): boolean {
  return !s.includes(NUL);
}

/** Free text with a length bound and no NUL. */
function text(max: number) {
  return z.string().max(max).refine(noNul, { message: NUL_MESSAGE });
}

/**
 * Quote the caller's input back, at most ECHO_MAX characters of it, so an
 * oversized argument does not flood the reply. A longer input is cut and its
 * length stated, so the reader knows it was cut.
 */
export function quoteInput(input: string): string {
  if (input.length <= ECHO_MAX) return `"${input}"`;
  return `"${input.slice(0, ECHO_MAX)}…" (${input.length.toLocaleString('en-US')} characters)`;
}

/** The first argument (by name) holding a NUL, for callers that skip schema validation. */
function nulArgument(args: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(args ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === 'string' && v.includes(NUL))) return name;
  }
  return null;
}

function invalidArgument(name: string, problem: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error (invalid argument): ${name} ${problem}.` }],
    isError: true,
  };
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * What a 404 means for one tool. The API answers some routes with a
 * generic NOT_FOUND (reports, a competitor's intelligence and battlecard, a
 * project's competitor add) and others with a specific code; the tool names
 * the specific code either way, so every tool's 404 reads the same and names
 * the list_ call that returns valid ids.
 */
type NotFoundCode = 'REPORT_NOT_FOUND' | 'COMPETITOR_NOT_FOUND' | 'PROJECT_NOT_FOUND';

/** Format an API error into an actionable, agent-readable message. */
function formatError(err: unknown, notFound?: NotFoundCode): ToolResult {
  if (err instanceof RivalizeApiError) {
    // A 404 with no code, or the generic one, takes the tool's own code.
    const code =
      err.status === 404 && notFound && (err.code === undefined || err.code === 'NOT_FOUND')
        ? notFound
        : err.code;
    let hint = codeHint(code);
    if (hint === undefined) {
      switch (err.status) {
        case 401:
          hint = unauthorizedHint(err);
          break;
        case 403:
          hint =
            ' This capability requires a higher plan — free API keys include rate-limited reads. Upgrade at https://rivalize.ai/pricing.';
          break;
        case 404:
          hint = ' It may not exist, or may belong to another account.';
          break;
        case 429:
          hint = ' Rate limit exceeded; wait before retrying.';
          break;
        default:
          hint = '';
      }
    }
    // The API's own message often already ends in "." and, for plan gates,
    // already names the upgrade; appending the generic hint then read
    // "…for sales battlecards.. This capability requires a higher plan…".
    const message = err.message.replace(/[.\s]+$/, '');
    if (/upgrade|pricing/i.test(message) && err.status === 403) hint = '';
    return {
      content: [
        {
          type: 'text',
          text: `Error (${err.status}${code ? ` ${code}` : ''}): ${message}.${hint}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

/**
 * A 401 that names the server the key was sent to. A key issued by another
 * Rivalize server (self-hosted, or a test environment) is rejected by the
 * default https://rivalize.ai as "invalid or revoked" even though the key is
 * fine: the server is wrong, and the message should say which server it was.
 */
function unauthorizedHint(err: RivalizeApiError): string {
  const server = err.apiUrl ?? 'the configured server';
  return ` The key was rejected by ${server}. A Rivalize API key only works on the server that issued it: for a self-hosted or non-production Rivalize server, set RIVALIZE_API_URL to that server's origin; for rivalize.ai leave RIVALIZE_API_URL unset. Otherwise check that RIVALIZE_API_KEY is a valid, non-revoked rk_live_ key.`;
}

/**
 * Hints chosen by the API's error CODE where it has one: a generic "verify the
 * id" hint for a missing landscape week would send the agent after the wrong
 * argument. Statuses without a known code fall back to the status hint.
 */
function codeHint(code: string | undefined): string | undefined {
  switch (code) {
    case 'LANDSCAPE_WEEK_NOT_FOUND':
      return ' No landscape is stored for that week. Call get_competitive_landscape without week to see the current view; with format "json" its availableWeeks lists the weeks that are stored.';
    case 'PROJECT_NOT_FOUND':
      return ' Call list_projects for the ids of the projects in your account.';
    case 'REPORT_NOT_FOUND':
      return ' Call list_reports for the ids of the reports in your account.';
    case 'COMPETITOR_NOT_FOUND':
      return ' Call list_competitors for the ids of the competitors in your account.';
    case 'NOT_READY':
      return ' The report exists but is not readable yet (it may be in review); list_reports shows which reports are "completed".';
    case 'UNKNOWN_SECTION':
    case 'SECTION_NOT_IN_REPORT':
      return ' Retry get_report with one of those sections, or without section for the whole report.';
    case 'NETWORK_ERROR':
      return ' Check the network and RIVALIZE_API_URL; behind a corporate proxy, set HTTPS_PROXY.';
    default:
      return undefined;
  }
}

/**
 * Serialize structured output for the agent. `fitJson` keeps every response
 * under the character limit WITHOUT cutting JSON mid-stream: list rows are
 * dropped from the end with `returned`/`next_offset` stated in-band, long arrays
 * are capped with a count, and whole fields are dropped and listed as omitted.
 */
function asResult(output: Record<string, unknown>, opts: FitOptions = {}): ToolResult {
  const { text, structured } = fitJson(output, opts);
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured }
    : { content: [{ type: 'text', text }] };
}

/** Page a Markdown document; every cut says what is left and how to get it. */
function asPagedText(
  md: string,
  page: number | undefined,
  nextCall: (page: number) => string,
  what: string,
): ToolResult {
  const r = paginateMarkdown(md, { page, nextCall, what });
  return r.isError
    ? { content: [{ type: 'text', text: r.text }], isError: true }
    : { content: [{ type: 'text', text: r.text }] };
}

/** `tool {"a":1,...}` with undefined args dropped: the exact next call. */
function callText(tool: string, args: Record<string, unknown>): string {
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  return `${tool} ${JSON.stringify(clean)}`;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// Input schemas as full z.object() schemas (passed as `inputSchema`). Defining
// them at module scope with explicit types avoids the SDK's deep generic
// inference over inline raw shapes (TS2589 "excessively deep").
const ListUniverseSchema = z
  .object({
    q: text(200).optional().describe('Search name/domain/description'),
    category: text(200).optional().describe('Category slug or name'),
    layer: z
      .enum([
        'identity',
        'pricing',
        'features',
        'ads',
        'social',
        'reviews',
        'funding_hiring',
        'rankings',
      ])
      .optional()
      .describe('Require this intelligence layer to be populated'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset'),
  })
  .strict();

// A whitespace-only domain must not pass validation and be reported as "not in
// the universe". Trimmed, then required non-empty. The handlers trim again
// (cleanDomain) for callers that bypass the SDK's validation; the two messages
// differ so a test can tell which guard answered.
// At most MAX_DOMAIN_LENGTH characters, and no NUL.
const DomainArg = z
  .string()
  .trim()
  .min(1, 'domain must not be blank')
  .max(MAX_DOMAIN_LENGTH, `domain must be at most ${MAX_DOMAIN_LENGTH} characters`)
  .refine(noNul, { message: `domain ${NUL_MESSAGE}` })
  .describe(`Company domain or a URL on it (at most ${MAX_DOMAIN_LENGTH} characters)`);

const LAYER_ENUM = UNIVERSE_LAYER_NAMES as [UniverseLayerName, ...UniverseLayerName[]];

const GetUniverseSchema = z
  .object({
    domain: DomainArg,
    layers: z
      .array(z.enum(LAYER_ENUM))
      .min(1)
      .optional()
      .describe(
        'Return only these layers (identity, pricing, features, ads, social, reviews, funding_hiring, rankings, signals, momentum). Default: every layer, long arrays capped.',
      ),
  })
  .strict();

const TeardownSchema = z.object({ domain: DomainArg }).strict();

const ListCompetitorsSchema = z
  .object({
    project_id: z.string().uuid().optional().describe('Filter competitors to this project (UUID)'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset'),
  })
  .strict();

const GetIntelligenceSchema = z
  .object({ competitor_id: z.string().uuid().describe('Competitor UUID from list_competitors') })
  .strict();

const GetBattlecardSchema = z
  .object({ competitor_id: z.string().uuid().describe('Competitor UUID from list_competitors') })
  .strict();

const ListProjectsSchema = z.object({}).strict();

const ListReportsSchema = z
  .object({
    project_id: z.string().uuid().optional().describe('Only reports for this project (UUID)'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100, default 20)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset'),
  })
  .strict();

const PageArg = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('1-based page of a long Markdown document; every page is under 25,000 characters');

/**
 * The report's named sections, as the API serves them (`?section=`). Listed
 * here for the tool description only: the API decides, and an unknown name is
 * answered with the sections that report actually has.
 */
export const REPORT_SECTIONS = {
  document: ['tldr', 'biggest-threat', 'blind-spots', 'competitors', 'battlecards', 'actions'],
  topic: [
    'pricing',
    'momentum',
    'app-store',
    'strengths',
    'weaknesses',
    'key-findings',
    'creators',
    'ads',
    'tech-stack',
  ],
} as const;

const GetReportSchema = z
  .object({
    report_id: text(255).min(1).describe('Report id (or its job id) from list_reports'),
    section: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(noNul, { message: NUL_MESSAGE })
      .optional()
      .describe(
        `Return only this named section of the report: ${[...REPORT_SECTIONS.document, ...REPORT_SECTIONS.topic].join(', ')}`,
      ),
    competitor: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(noNul, { message: NUL_MESSAGE })
      .optional()
      .describe('Return only the sections whose heading names this competitor'),
    page: PageArg,
  })
  .strict();

const GetFreshnessSchema = z
  .object({ project_id: z.string().uuid().describe('Project UUID from list_projects') })
  .strict();

const GetEvidenceSchema = z
  .object({
    project_id: z.string().uuid().describe('Project UUID from list_projects'),
    competitor_id: z
      .string()
      .uuid()
      .optional()
      .describe('A competitor UUID from list_competitors; omit for your own product'),
  })
  .strict();

/** The timeline's lane ids, as the API's `lanes` parameter accepts them. */
const TIMELINE_LANES = ['pricing', 'product', 'people', 'funding', 'content-social'] as const;

const GetTimelineSchema = z
  .object({
    project_id: z.string().uuid().describe('Project UUID from list_projects'),
    days: z.enum(['30', '90', '180']).optional().describe('History window; defaults to 90 days'),
    competitor_id: z.string().uuid().optional().describe('Limit the timeline to one competitor'),
    lanes: z
      .array(z.enum(TIMELINE_LANES))
      .min(1)
      .optional()
      .describe('Only these lanes: pricing, product, people, funding, content-social'),
    format: z
      .enum(['markdown', 'json'])
      .optional()
      .describe('markdown (default, compact, agent-ready) or json (full structure, much larger)'),
    page: PageArg,
  })
  .strict();

const GetLandscapeSchema = z
  .object({
    project_id: z.string().uuid().describe('Project UUID from list_projects'),
    week: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Stored ISO week start; omit for current positions'),
    format: z
      .enum(['markdown', 'json'])
      .optional()
      .describe('markdown (default, compact, agent-ready) or json (full structure)'),
    page: PageArg,
  })
  .strict();

const AddCompetitorSchema = z
  .object({
    project_id: z
      .string()
      .uuid()
      .describe('Project UUID (from list_projects) to add competitors to'),
    urls: z
      .array(text(2048).min(1))
      .min(1, 'Provide at least one competitor URL')
      .max(10, 'At most 10 URLs per call')
      .describe('1-10 competitor URLs'),
  })
  .strict();

/**
 * Trim a domain argument and check it as the schema does, for callers that
 * bypass the SDK's validation: a blank domain, a NUL or a domain longer than
 * MAX_DOMAIN_LENGTH is refused before any request.
 */
function cleanDomain(domain: string): { domain: string } | { error: ToolResult } {
  const d = domain.trim();
  if (!d) {
    return {
      error: {
        content: [{ type: 'text', text: 'Error: domain must be a non-empty domain or URL.' }],
        isError: true,
      },
    };
  }
  if (!noNul(d)) return { error: invalidArgument('domain', NUL_MESSAGE) };
  if (d.length > MAX_DOMAIN_LENGTH) {
    return {
      error: invalidArgument(
        'domain',
        `must be at most ${MAX_DOMAIN_LENGTH} characters (got ${d.length.toLocaleString('en-US')})`,
      ),
    };
  }
  return { domain: d };
}

interface TrackedMatch {
  id: string;
  name: string;
  projectId: string | null;
  projectName: string | null;
}

const TRACKED_LOOKUP_PAGE = 100;
const TRACKED_LOOKUP_MAX_PAGES = 20;

/**
 * Find a tracked competitor whose website is this domain, walking every
 * page of list_competitors. A server that does not page returns every row on
 * the first call. Any failure means "unknown", never an error: this only
 * chooses which message to show.
 */
async function findTrackedCompetitor(
  client: RivalizeClient,
  domain: string,
): Promise<TrackedMatch | null> {
  const want = normalizeDomain(domain);
  if (!want) return null;
  try {
    let offset = 0;
    for (let i = 0; i < TRACKED_LOOKUP_MAX_PAGES; i++) {
      const res = (await client.listCompetitors({ limit: TRACKED_LOOKUP_PAGE, offset })) as {
        data?: unknown;
        pagination?: { total?: unknown };
      };
      const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
      for (const r of rows) {
        const site = typeof r.website === 'string' ? normalizeDomain(r.website) : '';
        if (site && site === want && typeof r.id === 'string') {
          return {
            id: r.id,
            name: typeof r.name === 'string' ? r.name : want,
            projectId: typeof r.project_id === 'string' ? r.project_id : null,
            projectName: typeof r.project_name === 'string' ? r.project_name : null,
          };
        }
      }
      const total = typeof res.pagination?.total === 'number' ? res.pagination.total : null;
      offset += rows.length;
      if (total === null || rows.length === 0 || offset >= total) return null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A universe lookup that 404s means the company is not in the (shared) universe,
 * or not yet published there. The generic 404 hint ("may belong to another
 * account") is wrong for it. When the domain is already TRACKED in the
 * account, "add it as a competitor" is wrong too: say it is tracked and point
 * at the account-scoped reads that do have data for it.
 */
async function notInUniverse(
  client: RivalizeClient,
  domain: string,
  allowWrites: boolean,
): Promise<ToolResult> {
  const tracked = await findTrackedCompetitor(client, domain);
  if (tracked) {
    const where = tracked.projectName ? ` (project "${tracked.projectName}")` : '';
    const reports = tracked.projectId
      ? `${callText('list_reports', { project_id: tracked.projectId })} then get_report with {"competitor":${JSON.stringify(tracked.name)}}`
      : 'list_reports, then get_report with the competitor argument';
    return {
      content: [
        {
          type: 'text',
          text: `${quoteInput(domain)} is already tracked in your account as "${tracked.name}"${where}, but it has no Rivalize universe profile yet, so there is no universe profile or teardown for it. Read what your account has on it instead: ${callText('get_competitor_intelligence', { competitor_id: tracked.id })}, or ${reports}.`,
        },
      ],
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: `${quoteInput(domain)} is not in the Rivalize universe yet, so there is no profile to report. ${enrichmentHint(allowWrites)}`,
      },
    ],
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof RivalizeApiError && err.status === 404;
}

export interface RegisterToolsOptions {
  /** Register WRITE_TOOL_NAMES (add_competitor). Default false: read-only. */
  allowWrites?: boolean;
  /**
   * Origin used for links the tools print (the teardown's "pull this live" and
   * dashboard links). Defaults to https://rivalize.ai; the server passes its
   * RIVALIZE_API_URL so a self-hosted or local server never links to rivalize.ai.
   */
  origin?: string;
  /**
   * Milliseconds to wait before `list_competitors` asks again for a page that
   * has a row whose `brief.state` is `deferred`. Defaults to
   * LIST_DEFERRED_RETRY_MS; tests pass 0.
   */
  deferredRetryMs?: number;
}

/**
 * How many more times `list_competitors` asks for the same page while a row's
 * `brief.state` is `deferred`. The API reads a rival's standing for a few rows
 * per request and keeps what it read, so asking again fills the row in. An
 * agent rarely asks again by itself, so the tool does, a bounded number of
 * times. A server that sends no `brief` never triggers a second request.
 */
export const LIST_DEFERRED_RETRIES = 4;
export const LIST_DEFERRED_RETRY_MS = 1_500;

/** Whether any row on a competitor page has a standing that is still being read. */
export function hasDeferredRow(page: unknown): boolean {
  const rows = (page as { data?: unknown } | null)?.data;
  return (
    Array.isArray(rows) &&
    rows.some((row) => (row as { brief?: { state?: unknown } | null } | null)?.brief?.state === 'deferred')
  );
}

/**
 * Register the tools on the given server, backed by the given client.
 * Exported (vs. baked into index.ts) so tests can drive the handlers directly.
 */
export function registerTools(
  server: McpServer,
  client: RivalizeClient,
  opts: RegisterToolsOptions = {},
): void {
  const allowWrites = opts.allowWrites === true;

  // ── list_universe_companies ──
  server.registerTool(
    'list_universe_companies',
    {
      title: 'List universe companies',
      description: `List companies from the Rivalize universe — the cross-customer competitive-intelligence dataset (not your own tracked competitors; for those use list_competitors).

Search by keyword, filter by category or by which intelligence layer is populated, and paginate.

Args:
  - q (string, optional): search name/domain/description
  - category (string, optional): category SLUG, e.g. "ai-infra" (names like "AI infrastructure" do not match; each row's categories lists its slugs)
  - layer (string, optional): require a populated layer — one of identity, pricing, features, ads, social, reviews, funding_hiring, rankings
  - limit (number, optional): page size 1-100 (default 50)
  - offset (number, optional): pagination offset (default 0)

Returns compact JSON: { data: Company[], pagination: { total, limit, offset, returned, next_offset }, filters }.
Each Company: domain, name, primaryCategory, categories (slugs), priorityScore, lastEnrichedAt, layers (which layers are populated), layersUpdated, description (at most 120 characters).
If a page does not fit one response, fewer rows come back with _truncated, and pagination.limit/returned say how many; always continue with offset = pagination.next_offset (null when there are no more). Use get_universe_company for one company's full profile.

Use when: "who are the players in <category>?" or "show me universe companies matching <keyword>".`,
      inputSchema: ListUniverseSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof ListUniverseSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const res = (await client.listUniverseCompanies(args)) as Record<string, unknown>;
        const data = Array.isArray(res.data) ? res.data.map(slimUniverseListRow) : res.data;
        return asResult(
          { ...res, data },
          { narrowHint: 'Narrow with q, category or layer, or page with offset.' },
        );
      } catch (err) {
        return formatError(err);
      }
    },
  );

  // ── get_universe_company ──
  server.registerTool(
    'get_universe_company',
    {
      title: 'Get universe company',
      description: `Get the universe profile for one company by domain, including every populated intelligence layer (identity, pricing, features, ads, social, reviews, funding/hiring, rankings, signals, momentum).

Args:
  - domain (string, required): the company domain or any URL on it (e.g. "linear.app" or "https://linear.app/pricing"). Normalized server-side.
  - layers (string[], optional): only these layers — any of identity, pricing, features, ads, social, reviews, funding_hiring, rankings, signals, momentum. Asking for fewer layers returns more items of each.

Returns compact JSON: { data: { domain, name, primaryCategory, lastEnrichedAt, layerFreshness, identity, pricing, features, ads, socialInfluencers, reviews, fundingHiring, rankings, signals, momentum, ... } }.
Long arrays (recent posts, ad creatives, sources) are capped; _capped lists kept/total for each. If a layer still does not fit, it is left out and listed in _omitted with the exact call that fetches it. The JSON is always complete and valid.

If the domain is not in the universe, says so (and, when the domain is one of your tracked competitors, points at get_competitor_intelligence / get_report instead).

Use when: "give me everything Rivalize knows about <domain>".`,
      inputSchema: GetUniverseSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetUniverseSchema>) => {
      const cleaned = cleanDomain(args.domain);
      if ('error' in cleaned) return cleaned.error;
      const { domain } = cleaned;
      try {
        const res = (await client.getUniverseCompany(domain)) as Record<string, unknown>;
        const company = res.data;
        let shaped: Record<string, unknown> = res;
        if (company && typeof company === 'object' && !Array.isArray(company)) {
          const { data, capped } = shapeUniverseCompany(company as Record<string, unknown>, {
            layers: args.layers,
          });
          shaped = Object.keys(capped).length
            ? {
                _capped: capped,
                _capped_note: args.layers
                  ? 'Long arrays are capped; kept/total per path in _capped.'
                  : `Long arrays are capped; kept/total per path in _capped. For more of one layer call ${callText('get_universe_company', { domain, layers: ['<layer>'] })}.`,
                ...res,
                data,
              }
            : { ...res, data };
        }
        return asResult(shaped, {
          omitHint: (field) => {
            const layer = UNIVERSE_LAYER_NAMES.find((k) => UNIVERSE_LAYER_KEYS[k] === field);
            return callText('get_universe_company', {
              domain,
              layers: layer ? [layer] : undefined,
            });
          },
          protectedKeys: ['domain', 'name', 'primaryCategory', 'lastEnrichedAt', 'layerFreshness'],
        });
      } catch (err) {
        if (isNotFound(err)) return notInUniverse(client, domain, allowWrites);
        return formatError(err);
      }
    },
  );

  // ── teardown_competitor (the "do a teardown" magic) ──
  server.registerTool(
    'teardown_competitor',
    {
      title: 'Tear down a competitor',
      description: `Produce a full strategy teardown of one competitor by domain — their positioning/hooks, pricing, ads (the creatives they are running), social presence, reviews, hiring, momentum, plus weaknesses to attack. Returns a ready-to-read Markdown teardown, not raw JSON.

This is the one-call competitor teardown: broader than an ad-only teardown, source-backed, and dated (it leads with when the data was last refreshed). Use it to answer "tear down <competitor>" or "what is <competitor>'s strategy and where are they weak?".

Args:
  - domain (string, required): the competitor's domain or any URL on it.

Returns Markdown. Ads count as active only if seen in the last 30 days; an unscored momentum is shown as not scored. If the domain is not yet in the universe, says so: when it is one of your tracked competitors it points at get_competitor_intelligence / get_report, otherwise at how to get it enriched.`,
      inputSchema: TeardownSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof TeardownSchema>) => {
      const cleaned = cleanDomain(args.domain);
      if ('error' in cleaned) return cleaned.error;
      const { domain } = cleaned;
      try {
        const res = await client.getUniverseCompany(domain);
        const company = (res as { data?: Record<string, unknown> }).data;
        if (!company || typeof company !== 'object') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No universe profile for ${quoteInput(domain)} yet. ${enrichmentHint(allowWrites)}`,
              },
            ],
          };
        }
        const md = renderTeardown(company, {
          nowMs: Date.now(),
          origin: opts.origin ?? 'https://rivalize.ai',
          canAddCompetitor: allowWrites,
        });
        return { content: [{ type: 'text' as const, text: md }] };
      } catch (err) {
        if (isNotFound(err)) return notInUniverse(client, domain, allowWrites);
        return formatError(err);
      }
    },
  );

  // ── list_projects ──
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: `List the projects in YOUR Rivalize account. A project is one of your products and the competitors tracked against it.

Args: none.

Returns JSON: { data: Project[] }. Each Project includes id, name, url, competitor_count, last_refreshed_at, created_at.

Use the returned project id with list_competitors, list_reports, get_strategic_timeline, get_competitive_landscape, get_freshness and get_evidence.

Use when: "what products/projects do I have?", or first, whenever another tool needs a project_id. (For "which competitors am I tracking?" use list_competitors.)`,
      inputSchema: ListProjectsSchema,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const res = await client.listProjects();
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err);
      }
    },
  );

  // ── list_reports ──
  server.registerTool(
    'list_reports',
    {
      title: 'List reports',
      description: `List the competitive-intelligence reports in YOUR Rivalize account, newest first. Reading is free; this never generates a report.

Args:
  - project_id (string, optional): only this project's reports. Call list_projects first for the id.
  - limit (number, optional): page size 1-100 (default 20)
  - offset (number, optional): pagination offset (default 0)

Returns JSON: { data: Report[], pagination: { total, limit, offset, returned, next_offset } }. Each Report includes id, job_id, project_id, product_name, product_url, competitor_urls, status ("completed" or "unavailable"), created_at, depth ("full" for full research, "quick" for a quick check). A quick check does not buy search traffic, follower counts or the written note on each company, so those are blank in it and marked "Needs full research"; they are not findings.

Use the returned id with get_report.

Use when: "what reports do I have?" or "open my latest report on <product>".`,
      inputSchema: ListReportsSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof ListReportsSchema>) => {
      try {
        const res = await client.listReports({
          projectId: args.project_id,
          limit: args.limit,
          offset: args.offset,
        });
        return asResult(res as Record<string, unknown>, {
          narrowHint: 'Filter with project_id, or page with offset.',
        });
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_report ──
  server.registerTool(
    'get_report',
    {
      title: 'Read a report',
      description: `Read one competitive-intelligence report as Markdown: TL;DR, biggest threat, your blind spots, a section per competitor, and cited battlecards where the report has them.

Claims the report's fabrication check flagged are shown as "[removed — unverified]", exactly as in the report itself. Do not try to fill them in.

Args:
  - report_id (string, required): the report id (or its job id) from list_reports
  - section (string, optional): only this named section, plus the report title, date and depth, and a line naming the report's other sections. A whole report is several thousand to over a hundred thousand characters and a section is typically a sixth of it, so ask for the section your question needs. Sections:
      tldr, biggest-threat, blind-spots, actions (what your product should do), battlecards, competitors (every competitor's section in full);
      per competitor, gathered from every competitor's section: pricing, momentum, app-store, strengths, weaknesses, key-findings, creators, ads, tech-stack.
    A report has only the sections it has data for. A name that is not one of this report's sections is an error that lists the sections it does have; retry with one of them. Case, spaces and underscores are ignored ("Key findings" = key-findings).
  - competitor (string, optional): only the sections whose heading names this competitor (its section and its battlecard), plus the report title and date. Case-insensitive. With section, only that competitor's part of the section (e.g. section "pricing" + competitor "Notion").
  - page (number, optional): 1-based page. A report over 25,000 characters is split into pages at section boundaries; every page starts with "Page N of M", the characters that remain, the exact call for the next page, and the sections on later pages. A report that fits is returned whole, unchanged.

Without section, returns the whole report exactly as before. Returns Markdown. 404 if the report is not in your account or is not available.

Use when: "summarise my latest report" (no section, or tldr), "what do competitors charge?" (section "pricing"), "what did the report say about <competitor>?" (use competitor).`,
      inputSchema: GetReportSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetReportSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const section = args.section?.trim() || undefined;
        // Without section the request is exactly what it always was.
        const res =
          section === undefined
            ? await client.getReportIntelligence(args.report_id)
            : await client.getReportIntelligence(args.report_id, section);
        // A server that predates sections ignores `?section=` and sends the
        // whole report; never hand that back as if it were the section.
        if (section !== undefined && typeof res?.data?.section !== 'string') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `This Rivalize server does not serve report sections yet, so ${quoteInput(section)} could not be read on its own. Call get_report without section for the whole report.`,
              },
            ],
            isError: true,
          };
        }
        const md = res?.data?.markdown;
        if (typeof md !== 'string' || md.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Report ${quoteInput(args.report_id)} returned no readable content.`,
              },
            ],
            isError: true,
          };
        }
        let doc = md;
        if (args.competitor) {
          const sel = selectSections(md, args.competitor);
          if (sel.matched.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No section heading in report ${quoteInput(args.report_id)} names ${quoteInput(args.competitor)}. Sections in this report: ${sel.available.join('; ') || '(none)'}.`,
                },
              ],
              isError: true,
            };
          }
          doc = sel.md;
        }
        return asPagedText(
          doc,
          args.page,
          (page) =>
            callText('get_report', {
              report_id: args.report_id,
              section,
              competitor: args.competitor,
              page,
            }),
          section === undefined ? 'report' : `report section "${section}"`,
        );
      } catch (err) {
        return formatError(err, 'REPORT_NOT_FOUND');
      }
    },
  );

  // ── list_competitors ──
  server.registerTool(
    'list_competitors',
    {
      title: 'List tracked competitors',
      description: `List the competitors tracked in YOUR Rivalize account (tenant-isolated). Answers "which competitors am I tracking?".

Args:
  - project_id (string, optional): only one project's competitors. Call list_projects first for the id.
  - limit (number, optional): page size 1-100
  - offset (number, optional): pagination offset (default 0)

Returns JSON: { data: Competitor[], pagination: { total, limit, offset, returned, next_offset } }. Each Competitor includes id, project_id, project_name, name, website, threat_level, momentum_score, and brief where the server provides it. Keep paging with offset = pagination.next_offset until it is null.

momentum_score is the rival's momentum score, and threat_level is only that score's band (critical, high, medium, low, or unknown when there is no score): it is not a second assessment, so do not rank by it.

brief, when present, is how the rival stands as your workspace's Brief shows it: brief.standing is "ahead" (the rival is ahead of you), "behind", "even" or "no_read"; brief.standing_label is the Brief's own words; brief.as_of is the date of the report it was read from; brief.state is "read", "not_in_run" (no finished report covered this rival), "no_run", "unreadable" or "deferred" (still being read: the tool asks again a few times before it answers, so a row still "deferred" means call again in a moment).

To pick the "top" or biggest competitor: rank by brief.standing when present ("ahead" first, then "even", then "behind"), otherwise by momentum_score; break ties by highest momentum_score. A rival whose brief.state is not "read" has no standing yet: say so rather than ranking it by standing.

With a competitor's id: get_competitor_intelligence (its latest intelligence), get_battlecard (sales battlecard), get_evidence with its project_id (the sources behind its facts). For what a report said about it: list_reports for the project, then get_report with competitor set to its name. For when it was last observed: get_freshness for its project.

Use when: "which competitors am I tracking?", "who is my top competitor?", or before any per-competitor read.`,
      inputSchema: ListCompetitorsSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof ListCompetitorsSchema>) => {
      try {
        const ask = () =>
          client.listCompetitors({
            projectId: args.project_id,
            limit: args.limit,
            offset: args.offset,
          });
        let res = await ask();
        // A row whose standing is still being read is asked for again, a
        // bounded number of times; what is still `deferred` after that is
        // returned as such. Rows without `brief` are never deferred.
        const retryMs = opts.deferredRetryMs ?? LIST_DEFERRED_RETRY_MS;
        for (let i = 0; i < LIST_DEFERRED_RETRIES && hasDeferredRow(res); i++) {
          if (retryMs > 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
          res = await ask();
        }
        return asResult(
          normalizeListPage(res as Record<string, unknown>, {
            limit: args.limit,
            offset: args.offset,
          }),
          { narrowHint: 'Filter with project_id, or page with offset.' },
        );
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_competitor_intelligence ──
  server.registerTool(
    'get_competitor_intelligence',
    {
      title: 'Get competitor intelligence',
      description: `Get the latest stored intelligence for one tracked competitor.

Args:
  - competitor_id (string, required): the competitor UUID (from list_competitors)

Returns JSON: { data: { competitor_name, momentum_score, intelligence, latest_snapshot, source, source_report_id, source_report_date, report } }. source says where the data comes from: "snapshot" (a stored intelligence snapshot), "report" (the competitor's latest report in your account; report holds swot, strengths, weaknesses, key_findings, tech_stack, pricing_tiers, social and reviews, and source_report_id names the report for get_report), or "none" (the competitor appears in no snapshot or report yet). Every field is present only when measured: null or absent means "not measured", not "none". Claims the report withheld as unverified are withheld here too.

Returns a 404 error if the competitor does not belong to your account (tenant isolation).

Use when: "what's the latest intel on <competitor>?" after finding its id via list_competitors. For the full narrative, get_report with competitor is richer.`,
      inputSchema: GetIntelligenceSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetIntelligenceSchema>) => {
      try {
        const res = await client.getCompetitorIntelligence(args.competitor_id);
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err, 'COMPETITOR_NOT_FOUND');
      }
    },
  );

  // ── get_battlecard ──
  server.registerTool(
    'get_battlecard',
    {
      title: 'Get competitor battlecard',
      description: `Get the cited sales battlecard for one tracked competitor — Why We Win, Their Weaknesses, Objection Handlers, Discovery Questions. Every claim carries citations resolving to the collected source; claims that could not be cited were WITHHELD, not asserted.

Args:
  - competitor_id (string, required): the competitor UUID (from list_competitors)

Returns JSON: { data: { status, sections_empty, sections_locked, withheld_reason?, battlecard, markdown, generated_at, intelligence_date, source, report_id?, report_date? } }.
- status is read off the card's four sections. "ready": every section carries a cited claim. "partial": at least one section has none; sections_empty names them (sections_locked names the ones locked until the user's company profile is complete, which were not withheld). "withheld": the card exists but no section carries a claim; withheld_reason says why. Do not treat "partial" or "withheld" as a complete card.
- "markdown" is a paste-ready cited card and states a partial or withheld card up front. source "generated" is a card generated from the dashboard's Battlecard tab; source "report" is the battlecard inside the competitor's latest report, and report_id names that report (get_report reads it in full).
- status "not_generated": no card can be served — none generated, and the latest report has none (or only one in an older format that fails the citation contract). The user generates one from the dashboard's Battlecard tab.

Requires a Pro-plan API key (403 PLAN_REQUIRED below Pro). 404 if the competitor is not in your account (tenant isolation).

Use when: "give me sales ammo against <competitor>", "how do we win vs <competitor>", or prepping a call.`,
      inputSchema: GetBattlecardSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetBattlecardSchema>) => {
      try {
        const res = await client.getBattlecard(args.competitor_id);
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err, 'COMPETITOR_NOT_FOUND');
      }
    },
  );

  // ── get_strategic_timeline ──
  server.registerTool(
    'get_strategic_timeline',
    {
      title: 'Get strategic timeline',
      description: `Get a receipt-linked timeline of competitor activity across Pricing, Product, People, Funding, and Content/Social lanes.

Args:
  - project_id (string, required): the project's UUID. Call list_projects first for the id.
  - days ("30" | "90" | "180", optional): history window, default 90
  - competitor_id (string, optional): isolate one competitor
  - lanes (string[], optional): only these lanes, any of pricing, product, people, funding, content-social
  - format ("markdown" | "json", optional): markdown by default (compact); json for the full structure
  - page (number, optional): 1-based page of the Markdown. A timeline over 25,000 characters is split at lane/move boundaries; each page says "Page N of M", what remains and the exact next call.

Returns agent-ready Markdown by default (JSON on request) with structured events, seven-day move clusters, tracking-since dates, and evidence URLs. History is never backfilled before Rivalize began tracking. Full history/all-competitor access requires Pro; lower plans can request one competitor for 30 days.

Use when: "what strategic moves have competitors made this quarter?" or "show the arc behind recent competitor activity".`,
      inputSchema: GetTimelineSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetTimelineSchema>) => {
      try {
        const days = Number(args.days ?? '90') as 30 | 90 | 180;
        if (args.format === 'json') {
          const res = await client.getStrategicTimeline(
            args.project_id,
            days,
            args.competitor_id,
            args.lanes,
          );
          return asResult(res as Record<string, unknown>, {
            narrowHint:
              'For the whole timeline use format "markdown" (paged with page), or narrow with competitor_id or a shorter days window.',
          });
        }
        // Markdown by default: the JSON form of a busy project's timeline runs
        // to tens of kilobytes and reaches the 25,000-character limit within
        // 90 days, while the API's agent Markdown carries the same timeline in
        // roughly a tenth of the space.
        return asPagedText(
          await client.getStrategicTimelineMarkdown(
            args.project_id,
            days,
            args.competitor_id,
            args.lanes,
          ),
          args.page,
          (page) =>
            callText('get_strategic_timeline', {
              project_id: args.project_id,
              days: args.days,
              competitor_id: args.competitor_id,
              lanes: args.lanes,
              page,
            }),
          'timeline',
        );
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_competitive_landscape ──
  server.registerTool(
    'get_competitive_landscape',
    {
      title: 'Get competitive landscape',
      description: `Get the current or stored weekly competitor positions on activity × strategic importance.

Args:
  - project_id (string, required): the project's UUID. Call list_projects first for the id.
  - week (YYYY-MM-DD, optional): a stored ISO week; omit for current positions. The json format lists stored weeks in availableWeeks.
  - format ("markdown" | "json", optional): markdown by default; json for the full structure
  - page (number, optional): 1-based page when the Markdown is over 25,000 characters; each page names the next call

Returns agent-ready Markdown by default (JSON on request) with coordinates, trailing signal counts, momentum, latest headlines, importance source, available weeks, and the honest tracking-start date. Historical weeks are never synthesized. History requires Pro; the current view remains available below Pro.

Use when: "who is the biggest moving threat?" or "who moved most this month?".`,
      inputSchema: GetLandscapeSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetLandscapeSchema>) => {
      try {
        if (args.format === 'json') {
          const res = await client.getLandscape(args.project_id, args.week);
          return asResult(res as Record<string, unknown>, {
            narrowHint: 'For the whole landscape use format "markdown" (paged with page).',
          });
        }
        return asPagedText(
          await client.getLandscapeMarkdown(args.project_id, args.week),
          args.page,
          (page) =>
            callText('get_competitive_landscape', {
              project_id: args.project_id,
              week: args.week,
              page,
            }),
          'landscape',
        );
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_freshness ──
  server.registerTool(
    'get_freshness',
    {
      title: 'Get data freshness',
      description: `How current your Rivalize data is for one project: the date of its latest report, and for EACH tracked competitor the date Rivalize last actually observed it and how. Reading is free; this never fetches anything.

Args:
  - project_id (string, required): the project's UUID. Call list_projects first for the id.

Returns JSON: { data: { project_id, project_name, latest_report: { id, created_at, depth } | null, competitors: Competitor[], observation_kinds } }.
Each Competitor: competitor_id, name, website, status ("observed" or "never_observed"), last_observed_at, last_observed_by, and observations with the newest date of each kind:
  - report_run: a report you can read analysed it and its crawl read the site (report_id names the report)
  - site_crawl: a stored crawl of its site
  - monitoring_page_capture: a monitoring check fetched one of its pages (page_type, url)
  - search_check: a monitoring search asked whether anything changed. It does not read the site, so it never sets last_observed_at.
last_observed_at is the newest of report_run, site_crawl and monitoring_page_capture, and last_observed_by names which. A competitor nothing has observed is "never_observed" with null dates: no date is ever estimated or filled in, and a record's edit time is never used as an observation date. A failed crawl, a rejected report and a baseline copied from stored data are not observations.

Returns a 404 error if the project is not in your account.

Use when: "how fresh is this data?", "when did we last look at <competitor>?", or before relying on a figure, to say how old it is.`,
      inputSchema: GetFreshnessSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetFreshnessSchema>) => {
      try {
        const res = await client.getProjectFreshness(args.project_id);
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_evidence ──
  server.registerTool(
    'get_evidence',
    {
      title: 'Get evidence',
      description: `The sources behind the facts for ONE subject: your own product (omit competitor_id) or one tracked competitor. Taken from the latest readable report in the project that analysed the subject, as the report serves it: claims the report withholds as unverified are withheld here too, and a figure the report has corrected shows the corrected value.

Args:
  - project_id (string, required): the project's UUID. Call list_projects first for the id.
  - competitor_id (string, optional): a competitor UUID from list_competitors (it must be in this project). Omit for your own product.

Returns JSON: { data: { project_id, subject: { kind ("product" | "competitor"), competitor_id, name, website }, report: { id, created_at } | null, source_count, unlinked_attributions, off_entity_withheld, sources: Source[] } }.
Each Source: url, supports (what it backs: the fact, claim or section, as the report states it), kinds (attribution, page_read, press, strength_receipt, fact, battlecard, interpretation), observed_at (the date of the report run that read it) and, for press, published_at (the article's own date).
unlinked_attributions counts data points the report attributed to a description rather than a URL; they are not listed, and no URL is made up for them. off_entity_withheld counts sources a web search for the subject's name returned that are not about the subject (not on its domain, and neither the URL nor any text the report keeps for it names the subject, e.g. a stock page for a similarly named company); they are not listed. With no readable report on the subject, sources is empty and note says why.

Returns a 404 error if the project is not in your account, or if competitor_id is not a competitor in this project (another account's competitor is reported exactly like one that does not exist).

Use when: "where does that come from?", "show me the sources for <competitor>'s pricing", or to cite a claim.`,
      inputSchema: GetEvidenceSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetEvidenceSchema>) => {
      try {
        const res = await client.getEvidence(args.project_id, args.competitor_id);
        return asResult(res as Record<string, unknown>, {
          narrowHint:
            'The source list is long: ask about one competitor at a time with competitor_id.',
        });
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── add_competitor (WRITE) — registered only when writes are enabled ──
  if (!allowWrites) return;
  server.registerTool(
    'add_competitor',
    {
      title: 'Add a competitor',
      description: `Add one or more competitor URLs to a project in your account. This is the two-way write half of the data layer: adding a competitor Rivalize has not seen before ALSO queues a crawl of that company across 8 intelligence layers, which adds it to the Rivalize universe of tracked companies.

Args:
  - project_id (string, required): the project UUID (from list_projects) to add competitors to
  - urls (string[], required): 1-10 competitor URLs

Returns JSON: { data: { competitors_added, competitors_skipped, job_id, message } }.
A non-null job_id means analysis was enqueued; poll get_competitor_intelligence later for results.

This is a WRITE that consumes credits and triggers analysis. Returns 402 if out of credits, 409 if it would exceed the plan's competitor limit, 404 if the project is not yours.

Use when: "add <url> as a competitor to my <project>".`,
      inputSchema: AddCompetitorSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof AddCompetitorSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const res = await client.addCompetitor(args.project_id, args.urls);
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );
}

/** Read tools — always registered. Used by tests and docs. */
export const READ_TOOL_NAMES = [
  'list_universe_companies',
  'get_universe_company',
  'teardown_competitor',
  'list_projects',
  'list_reports',
  'get_report',
  'list_competitors',
  'get_competitor_intelligence',
  'get_battlecard',
  'get_strategic_timeline',
  'get_competitive_landscape',
  'get_freshness',
  'get_evidence',
] as const;

/** Write tools — registered only with RIVALIZE_MCP_ALLOW_WRITES. */
export const WRITE_TOOL_NAMES = ['add_competitor'] as const;

/** Every tool this server can register. */
export const TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const;
