import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installGateways } from "./gateway.ts";
import { clineFreeRouteHeaders, GATEWAYS, refreshClineVersion } from "./providers.ts";

export * from "./gateway.ts";
export * from "./providers.ts";

export default function openAIGatewaysExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => void refreshClineVersion());
  pi.on("before_provider_headers", (event, ctx) => {
    const headers = clineFreeRouteHeaders(ctx.model);
    if (headers) Object.assign(event.headers, headers);
  });
  installGateways(pi, GATEWAYS);
}
