import type { TrendFetchDiagnostic, TrendHotListItem, TrendHotListRequest, TrendHotListResult, TrendProvider } from "@javis/tools";

const WEIBO_HOT_SEARCH_URL = "https://weibo.com/ajax/side/hotSearch";

export interface TrendFetchOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  adapters?: TrendProviderAdapter[];
}

export interface TrendProviderAdapter {
  provider: TrendProvider;
  fetchHotList(request: TrendHotListRequest, options: RequiredTrendFetchOptions): Promise<TrendHotListResult>;
}

interface RequiredTrendFetchOptions {
  fetchImpl: typeof fetch;
  now: () => Date;
}

export class TrendFetchError extends Error {
  readonly diagnostic: TrendFetchDiagnostic;
  readonly diagnostics: TrendFetchDiagnostic[];

  constructor(message: string, diagnostic: TrendFetchDiagnostic, diagnostics: TrendFetchDiagnostic[] = [diagnostic]) {
    super(message);
    this.name = "TrendFetchError";
    this.diagnostic = diagnostic;
    this.diagnostics = diagnostics;
  }
}

const TREND_PROVIDER_ADAPTERS: TrendProviderAdapter[] = [
  {
    provider: "weibo",
    fetchHotList: fetchWeiboHotList,
  },
];

export async function fetchTrendHotList(
  request: TrendHotListRequest,
  options: TrendFetchOptions = {},
): Promise<TrendHotListResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const limit = clampLimit(request.limit);
  if (!fetchImpl) {
    throw createTrendFetchError(
      "Fetch API is not available for trend.fetchHotList.",
      {
        provider: request.provider,
        requestedLimit: limit,
        startedAt: now().toISOString(),
        finishedAt: now().toISOString(),
        status: "failed",
        errorKind: "unavailable",
      },
    );
  }
  const adapters = options.adapters ?? TREND_PROVIDER_ADAPTERS;
  const attemptedProviders = uniqueProviders([
    request.provider,
    ...(request.fallbackProviders ?? []),
  ]);
  const failedDiagnostics: TrendFetchDiagnostic[] = [];

  for (const provider of attemptedProviders) {
    const adapter = adapters.find((candidate) => candidate.provider === provider);
    if (!adapter) {
      failedDiagnostics.push(createTrendDiagnostic({
        provider,
        requestedLimit: limit,
        startedAt: now().toISOString(),
        finishedAt: now().toISOString(),
        status: "failed",
        errorKind: "unsupported_provider",
        error: `Trend provider is not supported: ${provider}`,
      }));
      continue;
    }
    try {
      const result = await adapter.fetchHotList(
        { ...request, provider, limit },
        {
          fetchImpl,
          now,
        },
      );
      return {
        ...result,
        diagnostics: [
          ...failedDiagnostics,
          ...result.diagnostics,
        ],
      };
    } catch (error) {
      failedDiagnostics.push(...diagnosticsFromTrendError(error, provider, limit, now));
    }
  }

  const diagnostic = failedDiagnostics[failedDiagnostics.length - 1] ?? createTrendDiagnostic({
    provider: request.provider,
    requestedLimit: limit,
    startedAt: now().toISOString(),
    finishedAt: now().toISOString(),
    status: "failed",
    errorKind: "unknown",
    error: "No trend provider was attempted.",
  });
  throw new TrendFetchError("Trend hot list fetch failed for all configured providers.", diagnostic, failedDiagnostics);
}

async function fetchWeiboHotList(
  request: TrendHotListRequest,
  options: RequiredTrendFetchOptions,
): Promise<TrendHotListResult> {
  const limit = clampLimit(request.limit);
  const startedAt = options.now();
  let response: Response;
  try {
    response = await options.fetchImpl(WEIBO_HOT_SEARCH_URL, {
      headers: {
        accept: "application/json,text/plain,*/*",
      },
    });
  } catch (error) {
    throw createTrendFetchError(`Weibo hot list request failed: ${summarizeTrendError(error)}`, {
      provider: "weibo",
      sourceUrl: WEIBO_HOT_SEARCH_URL,
      requestedLimit: limit,
      startedAt: startedAt.toISOString(),
      finishedAt: options.now().toISOString(),
      status: "failed",
      errorKind: "network",
      error: summarizeTrendError(error),
    });
  }
  if (!response.ok) {
    throw createTrendFetchError(`Weibo hot list request failed: HTTP ${response.status}`, {
      provider: "weibo",
      sourceUrl: WEIBO_HOT_SEARCH_URL,
      requestedLimit: limit,
      startedAt: startedAt.toISOString(),
      finishedAt: options.now().toISOString(),
      status: "failed",
      httpStatus: response.status,
      errorKind: "http",
      error: `HTTP ${response.status}`,
    });
  }

  let raw: unknown;
  try {
    raw = await response.json() as unknown;
  } catch (error) {
    throw createTrendFetchError(`Weibo hot list response could not be parsed: ${summarizeTrendError(error)}`, {
      provider: "weibo",
      sourceUrl: WEIBO_HOT_SEARCH_URL,
      requestedLimit: limit,
      startedAt: startedAt.toISOString(),
      finishedAt: options.now().toISOString(),
      status: "failed",
      httpStatus: response.status,
      errorKind: "parse",
      error: summarizeTrendError(error),
    });
  }
  const realtime = extractRealtimeItems(raw);
  const items = realtime.slice(0, limit).map(normalizeWeiboItem);
  const warnings: string[] = [];
  if (items.length < limit) {
    warnings.push(`Expected ${limit} hot list item(s), but only ${items.length} were returned.`);
  }

  return {
    provider: "weibo",
    fetchedAt: options.now().toISOString(),
    sourceUrl: WEIBO_HOT_SEARCH_URL,
    items,
    expectedCount: limit,
    complete: items.length >= limit,
    warnings,
    diagnostics: [createTrendDiagnostic({
      provider: "weibo",
      sourceUrl: WEIBO_HOT_SEARCH_URL,
      requestedLimit: limit,
      startedAt: startedAt.toISOString(),
      finishedAt: options.now().toISOString(),
      status: "completed",
      httpStatus: response.status,
      itemCount: items.length,
    })],
  };
}

function createTrendFetchError(
  message: string,
  diagnostic: Omit<TrendFetchDiagnostic, "durationMs">,
): TrendFetchError {
  const finalDiagnostic = createTrendDiagnostic({
    ...diagnostic,
    error: diagnostic.error ?? message,
  });
  return new TrendFetchError(message, finalDiagnostic);
}

function diagnosticsFromTrendError(
  error: unknown,
  provider: TrendProvider,
  requestedLimit: number,
  now: () => Date,
): TrendFetchDiagnostic[] {
  if (error instanceof TrendFetchError) {
    return error.diagnostics.length > 0 ? error.diagnostics : [error.diagnostic];
  }
  return [createTrendDiagnostic({
    provider,
    requestedLimit,
    startedAt: now().toISOString(),
    finishedAt: now().toISOString(),
    status: "failed",
    errorKind: "unknown",
    error: summarizeTrendError(error),
  })];
}

function createTrendDiagnostic(
  diagnostic: Omit<TrendFetchDiagnostic, "durationMs">,
): TrendFetchDiagnostic {
  return {
    ...diagnostic,
    durationMs: Math.max(0, Date.parse(diagnostic.finishedAt) - Date.parse(diagnostic.startedAt)),
  };
}

function extractRealtimeItems(value: unknown): Array<Record<string, unknown>> {
  if (!isPlainRecord(value)) return [];
  const data = value.data;
  if (!isPlainRecord(data) || !Array.isArray(data.realtime)) return [];
  return data.realtime.filter(isPlainRecord);
}

function normalizeWeiboItem(item: Record<string, unknown>, index: number): TrendHotListItem {
  const title = stringValue(item.word) || stringValue(item.note) || stringValue(item.word_scheme) || `item-${index + 1}`;
  const url = buildWeiboSearchUrl(stringValue(item.word_scheme) || title);
  return {
    rank: index + 1,
    title,
    url,
    hotScore: numberValue(item.raw_hot) ?? numberValue(item.num),
    label: stringValue(item.label_name) || stringValue(item.flag_desc),
    category: stringValue(item.category),
    raw: sanitizeRawItem(item),
  };
}

function buildWeiboSearchUrl(query: string): string {
  return `https://s.weibo.com/weibo?q=${encodeURIComponent(query)}`;
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(50, Math.floor(limit as number)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeRawItem(item: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of ["word", "word_scheme", "note", "raw_hot", "num", "label_name", "flag_desc", "category"]) {
    const value = item[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      raw[key] = value;
    }
  }
  return raw;
}

function summarizeTrendError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\s+/g, " ").slice(0, 240) || "Unknown trend fetch error";
}

function uniqueProviders(providers: ReadonlyArray<TrendProvider>): TrendProvider[] {
  return [...new Set(providers.map((provider) => provider.trim()).filter(Boolean))];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
