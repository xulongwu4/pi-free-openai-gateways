import { release } from "node:os";
import { CATALOG_TIMEOUT_MS, type DiscoveredModel, type GatewaySpec } from "./gateway.ts";

type RichCatalogEntry = {
  id?: string;
  name?: string;
  isFree?: boolean;
  context_length?: number;
  architecture?: { modality?: string; input_modalities?: string[] };
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  supported_parameters?: string[];
  pricing?: { prompt?: string | number; completion?: string | number };
};

type AIHubMixEntry = { id?: string; owned_by?: string };
type TokenRouterEntry = {
  id?: string;
  supported_endpoint_types?: string[];
  tags?: string;
};
type RecommendedEntry = { id?: string; name?: string };

function entries(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

function richModel(model: RichCatalogEntry & { id: string }, name = model.name): DiscoveredModel {
  const parameters = model.supported_parameters ?? [];
  const modalities = model.architecture?.input_modalities ?? [];
  return {
    id: model.id,
    name,
    reasoning: ["reasoning", "include_reasoning", "reasoning_effort"].some((key) => parameters.includes(key)),
    input: modalities.includes("image") || model.architecture?.modality?.includes("image")
      ? ["text", "image"]
      : ["text"],
    // These catalogs use 0 to mean "unspecified", so coerce it away and let
    // materialize() apply its defaults.
    contextWindow: model.context_length || model.top_provider?.context_length || undefined,
    maxTokens: model.top_provider?.max_completion_tokens || undefined,
  };
}

export function parseKiloCatalog(payload: unknown): DiscoveredModel[] {
  return (entries(payload) as RichCatalogEntry[])
    .filter((model): model is RichCatalogEntry & { id: string } =>
      Boolean(model.id) &&
      (model.isFree === true || model.id!.endsWith(":free")) &&
      (model.supported_parameters ?? []).includes("tools")
    )
    .map((model) => richModel(model));
}

const NON_CHAT_MODEL = /(?:audio|embed|image|ocr|rerank|speech|transcrib|tts)/i;

export function parseAIHubMixCatalog(payload: unknown): DiscoveredModel[] {
  return (entries(payload) as AIHubMixEntry[])
    .filter((model): model is AIHubMixEntry & { id: string } =>
      Boolean(model.id) && model.id!.endsWith("-free") && !NON_CHAT_MODEL.test(model.id!)
    )
    .map((model) => ({ id: model.id, name: model.id }));
}

function isExplicitlyFree(model: RichCatalogEntry): boolean {
  if (!model.id) return false;
  if (!(model.id.endsWith(":free") || model.id === "openrouter/free")) return false;
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion);
  return model.pricing?.prompt !== undefined &&
    model.pricing?.completion !== undefined &&
    Number.isFinite(prompt) &&
    Number.isFinite(completion) &&
    prompt === 0 &&
    completion === 0;
}

const TOKENROUTER_CHAT_ENDPOINTS = new Set([
  "openai",
  "openai-response",
  "anthropic",
  "anthropic-compatible",
  "gemini",
]);

function isTokenRouterTextChatModel(model: TokenRouterEntry): boolean {
  const tags = (model.tags ?? "").toLowerCase();
  if (tags.includes("text")) return true;
  if (["image", "video", "audio"].some((tag) => tags.includes(tag))) return false;
  return (model.supported_endpoint_types ?? []).some((type) => TOKENROUTER_CHAT_ENDPOINTS.has(type));
}

export function parseTokenRouterCatalog(payload: unknown): DiscoveredModel[] {
  return (entries(payload) as TokenRouterEntry[])
    .filter((model): model is TokenRouterEntry & { id: string } =>
      Boolean(model.id) &&
      (model.id!.endsWith(":free") || model.id!.endsWith("-free")) &&
      isTokenRouterTextChatModel(model)
    )
    .map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: /(?:reasoning|thinking|:think|-think)/i.test(model.id),
      input: (model.tags ?? "").toLowerCase().includes("image") ? ["text", "image"] : ["text"],
    }));
}

// recommended.free ids (cline-free/x, stealth/x) are the free routes; the catalog
// lists the same model under its vendor id (e.g. meta/x). Keep the recommended
// id and borrow metadata from the catalog entry with the same slug.
const slug = (id: string) => id.split("/").at(-1)!;

export function parseClineCatalog(payloads: readonly unknown[]): DiscoveredModel[] {
  const catalog = (entries(payloads[0]) as RichCatalogEntry[])
    .filter((model): model is RichCatalogEntry & { id: string } =>
      Boolean(model.id) && (model.supported_parameters ?? []).includes("tools")
    );
  const bySlug = new Map(catalog.map((model) => [slug(model.id), model]));
  const recommended = payloads[1] as { free?: RecommendedEntry[] } | undefined;
  const recommendedFree = (recommended?.free ?? []).flatMap((entry): DiscoveredModel[] => {
    if (!entry.id) return [];
    const match = bySlug.get(slug(entry.id));
    const name = entry.name ?? match?.name;
    return [match ? { ...richModel(match, name), id: entry.id } : { id: entry.id, name }];
  });
  return [...recommendedFree, ...catalog.filter(isExplicitlyFree).map((model) => richModel(model))];
}

export const KILO: GatewaySpec = {
  id: "kilo",
  name: "Kilo Gateway",
  baseUrl: "https://api.kilo.ai/api/gateway",
  apiKeyEnv: "KILO_API_KEY",
  compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  fallbackModels: [
    {
      id: "kilo-auto/free",
      name: "Auto Free",
      reasoning: true,
      input: ["text"],
      contextWindow: 256_000,
      maxTokens: 10_000,
    },
  ],
  catalogPaths: ["models"],
  parseCatalog: ([payload]) => parseKiloCatalog(payload),
};

export const AIHUBMIX: GatewaySpec = {
  id: "aihubmix",
  name: "AIHubMix",
  baseUrl: "https://aihubmix.com/v1",
  apiKeyEnv: "AIHUBMIX_API_KEY",
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsStore: false,
    maxTokensField: "max_tokens",
  },
  fallbackModels: [
    { id: "coding-glm-5.3-free", name: "coding-glm-5.3-free" },
  ],
  catalogPaths: ["models"],
  parseCatalog: ([payload]) => parseAIHubMixCatalog(payload),
};

export const CLINE: GatewaySpec = {
  id: "cline",
  name: "Cline",
  baseUrl: "https://api.cline.bot/api/v1",
  apiKeyEnv: "CLINE_API_KEY",
  compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
  fallbackModels: [
    {
      id: "z-ai/glm-5.3-flash",
      name: "glm-5.3-flash",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_310_720,
      maxTokens: 131_072,
    },
  ],
  catalogPaths: ["ai/cline/models", "ai/cline/recommended-models"],
  parseCatalog: parseClineCatalog,
};

// Cline gates its free routes behind "Cline product surfaces" (HTTP 403
// otherwise), so those requests identify as the Cline CLI, as pi-cline-pass does.
const CLINE_VERSION_PATTERN = /^[\w.\-+]+$/;
let clineVersion = "3.0.61";

export async function refreshClineVersion(fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const response = await fetcher("https://registry.npmjs.org/cline/latest", {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    const { version } = (await response.json()) as { version?: unknown };
    if (response.ok && typeof version === "string" && CLINE_VERSION_PATTERN.test(version)) clineVersion = version;
  } catch {
    // Keep the last known version.
  }
}

export function clineFreeRouteHeaders(
  model: { provider?: string; id?: string } | undefined,
): Record<string, string> | undefined {
  const id = model?.id ?? "";
  if (model?.provider !== CLINE.id || !(id.startsWith("cline-free/") || slug(id).endsWith(":free"))) return;
  return {
    "x-client-type": "cli",
    "x-client-version": clineVersion,
    "x-core-version": clineVersion,
    "x-platform": process.platform,
    "x-platform-version": release(),
  };
}

export const TOKENROUTER: GatewaySpec = {
  id: "tokenrouter",
  name: "TokenRouter",
  baseUrl: "https://api.tokenrouter.com/v1",
  apiKeyEnv: "TOKENROUTER_API_KEY",
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsStore: false,
    maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true,
  },
  fallbackModels: [
    { id: "qwen/qwen3.8-max-free", name: "qwen/qwen3.8-max-free" },
  ],
  catalogPaths: ["models"],
  catalogRequiresAuth: true,
  parseCatalog: ([payload]) => parseTokenRouterCatalog(payload),
};

export const GATEWAYS = [KILO, AIHUBMIX, CLINE, TOKENROUTER] as const;
