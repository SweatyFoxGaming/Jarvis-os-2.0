import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();
const GITHUB_API = "https://api.github.com";

export class GitHubIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new GitHubIntegrationError(
      "GITHUB_TOKEN is not set — GitHub capability is unavailable.",
      503
    );
  }
  return token;
}

async function githubRequest(path: string, init: RequestInit = {}): Promise<any> {
  const token = getToken();
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-os",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry(
      "warn",
      "Integrations",
      `GitHub API request failed: ${init.method || "GET"} ${path} -> ${res.status} ${body}`
    );
    throw new GitHubIntegrationError(`GitHub API error (${res.status}): ${body}`, res.status);
  }

  if (res.status === 204) return null;
  return res.json();
}

export async function getRepo(owner: string, repo: string) {
  return githubRequest(`/repos/${owner}/${repo}`);
}

export async function getFileContent(owner: string, repo: string, filePath: string, ref?: string) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const result = await githubRequest(`/repos/${owner}/${repo}/contents/${filePath}${query}`);
  if (Array.isArray(result)) {
    // directory listing
    return result.map((entry: any) => ({ name: entry.name, path: entry.path, type: entry.type, size: entry.size }));
  }
  if (result?.content && result?.encoding === "base64") {
    return { ...result, decodedContent: Buffer.from(result.content, "base64").toString("utf-8") };
  }
  return result;
}

export async function createIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]) {
  const created = await githubRequest(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body, labels }),
  });
  observation.logTelemetry("info", "Integrations", `GitHub issue created: ${owner}/${repo}#${created.number}`);
  return created;
}

export async function commentOnIssue(owner: string, repo: string, issueNumber: number, body: string) {
  const created = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  observation.logTelemetry("info", "Integrations", `GitHub comment posted on ${owner}/${repo}#${issueNumber}`);
  return created;
}

export async function createPullRequest(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string
) {
  const created = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body }),
  });
  observation.logTelemetry("info", "Integrations", `GitHub PR created: ${owner}/${repo}#${created.number}`);
  return created;
}

export async function listPullRequests(owner: string, repo: string, state: "open" | "closed" | "all" = "open") {
  return githubRequest(`/repos/${owner}/${repo}/pulls?state=${state}`);
}

export async function getPullRequest(owner: string, repo: string, pullNumber: number) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
}

/**
 * Real GitHub notifications (review requests, mentions, assigned issues,
 * ...) across every repo the token can see — no manually-configured "watch
 * list" needed, unlike everything else in this file which is scoped to one
 * repo per call. This is the real signal source for the proactive briefing
 * job in src/execution/briefing.ts.
 */
export async function getNotifications(): Promise<any[]> {
  return githubRequest(`/notifications?participating=true`);
}

export async function createBranch(owner: string, repo: string, branchName: string, baseBranch: string) {
  const baseRef = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef.object.sha;
  const created = await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  observation.logTelemetry("info", "Integrations", `GitHub branch created: ${owner}/${repo}@${branchName} (from ${baseBranch})`);
  return created;
}

// Creates the file if it doesn't exist on this branch yet, or updates it in
// place if it does — the Contents API requires the current file's `sha` for
// an update but rejects one for a genuinely new file, so this checks first.
export async function commitFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string
) {
  // Encode each path segment individually (preserving "/" as the literal
  // separator) rather than interpolating the raw path — the caller
  // (server.ts's approve-code route) already rejects traversal/absolute
  // paths, but an unencoded segment could still contain characters GitHub's
  // routing interprets differently than this codebase's own segment split
  // does. Used for both the existence check and the write so they always
  // resolve to the exact same resource.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");

  let existingSha: string | undefined;
  try {
    const existing = await getFileContent(owner, repo, encodedPath, branch);
    if (existing && !Array.isArray(existing) && typeof existing.sha === "string") {
      existingSha = existing.sha;
    }
  } catch (err: any) {
    if (!(err instanceof GitHubIntegrationError) || err.status !== 404) {
      throw err;
    }
    // 404 means the file doesn't exist yet on this branch — a genuine new file, not an error.
  }

  const created = await githubRequest(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf-8").toString("base64"),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
  observation.logTelemetry("info", "Integrations", `GitHub file committed: ${owner}/${repo}/${path}@${branch}`);
  return created;
}
