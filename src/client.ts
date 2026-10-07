/**
 * Rivalize REST API client (MCP-side).
 *
 * Thin HTTP wrapper over the authenticated v1 REST API. The MCP server does
 * NOT reimplement business logic: it calls the same endpoints the CLI and
 * dashboard use, forwarding the configured `rk_live_*` key as a Bearer token.
 * Tenant isolation, plan gating and per-plan rate limiting are therefore all
 * enforced by the API itself.
 */

import type { McpConfig } from './config.js';
import { VERSION } from './version.js';

/** Shape of the REST API's standard `{ error: {...} }` envelope. */
interface ApiErrorEnvelope {
  error?: { code?: string; message?: string; status?: number };
  message?: string;
}

/**
 * Error thrown when a REST call fails. Carries the HTTP status and the API's
 * error code so tool handlers can produce actionable messages.
 */
export class RivalizeApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /**
   * The API origin the request went to. A key only works on the server
   * that issued it, so an error that does not name the server sends the user
   * hunting for a key problem when the problem is RIVALIZE_API_URL.
   */
  readonly apiUrl: string | undefined;

  constructor(status: number, message: string, code?: string, apiUrl?: string) {
    super(message);
    this.name = 'RivalizeApiError';
    this.status = status;
    this.code = code;
    this.apiUrl = apiUrl;
  }
}

/**
 * Describe a fetch failure. Node's fetch throws `TypeError: fetch failed` and
 * puts the reason on `err.cause` (ECONNREFUSED, ENOTFOUND, a proxy refusal…);
 * dropping the cause would leave the user with "fetch failed" and nothing to
 * act on.
 */
export function describeNetworkError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (!cause || typeof cause !== 'object') return base;
  const code = (cause as { code?: unknown }).code;
  const causeMessage = cause instanceof Error ? cause.message : '';
  const detail = [typeof code === 'string' ? code : '', causeMessage].filter(Boolean).join(': ');
  return detail ? `${base} (${detail})` : base;
}

export interface ListCompetitorsParams {
  projectId?: string;
  limit?: number;
  offset?: number;
}

export interface UniverseListParams {
  q?: string;
  category?: string;
  layer?: string;
  limit?: number;
  offset?: number;
}

export class RivalizeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: McpConfig, fetchImpl: typeof fetch = fetch) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.apiUrl;
    this.fetchImpl = fetchImpl;
  }

  /** Internal: issue an authenticated request and unwrap the JSON body. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.send(method, path, body)).parsed as T;
  }

  /** Internal: an authenticated GET whose success body is text (the `format=markdown` routes). */
  private async requestText(path: string): Promise<string> {
    return (await this.send('GET', path)).raw;
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ raw: string; parsed: unknown }> {
    const url = `${this.baseUrl}/api${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': `rivalize-mcp/${VERSION}`,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new RivalizeApiError(
        0,
        `Could not reach the Rivalize API at ${this.baseUrl}: ${describeNetworkError(err)}`,
        'NETWORK_ERROR',
        this.baseUrl,
      );
    }

    const raw = await response.text();
    let parsed: unknown;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const env = (parsed as ApiErrorEnvelope) ?? {};
      // statusText is '' (not undefined) on a constructed Response and on
      // HTTP/2 origins, so a pure `??` chain would stop there and never reach
      // the HTTP-status fallback, leaving an empty error message. Fall through
      // on empty/whitespace statusText so the message is always meaningful
      // (at minimum `HTTP <status>`).
      const message =
        env.error?.message ??
        env.message ??
        (response.statusText.trim() || `HTTP ${response.status}`);
      throw new RivalizeApiError(response.status, message, env.error?.code, this.baseUrl);
    }

    return { raw, parsed };
  }

  // ── Universe ──

  async listUniverseCompanies(
    params: UniverseListParams = {},
  ): Promise<{ data: unknown[]; pagination: unknown; filters: unknown }> {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.category) search.set('category', params.category);
    if (params.layer) search.set('layer', params.layer);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    const qs = search.toString();
    return this.request('GET', `/v1/universe/companies${qs ? `?${qs}` : ''}`);
  }

  async getUniverseCompany(domain: string): Promise<{ data: unknown }> {
    return this.request('GET', `/v1/universe/companies/${encodeURIComponent(domain)}`);
  }

  // ── Projects + reports (an agent must be able to find the ids the other
  //    tools take, and read a report without generating one) ──

  async listProjects(): Promise<{ data: unknown[] }> {
    return this.request('GET', '/v1/projects');
  }

  async listReports(
    params: { projectId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ data: unknown[]; pagination?: unknown }> {
    const search = new URLSearchParams();
    if (params.projectId) search.set('project_id', params.projectId);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    const qs = search.toString();
    return this.request('GET', `/v1/reports${qs ? `?${qs}` : ''}`);
  }

  /**
   * The report as agent Markdown. With `section`, only that named section
   * (`?section=`); without it the request is exactly what it always was.
   */
  async getReportIntelligence(
    id: string,
    section?: string,
  ): Promise<{ data: { markdown?: unknown; [k: string]: unknown } }> {
    const qs = section === undefined ? '' : `?${new URLSearchParams({ section }).toString()}`;
    return this.request('GET', `/v1/reports/${encodeURIComponent(id)}/intelligence${qs}`);
  }

  /** How current a project's data is (`get_freshness`). */
  async getProjectFreshness(projectId: string): Promise<{ data: unknown }> {
    return this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/freshness`);
  }

  /** The sources behind one subject's facts (`get_evidence`). */
  async getEvidence(projectId: string, competitorId?: string): Promise<{ data: unknown }> {
    const qs = competitorId
      ? `?${new URLSearchParams({ competitor_id: competitorId }).toString()}`
      : '';
    return this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/evidence${qs}`);
  }

  // ── Competitors ──

  /**
   * GET /v1/competitors. `limit`/`offset` are sent only when given: a server
   * that pages answers with `pagination: { total, limit, offset }`, an older one
   * ignores them and returns every row (the tool pages those locally).
   * A bare string is the legacy `projectId` argument.
   */
  async listCompetitors(
    params: ListCompetitorsParams | string = {},
  ): Promise<{ data: unknown[]; pagination?: unknown }> {
    const p = typeof params === 'string' ? { projectId: params } : params;
    const search = new URLSearchParams();
    if (p.projectId) search.set('project_id', p.projectId);
    if (p.limit !== undefined) search.set('limit', String(p.limit));
    if (p.offset !== undefined) search.set('offset', String(p.offset));
    const qs = search.toString();
    return this.request('GET', `/v1/competitors${qs ? `?${qs}` : ''}`);
  }

  async getCompetitorIntelligence(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/v1/competitors/${encodeURIComponent(id)}/intelligence`);
  }

  async getBattlecard(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/v1/competitors/${encodeURIComponent(id)}/battlecard`);
  }

  async getStrategicTimeline(
    projectId: string,
    days: 30 | 90 | 180,
    competitorId?: string,
    lanes?: readonly string[],
  ): Promise<{ data: unknown }> {
    return this.request('GET', this.timelinePath(projectId, days, competitorId, undefined, lanes));
  }

  /** The timeline as the API's agent-ready Markdown (~10x smaller than the JSON). */
  async getStrategicTimelineMarkdown(
    projectId: string,
    days: 30 | 90 | 180,
    competitorId?: string,
    lanes?: readonly string[],
  ): Promise<string> {
    return this.requestText(this.timelinePath(projectId, days, competitorId, 'markdown', lanes));
  }

  private timelinePath(
    projectId: string,
    days: number,
    competitorId?: string,
    format?: 'markdown',
    lanes?: readonly string[],
  ): string {
    const search = new URLSearchParams({ days: String(days) });
    if (competitorId) search.set('competitorId', competitorId);
    if (format) search.set('format', format);
    if (lanes && lanes.length > 0) search.set('lanes', lanes.join(','));
    return `/v1/projects/${encodeURIComponent(projectId)}/timeline?${search.toString()}`;
  }

  async getLandscape(projectId: string, week?: string): Promise<{ data: unknown }> {
    return this.request('GET', this.landscapePath(projectId, week));
  }

  /** The landscape as the API's agent-ready Markdown. */
  async getLandscapeMarkdown(projectId: string, week?: string): Promise<string> {
    return this.requestText(this.landscapePath(projectId, week, 'markdown'));
  }

  private landscapePath(projectId: string, week?: string, format?: 'markdown'): string {
    const search = new URLSearchParams();
    if (week) search.set('week', week);
    if (format) search.set('format', format);
    const qs = search.toString();
    return `/v1/projects/${encodeURIComponent(projectId)}/landscape${qs ? `?${qs}` : ''}`;
  }

  // ── Write (queues analysis and, for a new company, universe enrichment) ──

  async addCompetitor(projectId: string, urls: string[]): Promise<{ data: unknown }> {
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/competitors`, {
      urls,
    });
  }
}
