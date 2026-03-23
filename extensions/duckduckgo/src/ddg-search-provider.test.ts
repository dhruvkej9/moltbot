import { beforeEach, describe, expect, it, vi } from "vitest";

describe("duckduckgo web search provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("exposes keyless metadata and enables the plugin in config", async () => {
    const { createDuckDuckGoWebSearchProvider } = await import("./ddg-search-provider.js");

    const provider = createDuckDuckGoWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("duckduckgo");
    expect(provider.label).toBe("DuckDuckGo Search (experimental)");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.duckduckgo?.enabled).toBe(true);
  });

  it("maps generic tool arguments into DuckDuckGo search params", async () => {
    const ddgClient = await import("./ddg-client.js");
    const runDuckDuckGoSearch = vi
      .spyOn(ddgClient, "runDuckDuckGoSearch")
      .mockImplementation(async (params) => params);
    const { createDuckDuckGoWebSearchProvider } = await import("./ddg-search-provider.js");
    const provider = createDuckDuckGoWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });

    expect(runDuckDuckGoSearch).toHaveBeenCalledWith({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });
    expect(result).toEqual({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });
  });
});
