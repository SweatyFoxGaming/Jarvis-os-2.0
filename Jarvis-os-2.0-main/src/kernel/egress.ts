import { isIP } from "net";

/**
 * Single choke point for outbound HTTP requests to a URL that ultimately
 * came from a user, an admin form, or an LLM — the local-LLM endpoint
 * setting, the "test connection" probe, and MCP server registration all
 * dial an operator/LLM-supplied URL. Capability grants (settings.write,
 * system.mcp_manage) already gate *who* can set these; this gates *where*
 * the resulting request is allowed to land.
 *
 * Deliberately narrow: this does NOT block loopback or RFC1918 private
 * ranges — a local LLM server (Ollama/LM Studio on localhost, or a GPU box
 * on the home LAN) is the primary, intended target for exactly the settings
 * this guards, and a home-network MCP server is equally plausible. Blocking
 * those would break the product's own default configuration
 * ("http://localhost:11434" is the frontend's own placeholder), not harden
 * it. What it does block is link-local addresses (169.254.0.0/16 and
 * fe80::/10) — the range that has no legitimate reason to ever be an LLM or
 * MCP endpoint, but that on a cloud VM includes the instance metadata
 * service (169.254.169.254), which is exactly what an SSRF-style probe
 * through these endpoints would be worth reaching.
 *
 * This is a hostname/IP-literal check performed once before the request, not
 * a DNS-rebinding-proof sandbox — a hostname that only resolves to a
 * link-local address at connect time slips past it. Raises the bar; doesn't
 * eliminate the class of bug. A resolved-address check at connect time (a
 * custom fetch/dispatcher) would close that gap but is a larger change than
 * this pass covers.
 */
export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function isLinkLocal(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) return /^169\.254\./.test(hostname);
  if (version === 6) {
    const h = hostname.toLowerCase();
    return h.startsWith("fe80:") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb");
  }
  return false;
}

// Was duplicated verbatim in both the settings "test connection" handler and
// the chat endpoint's LocalLLM branch (src/server.ts) — one shared place for
// the shape-guessing logic so a future OpenAI-compatible endpoint shape only
// needs to be taught here once.
export function normalizeLocalLlmUrl(endpoint: string): string {
  let targetUrl = endpoint;
  if (!targetUrl.endsWith("/chat/completions") && !targetUrl.endsWith("/generate") && !targetUrl.endsWith("/api/chat")) {
    if (targetUrl.endsWith("/v1") || targetUrl.endsWith("/v1/")) {
      targetUrl = targetUrl.replace(/\/$/, "") + "/chat/completions";
    } else {
      targetUrl = targetUrl.replace(/\/$/, "") + "/v1/chat/completions";
    }
  }
  return targetUrl;
}

export function assertSafeEgressUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError(`Invalid URL: "${rawUrl}"`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressBlockedError(`Refusing to fetch non-HTTP(S) URL: "${rawUrl}"`);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLinkLocal(hostname)) {
    throw new EgressBlockedError(
      `Refusing to fetch link-local address "${hostname}" — this range (169.254.0.0/16, fe80::/10) has no legitimate use as an LLM or MCP endpoint and includes cloud instance-metadata services on most providers.`
    );
  }

  return url;
}
