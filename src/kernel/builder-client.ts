import { ObservationPlatform } from "./observation.js";

const observation = ObservationPlatform.getInstance();
const BUILDER_URL = "http://jarvis-builder:4100";

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

async function builderRequest(path: string, init: RequestInit = {}): Promise<any> {
  const secret = getSecret();
  const res = await fetch(`${BUILDER_URL}${path}`, {
    ...init,
    headers: {
      "X-Builder-Secret": secret,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry(
      "warn",
      "Executive",
      `jarvis-builder request failed: ${init.method || "GET"} ${path} -> ${res.status} ${body}`
    );
    throw new BuilderClientError(`jarvis-builder error (${res.status}): ${body}`, res.status);
  }
  return res.json();
}

export interface WorkspaceHandle {
  buildRequestId: number;
  branch: string;
  containerName: string;
}

export async function createWorkspace(buildRequestId: number, baseBranch: string): Promise<WorkspaceHandle> {
  return builderRequest("/workspaces", {
    method: "POST",
    body: JSON.stringify({ buildRequestId, baseBranch }),
  });
}

export async function execInWorkspace(
  buildRequestId: number,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return builderRequest(`/workspaces/${buildRequestId}/exec`, {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

export async function destroyWorkspace(buildRequestId: number): Promise<void> {
  await builderRequest(`/workspaces/${buildRequestId}`, { method: "DELETE" });
}
