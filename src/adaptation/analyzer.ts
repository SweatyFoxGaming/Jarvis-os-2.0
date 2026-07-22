import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

/**
 * Real self-analysis, replacing what used to be hardcoded literals
 * (`{ score: 98, issues: [] }` for every category, always, no matter what).
 * Each function here computes its score from something actually measured —
 * a parsed import graph, real tsc/grep output, real telemetry, a real
 * pattern scan — not a decorative number. Scores can be boring or even bad;
 * that's the point.
 */

export interface AnalysisIssue {
  severity: "low" | "medium" | "high";
  message: string;
  file?: string;
}

export interface AnalysisResult {
  score: number;
  issues: AnalysisIssue[];
}

const SRC_ROOT = path.resolve(process.cwd(), "src");

function listSourceFiles(extensions: string[]): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some(ext => entry.name.endsWith(ext))) results.push(full);
    }
  }
  walk(SRC_ROOT);
  return results;
}

// ---------- Architecture: a real import graph + real cycle detection ----------

export interface DependencyGraph {
  nodes: string[];
  edges: { from: string; to: string }[];
}

const RELATIVE_IMPORT_RE = /from\s+["'](\.\.?\/[^"']+)["']/g;

function resolveImport(fromFile: string, importPath: string): string | null {
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, importPath);
  if (resolved.endsWith(".js")) resolved = resolved.slice(0, -3);
  const candidates = [resolved + ".ts", resolved + "/index.ts", resolved];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function buildDependencyGraph(): DependencyGraph {
  const files = listSourceFiles([".ts"]);
  const nodes = files.map(f => path.relative(SRC_ROOT, f));
  const edges: { from: string; to: string }[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    let match;
    RELATIVE_IMPORT_RE.lastIndex = 0;
    while ((match = RELATIVE_IMPORT_RE.exec(content)) !== null) {
      const resolved = resolveImport(file, match[1]);
      if (resolved) {
        edges.push({
          from: path.relative(SRC_ROOT, file),
          to: path.relative(SRC_ROOT, resolved),
        });
      }
    }
  }

  return { nodes, edges };
}

function findCycles(graph: DependencyGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node, []);
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)!.push(edge.to);
  }

  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string) {
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      if (cycleStart !== -1) cycles.push(stack.slice(cycleStart).concat(node));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) || []) {
      dfs(next);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.nodes) {
    if (!visited.has(node)) dfs(node);
  }
  return cycles;
}

export function analyzeArchitecture(): AnalysisResult {
  const graph = buildDependencyGraph();
  const cycles = findCycles(graph);
  const orphans = graph.nodes.filter(n => {
    const hasIncoming = graph.edges.some(e => e.to === n);
    const hasOutgoing = graph.edges.some(e => e.from === n);
    return !hasIncoming && !hasOutgoing && !n.endsWith("server.ts");
  });

  const issues: AnalysisIssue[] = [];
  for (const cycle of cycles) {
    issues.push({ severity: "medium", message: `Circular dependency: ${cycle.join(" -> ")}` });
  }
  for (const orphan of orphans) {
    issues.push({ severity: "low", message: `File has no detected imports/importers — possibly dead code`, file: orphan });
  }

  const score = Math.max(0, 100 - cycles.length * 15 - orphans.length * 3);
  return { score, issues };
}

// ---------- Quality: real tsc diagnostics + real TODO/FIXME count ----------

export function analyzeQuality(): AnalysisResult {
  const issues: AnalysisIssue[] = [];
  let tscErrorCount = 0;

  try {
    execSync("npx tsc --noEmit", { cwd: process.cwd(), stdio: "pipe" });
  } catch (err: any) {
    const output: string = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
    const lines = output.split("\n").filter((l: string) => /error TS\d+/.test(l));
    tscErrorCount = lines.length;
    for (const line of lines.slice(0, 20)) {
      issues.push({ severity: "high", message: line.trim() });
    }
  }

  let todoCount = 0;
  const files = listSourceFiles([".ts"]);
  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const matches = content.match(/\/\/\s*(TODO|FIXME|HACK)\b/g);
    if (matches) {
      todoCount += matches.length;
      issues.push({ severity: "low", message: `${matches.length} TODO/FIXME/HACK marker(s)`, file: path.relative(SRC_ROOT, file) });
    }
  }

  const score = Math.max(0, 100 - tscErrorCount * 10 - todoCount * 2);
  return { score, issues };
}

// ---------- Performance: real, currently-observed telemetry ----------

export function analyzePerformance(): AnalysisResult {
  const metrics = observation.getMetrics().counters;
  const issues: AnalysisIssue[] = [];

  if (metrics.totalRequests === 0) {
    issues.push({ severity: "low", message: "No requests observed yet this process lifetime — score is not yet meaningful." });
    return { score: 100, issues };
  }

  const avgLatency = metrics.averageLatencyMs;
  if (avgLatency > 60000) {
    issues.push({ severity: "high", message: `Average latency ${avgLatency.toFixed(0)}ms exceeds 60s (expected for CPU local-LLM chat, but flagged for visibility)` });
  } else if (avgLatency > 10000) {
    issues.push({ severity: "medium", message: `Average latency ${avgLatency.toFixed(0)}ms is above 10s` });
  }

  const errorRate = metrics.errorsLogged / Math.max(1, metrics.totalRequests);
  if (errorRate > 0.05) {
    issues.push({ severity: "high", message: `Error rate ${(errorRate * 100).toFixed(1)}% exceeds 5% of requests` });
  }

  // Latency scoring intentionally lenient below 10s — this project's own
  // docs note 90-130s is the expected, non-buggy cost of CPU local inference.
  let latencyScore = 100;
  if (avgLatency > 10000) latencyScore = Math.max(40, 100 - (avgLatency - 10000) / 2000);
  const errorScore = Math.max(0, 100 - errorRate * 1000);
  const score = Math.round((latencyScore + errorScore) / 2);

  return { score, issues };
}

// ---------- Security: real pattern scan for secrets and dangerous calls ----------

const SECRET_LIKE_RE = /\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*["'][A-Za-z0-9_\-\.]{16,}["']/gi;
const DANGEROUS_CALL_RE = /\beval\s*\(|child_process\.exec\s*\(/g;

export function analyzeSecurity(): AnalysisResult {
  const issues: AnalysisIssue[] = [];
  const files = listSourceFiles([".ts", ".py"]);

  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file);
    const content = fs.readFileSync(file, "utf-8");

    SECRET_LIKE_RE.lastIndex = 0;
    let match;
    while ((match = SECRET_LIKE_RE.exec(content)) !== null) {
      issues.push({ severity: "high", message: `Possible hardcoded secret: "${match[0].slice(0, 60)}..."`, file: rel });
    }

    DANGEROUS_CALL_RE.lastIndex = 0;
    while ((match = DANGEROUS_CALL_RE.exec(content)) !== null) {
      issues.push({ severity: "medium", message: `Use of ${match[0]} — verify input is not user-controlled`, file: rel });
    }
  }

  try {
    const gitignore = fs.readFileSync(path.resolve(process.cwd(), ".gitignore"), "utf-8");
    if (!gitignore.includes(".env")) {
      issues.push({ severity: "high", message: ".gitignore does not exclude .env — real credentials could be committed" });
    }
  } catch {
    issues.push({ severity: "medium", message: "No .gitignore found at repo root" });
  }

  const highCount = issues.filter(i => i.severity === "high").length;
  const mediumCount = issues.filter(i => i.severity === "medium").length;
  const score = Math.max(0, 100 - highCount * 20 - mediumCount * 5);
  return { score, issues };
}
