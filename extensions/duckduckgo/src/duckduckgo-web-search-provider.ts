import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readNumberParam,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const DUCKDUCKGO_INSTANT_ANSWER_ENDPOINT = "https://api.duckduckgo.com/";

type DuckTopic = {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckTopic[];
};

type DuckDuckGoResponse = {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DuckTopic[];
  Results?: DuckTopic[];
};

type DuckSearchResult = {
  title: string;
  url: string;
  description: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDuckTopic(raw: unknown): DuckTopic | null {
  if (!isRecord(raw)) {
    return null;
  }
  const topic: DuckTopic = {};
  if (typeof raw.Text === "string") {
    topic.Text = raw.Text;
  }
  if (typeof raw.FirstURL === "string") {
    topic.FirstURL = raw.FirstURL;
  }
  if (Array.isArray(raw.Topics)) {
    topic.Topics = raw.Topics.map((item) => normalizeDuckTopic(item)).filter(
      Boolean,
    ) as DuckTopic[];
  }
  return topic;
}

function extractTitle(text: string, fallback: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return fallback;
  }
  const parts = trimmed.split(" - ");
  return (parts[0] ?? fallback).trim() || fallback;
}

function flattenTopics(topics: DuckTopic[] | undefined, out: DuckSearchResult[]): void {
  if (!topics) {
    return;
  }
  for (const topic of topics) {
    if (Array.isArray(topic.Topics) && topic.Topics.length > 0) {
      flattenTopics(topic.Topics, out);
      continue;
    }
    if (!topic.FirstURL || !topic.Text) {
      continue;
    }
    out.push({
      title: extractTitle(topic.Text, topic.FirstURL),
      url: topic.FirstURL,
      description: topic.Text,
    });
  }
}

async function runDuckDuckGoSearch(params: {
  query: string;
  count: number;
  timeoutSeconds: number;
}): Promise<DuckSearchResult[]> {
  const url = new URL(DUCKDUCKGO_INSTANT_ANSWER_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("skip_disambig", "1");

  const data = await withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    },
    async (res) => {
      if (!res.ok) {
        throw new Error(`DuckDuckGo API error (${res.status})`);
      }
      return (await res.json()) as DuckDuckGoResponse;
    },
  );

  const results: DuckSearchResult[] = [];
  if (data.AbstractURL && data.AbstractText) {
    results.push({
      title: data.Heading?.trim() || extractTitle(data.AbstractText, data.AbstractURL),
      url: data.AbstractURL,
      description: data.AbstractText,
    });
  }

  const normalizedResults = Array.isArray(data.Results)
    ? data.Results.map((item) => normalizeDuckTopic(item)).filter(Boolean)
    : [];
  flattenTopics(normalizedResults as DuckTopic[], results);

  const normalizedTopics = Array.isArray(data.RelatedTopics)
    ? data.RelatedTopics.map((item) => normalizeDuckTopic(item)).filter(Boolean)
    : [];
  flattenTopics(normalizedTopics as DuckTopic[], results);

  const deduped: DuckSearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of results) {
    const key = entry.url.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }

  return deduped.slice(0, params.count);
}

function createDuckDuckGoToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description: "Search the web using DuckDuckGo.",
    parameters: Type.Object(
      {
        query: Type.String({
          description: "Search query",
          minLength: 1,
        }),
        count: Type.Optional(
          Type.Number({
            description: `Number of results (1-${MAX_SEARCH_COUNT})`,
            minimum: 1,
            maximum: MAX_SEARCH_COUNT,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (args) => {
      const query = readStringParam(args, "query");
      if (!query) {
        return {
          error: "missing_query",
          message: "Missing required string parameter: query",
        };
      }

      const count = resolveSearchCount(readNumberParam(args, "count"), DEFAULT_SEARCH_COUNT);
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
      const cacheKey = buildSearchCacheKey(["duckduckgo", query, count, timeoutSeconds]);

      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const results = await runDuckDuckGoSearch({
        query,
        count,
        timeoutSeconds,
      });

      const payload = {
        query,
        provider: "duckduckgo",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "duckduckgo",
          wrapped: true,
        },
        results: results.map((entry) => ({
          title: wrapWebContent(entry.title, "web_search"),
          url: entry.url,
          description: wrapWebContent(entry.description, "web_search"),
        })),
      };
      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return payload;
    },
  };
}

export function createDuckDuckGoWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "duckduckgo",
    label: "DuckDuckGo",
    hint: "Instant Answer API · no API key required",
    envVars: [],
    placeholder: "No API key required",
    signupUrl: "https://duckduckgo.com/",
    docsUrl: "https://duckduckgo.com/api",
    autoDetectOrder: 5,
    credentialPath: "plugins.entries.duckduckgo.config.webSearch.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: () => undefined,
    setConfiguredCredentialValue: () => {},
    createTool: (ctx) => createDuckDuckGoToolDefinition(ctx.searchConfig as SearchConfigRecord),
  };
}
