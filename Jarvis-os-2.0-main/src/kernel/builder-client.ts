import * as http from "node:http";
import { ObservationPlatform } from "./observation.js";

const observation = ObservationPlatform.getInstance();
const BUILDER_HOST = "jarvis-builder";
const BUILDER_PORT = 4100;

export class BuilderClientError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

function getSecret(): string {
  const secret = process.env.JARVIS_BUILDER_SECRET;
  if (!secret) {
    throw new BuilderClientError(
      "JARVIS_BUILDER_SECRET is not set — the sandboxed coding agent is unavailable.",
      503
    );
  }
  return secret;
}

// Long-running exec calls (a fresh `npm ci && npm test && npx tsc --noEmit`,
// or any shell command the coding agent issues) can legitimately take
// minutes — global `fetch`'s underlying undici dispatcher enforces a ~300s
// headersTimeout with no way to disable it via RequestInit, so a slow-but-
// healthy verification pass would be indistinguishable from a real timeout,
// and the client giving up doesn't cancel the still-running `docker exec`
// server-side (verified empirically: UND_ERR_HEADERS_TIMEOUT at 301s on this
// runtime). node:http has no such default, and jarvis-builder is a fixed
// plain-HTTP internal service (http://jarvis-builder:4100), so this avoids
// adding a dependency just to configure fetch's dispatcher. 30 minutes is a
// generous-but-bounded backstop, not truly unbounded.
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function builderRequest(path: string, method: string, body?: string): Promise<any> {
  const secret = getSecret();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: BUILDER_HOST,
        port: BUILDER_PORT,
        path,
        method,
        headers: {
          "X-Builder-Secret": secret,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", (err: any) => {
          reject(new BuilderClientError(`jarvis-builder response failed: ${err.message}`, 502));
        });
        res.on("close", () => {
          if (!res.complete) {
            reject(new BuilderClientError("jarvis-builder closed the connection before the response completed", 502));
          }
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode || 500;
          if (status < 200 || status >= 300) {
            observation.logTelemetry(
              "warn",
              "Executive",
              `jarvis-builder request failed: ${method} ${path} -> ${status} ${text}`
            );
            reject(new BuilderClientError(`jarvis-builder error (${status}): ${text}`, status));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : undefined);
          } catch (err: any) {
            reject(new BuilderClientError(`jarvis-builder returned invalid JSON: ${err.message}`, 502));
          }
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(
        new BuilderClientError(
          `jarvis-builder request timed out after ${REQUEST_TIMEOUT_MS / 60000} minutes`,
          504
        )
      );
    });
    req.on("error", (err: any) => {
      reject(
        err instanceof BuilderClientError
          ? err
          : new BuilderClientError(`jarvis-builder request failed: ${err.message}`, 502)
      );
    });
    if (body) req.write(body);
    req.end();
  });
}

export interface WorkspaceHandle {
  buildRequestId: number;
  branch: string;
  containerName: string;
}

export async function createWorkspace(buildRequestId: number, baseBranch: string): Promise<WorkspaceHandle> {
  return builderRequest("/workspaces", "POST", JSON.stringify({ buildRequestId, baseBranch }));
}

export async function execInWorkspace(
  buildRequestId: number,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return builderRequest(`/workspaces/${buildRequestId}/exec`, "POST", JSON.stringify({ command }));
}

export async function destroyWorkspace(buildRequestId: number): Promise<void> {
  await builderRequest(`/workspaces/${buildRequestId}`, "DELETE");
}

// Ad-hoc chat sandboxes — keyed by username, not a build request id. No
// separate "create" call: jarvis-builder creates the sandbox on first use
// and reuses it across calls until it's idle-reaped, so this is the only
// function most callers (see run_sandbox_command in tools.ts) need.
export async function execInChatSandbox(
  username: string,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return builderRequest(`/chat-sandboxes/${encodeURIComponent(username)}/exec`, "POST", JSON.stringify({ command }));
}

export async function destroyChatSandbox(username: string): Promise<void> {
  await builderRequest(`/chat-sandboxes/${encodeURIComponent(username)}`, "DELETE");
}
