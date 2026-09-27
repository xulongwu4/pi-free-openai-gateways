import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { createGatewayProvider, getCachedOrFallbackModels, loadGatewayModels } from "./gateway.ts";
import {
  AIHUBMIX,
  CLINE,
  GATEWAYS,
  KILO,
  TOKENROUTER,
  clineFreeRouteHeaders,
  parseAIHubMixCatalog,
  parseClineCatalog,
  parseKiloCatalog,
  parseTokenRouterCatalog,
  refreshClineVersion,
} from "./providers.ts";

const kiloCatalog = {
  data: [
    {
      id: "free/tools:free",
      name: "Free Tools",
      isFree: true,
      context_length: 200_000,
      top_provider: { max_completion_tokens: 16_000 },
      supported_parameters: ["reasoning", "tools"],
      pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text", "image"] },
    },
    { id: "free/no-tools:free", isFree: true, supported_parameters: [] },
    { id: "paid/tools", isFree: false, supported_parameters: ["tools"] },
  ],
};

const aihubmixCatalog = {
  data: [
    { id: "coding-glm-free", owned_by: "Z.AI" },
    { id: "gpt-image-2-free", owned_by: "OpenAI" },
    { id: "claude-paid", owned_by: "Anthropic" },
  ],
};

const tokenrouterCatalog = {
  data: [
    { id: "qwen/model-free", supported_endpoint_types: ["openai"], tags: "text" },
    { id: "nvidia/model:free", supported_endpoint_types: ["openai"], tags: "text" },
    { id: "image/model-free", supported_endpoint_types: ["openai"], tags: "image" },
    { id: "paid/model", supported_endpoint_types: ["openai"], tags: "text" },
  ],
};

const clineCatalog = {
  data: [
    {
      id: "z-ai/glm-free",
      name: "GLM Free",
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 131_072 },
      supported_parameters: ["reasoning", "tools"],
      pricing: { prompt: "0.000001", completion: "0.000002" },
      architecture: { input_modalities: ["text", "image"] },
    },
    {
      id: "catalog/model:free",
      name: "Catalog Free",
      supported_parameters: ["tools"],
      pricing: { prompt: "0", completion: "0" },
    },
    {
      id: "openrouter/free",
      name: "OpenRouter Free",
      top_provider: { max_completion_tokens: 0 },
      supported_parameters: ["tools"],
      pricing: { prompt: 0, completion: 0 },
    },
    {
      id: "zero-but-not-free",
      name: "Zero but paid",
      supported_parameters: ["tools"],
      pricing: { prompt: "0", completion: "0" },
    },
    { id: "missing-price:free", name: "Unknown price", supported_parameters: ["tools"] },
    { id: "paid/model", name: "Paid", supported_parameters: ["tools"] },
  ],
};
const clineRecommended = {
  free: [
    { id: "z-ai/glm-free", name: "glm-free" },
    { id: "cline-free/glm-free", name: "Cline GLM" },
    { id: "stealth/uncatalogued", name: "Stealth" },
  ],
  clinePass: [{ id: "paid/model", name: "Paid" }],
};

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.includes("kilo.ai")) return Promise.resolve(Response.json(kiloCatalog));
  if (url.includes("tokenrouter.com")) return Promise.resolve(Response.json(tokenrouterCatalog));
  if (url.endsWith("recommended-models")) return Promise.resolve(Response.json(clineRecommended));
  if (url.includes("api.cline.bot")) return Promise.resolve(Response.json(clineCatalog));
  return Promise.resolve(Response.json(aihubmixCatalog));
}

function routedProvider(native: Provider, baseUrl: string): Provider {
  const apiKey = native.auth.apiKey!;
  return {
    ...native,
    baseUrl,
    auth: {
      apiKey: {
        ...apiKey,
        async resolve(input) {
          const result = await apiKey.resolve(input);
          return result ? { ...result, auth: { ...result.auth, baseUrl } } : undefined;
        },
      },
    },
  };
}

test("provider adapters keep only free chat-compatible models", () => {
  const kilo = parseKiloCatalog(kiloCatalog);
  assert.deepEqual(kilo.map((model) => model.id), ["free/tools:free"]);
  assert.deepEqual(kilo[0].input, ["text", "image"]);
  assert.equal(kilo[0].reasoning, true);

  const aihubmix = parseAIHubMixCatalog(aihubmixCatalog);
  assert.deepEqual(aihubmix.map((model) => model.id), ["coding-glm-free"]);

  const tokenrouter = parseTokenRouterCatalog(tokenrouterCatalog);
  assert.deepEqual(tokenrouter.map((model) => model.id), ["qwen/model-free", "nvidia/model:free"]);

  const cline = parseClineCatalog([clineCatalog, clineRecommended]);
  assert.deepEqual(cline.map((model) => model.id), [
    "z-ai/glm-free",
    "cline-free/glm-free",
    "stealth/uncatalogued",
    "catalog/model:free",
    "openrouter/free",
  ]);
  assert.deepEqual(cline[0].input, ["text", "image"]);
  assert.equal(cline[1].name, "Cline GLM");
  assert.equal(cline[1].contextWindow, 1_000_000, "cline-free/ ids borrow catalog metadata by slug");
  assert.equal(cline[2].contextWindow, undefined, "uncatalogued free entries keep defaults");

  assert.equal(clineFreeRouteHeaders({ provider: "cline", id: "cline-free/glm-free" })?.["x-client-type"], "cli");
  assert.ok(clineFreeRouteHeaders({ provider: "cline", id: "catalog/model:free" }));
  assert.equal(clineFreeRouteHeaders({ provider: "cline", id: "stealth/uncatalogued" }), undefined);
  assert.equal(clineFreeRouteHeaders({ provider: "kilo", id: "free/tools:free" }), undefined);
});

test("Cline keeps a partial free catalog and normalizes zero token limits", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cline-partial-"));
  try {
    const models = await loadGatewayModels(CLINE, (input) =>
      String(input).endsWith("recommended-models")
        ? Promise.resolve(new Response("down", { status: 503 }))
        : fakeFetch(input), agentDir);
    assert.deepEqual(models.map((model) => model.id), ["catalog/model:free", "openrouter/free"]);
    assert.equal(models.find((model) => model.id === "openrouter/free")?.maxTokens, 16_384);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Cline still lists recommended free models when the main catalog is down", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cline-catalog-down-"));
  try {
    const models = await loadGatewayModels(CLINE, (input) =>
      String(input).endsWith("recommended-models")
        ? fakeFetch(input)
        : Promise.resolve(new Response("down", { status: 503 })), agentDir);
    assert.deepEqual(models.map((model) => model.id), [
      "z-ai/glm-free",
      "cline-free/glm-free",
      "stealth/uncatalogued",
    ]);
    assert.ok(models.every((model) => model.contextWindow === 128_000 && model.maxTokens === 16_384));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("zero-cost models survive the cache round trip even when priced in the catalog", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-kilo-priced-"));
  try {
    const priced = {
      data: [{
        id: "vendor/model",
        name: "Priced but free",
        isFree: true,
        supported_parameters: ["tools"],
        pricing: { prompt: "0.0000005", completion: "0.000001" },
      }, {
        id: "vendor/other",
        name: "Also free",
        isFree: true,
        supported_parameters: ["tools"],
      }],
    };
    const live = await loadGatewayModels(KILO, () => Promise.resolve(Response.json(priced)), agentDir);
    assert.deepEqual(live.map((model) => model.id), ["vendor/model", "vendor/other"]);
    assert.deepEqual(live[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.notEqual(live[0].cost, live[1].cost, "each model needs its own cost object");
    assert.deepEqual(
      getCachedOrFallbackModels(KILO, agentDir).map((model) => model.id),
      ["vendor/model", "vendor/other"],
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("passes resolved API-key credentials to authenticated catalogs", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-tokenrouter-auth-"));
  let authorization: string | null = null;
  try {
    const provider = createGatewayProvider(TOKENROUTER, (input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return fakeFetch(input);
    }, agentDir);
    assert.deepEqual(provider.getModels().map((model) => model.id), ["qwen/qwen3.8-max-free"]);
    await provider.refreshModels!({
      credential: { type: "api_key", key: "secret" },
      stored: { models: [], checkedAt: 0 },
      allowNetwork: false,
      signal: new AbortController().signal,
      async publish(publication) {
        publication.update?.();
        return true;
      },
    });
    assert.deepEqual(provider.getModels().map((model) => model.id), ["qwen/qwen3.8-max-free"]);
    await provider.refreshModels!({
      credential: { type: "api_key", key: "secret" },
      allowNetwork: true,
      signal: new AbortController().signal,
      async publish(publication) {
        publication.update?.();
        return true;
      },
    });
    assert.equal(authorization, "Bearer secret");
    assert.deepEqual(provider.getModels().map((model) => model.id), [
      "qwen/model-free",
      "nvidia/model:free",
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("shared loader fetches all adapter paths, caches, and falls back offline", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-gateways-cache-"));
  try {
    for (const spec of GATEWAYS) {
      const requested: string[] = [];
      const authorizations: Array<string | null> = [];
      const live = await loadGatewayModels(spec, (input, init) => {
        requested.push(String(input));
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        return fakeFetch(input);
      }, agentDir, undefined, "test-key");
      assert.ok(live.every((model) => Object.values(model.cost).every((cost) => cost === 0)));
      assert.deepEqual(requested, spec.catalogPaths.map((path) => `${spec.baseUrl}/${path}`));
      assert.ok(authorizations.every((header) =>
        spec.catalogRequiresAuth ? header === "Bearer test-key" : header === null
      ));
      const path = join(agentDir, spec.id, "models.json");
      assert.equal(existsSync(path), true);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(JSON.stringify(live)));
      const offline = () => Promise.resolve(new Response("down", { status: 503 }));
      assert.deepEqual(
        await loadGatewayModels(spec, offline, agentDir, undefined, "test-key"),
        JSON.parse(JSON.stringify(live)),
      );
      if (spec === CLINE) {
        writeFileSync(path, JSON.stringify([{
          ...live[0],
          id: "paid/model",
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        }]));
        assert.equal(getCachedOrFallbackModels(spec, agentDir)[0].id, spec.fallbackModels[0].id);
      }
      writeFileSync(path, "not json");
      assert.equal(getCachedOrFallbackModels(spec, agentDir)[0].id, spec.fallbackModels[0].id);
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("registers all native providers and refreshes without blocking startup", async () => {
  const providers: Provider[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  let finishRefresh!: (value: { errors: Map<string, Error> }) => void;
  const pending = new Promise<{ errors: Map<string, Error> }>((resolve) => { finishRefresh = resolve; });
  const realFetch = globalThis.fetch;
  let npmVersion: Promise<Response> = Promise.resolve(Response.json({ version: "9.9.9" }));
  globalThis.fetch = (() => npmVersion) as typeof fetch;

  try {
    extension({
      registerProvider(provider: Provider) { providers.push(provider); },
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as any);

    assert.deepEqual(providers.map((provider) => provider.id), ["kilo", "aihubmix", "cline", "tokenrouter"]);
    assert.ok(providers.every((provider) => provider.auth.apiKey));
    const returned = handlers.get("session_start")!.map((handler) =>
      handler({}, { modelRegistry: { refresh: () => pending } })
    );
    assert.deepEqual(returned, [undefined, undefined], "session_start handlers must not block startup");
    finishRefresh({ errors: new Map() });
    await pending;
    await npmVersion;
    await new Promise((resolve) => setImmediate(resolve));

    const [headersHook] = handlers.get("before_provider_headers")!;
    const headersFor = (model: { provider: string; id: string }) => {
      const event = { headers: { authorization: "Bearer x" } as Record<string, string> };
      headersHook(event, { model });
      return event.headers;
    };
    assert.equal(headersFor({ provider: "cline", id: "cline-free/x" })["x-client-version"], "9.9.9");
    assert.deepEqual(headersFor({ provider: "kilo", id: "x/y:free" }), { authorization: "Bearer x" });
    assert.deepEqual(headersFor({ provider: "cline", id: "stealth/x" }), { authorization: "Bearer x" });

    // Failed or malformed registry responses keep the last good version.
    await refreshClineVersion(() => Promise.resolve(new Response("down", { status: 503 })));
    await refreshClineVersion(() => Promise.resolve(Response.json({ version: "1.0\r\nx-evil: 1" })));
    await refreshClineVersion(() => Promise.reject(new Error("offline")));
    assert.equal(clineFreeRouteHeaders({ provider: "cline", id: "cline-free/x" })?.["x-client-version"], "9.9.9");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("models.json baseUrl and route-marker wrapping survive dynamic refresh", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-gateways-route-"));
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({
    providers: { kilo: { baseUrl: "http://localhost:8788", routeMarker: "route_to" } },
  }));
  process.env.KILO_API_KEY = "test-key";

  try {
    const runtime = await ModelRuntime.create({ modelsPath, authPath: join(agentDir, "auth.json") });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider(createGatewayProvider(KILO, fakeFetch, agentDir));
    assert.equal(runtime.getModels("kilo")[0].baseUrl, "http://localhost:8788");

    const native = registry.getRegisteredNativeProvider("kilo")!;
    const routedBaseUrl = `http://localhost:8788/route_to/${KILO.baseUrl}`;
    registry.registerProvider(routedProvider(native, routedBaseUrl));
    await registry.refresh({ providers: ["kilo"], force: true });

    assert.equal((await runtime.getAuth("kilo"))?.auth.baseUrl, routedBaseUrl);
    assert.ok(runtime.getModels("kilo").some((model) => model.id === "free/tools:free"));
    assert.ok(runtime.getModels("kilo").every((model) => model.id.includes("free")));
  } finally {
    delete process.env.KILO_API_KEY;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("provider constants use documented endpoints and API-key variables", () => {
  assert.deepEqual(
    [KILO, AIHUBMIX, CLINE, TOKENROUTER].map(({ id, baseUrl, apiKeyEnv }) => ({ id, baseUrl, apiKeyEnv })),
    [
      { id: "kilo", baseUrl: "https://api.kilo.ai/api/gateway", apiKeyEnv: "KILO_API_KEY" },
      { id: "aihubmix", baseUrl: "https://aihubmix.com/v1", apiKeyEnv: "AIHUBMIX_API_KEY" },
      { id: "cline", baseUrl: "https://api.cline.bot/api/v1", apiKeyEnv: "CLINE_API_KEY" },
      { id: "tokenrouter", baseUrl: "https://api.tokenrouter.com/v1", apiKeyEnv: "TOKENROUTER_API_KEY" },
    ],
  );
});
