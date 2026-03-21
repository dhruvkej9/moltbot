import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readResponseText,
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

const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html";

type DuckSearchResult = {
  title: string;
  url: string;
  description: string;
};

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const normalizedRawUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const parsed = new URL(normalizedRawUrl);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      return uddg;
    }
  } catch {
    // Keep rawUrl when DuckDuckGo returns a relative or already-decoded link.
  }
  return rawUrl;
}

function readHtmlAttribute(tagAttributes: string, attribute: string): string {
  return new RegExp(`\\b${attribute}="([^"]*)"`, "i").exec(tagAttributes)?.[1] ?? "";
}

function parseDuckDuckGoHtml(html: string): DuckSearchResult[] {
  const results: DuckSearchResult[] = [];
  const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;
  const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;

  for (const match of html.matchAll(resultRegex)) {
    const rawAttributes = match[1] ?? "";
    const rawTitle = match[2] ?? "";
    const rawUrl = readHtmlAttribute(rawAttributes, "href");
    const matchEnd = (match.index ?? 0) + match[0].length;
    const trailingHtml = html.slice(matchEnd);
    const nextResultIndex = trailingHtml.search(nextResultRegex);
    const scopedTrailingHtml =
      nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
    const rawSnippet = snippetRegex.exec(scopedTrailingHtml)?.[1] ?? "";
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
    const title = decodeHtmlEntities(stripHtml(rawTitle));
    const snippet = decodeHtmlEntities(stripHtml(rawSnippet));
    if (url && title) {
      results.push({ title, url, description: snippet });
    }
  }

  return results;
}

async function runDuckDuckGoSearch(params: {
  query: string;
  count: number;
  timeoutSeconds: number;
}): Promise<DuckSearchResult[]> {
  const url = new URL(DUCKDUCKGO_HTML_ENDPOINT);
  url.searchParams.set("q", params.query);

  return withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        const detail = detailResult.text;
        throw new Error(`DuckDuckGo search error (${res.status}): ${detail || res.statusText}`);
      }
      const html = await res.text();
      return parseDuckDuckGoHtml(html).slice(0, params.count);
    },
  );
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
    hint: "HTML web search · no API key required",
    envVars: [],
    placeholder: "No API key required",
    signupUrl: "https://duckduckgo.com/",
    docsUrl: "https://duckduckgo.com/",
    autoDetectOrder: 5,
    credentialPath: "plugins.entries.duckduckgo.config.webSearch.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: () => undefined,
    setConfiguredCredentialValue: () => {},
    createTool: (ctx) => createDuckDuckGoToolDefinition(ctx.searchConfig as SearchConfigRecord),
  };
}
