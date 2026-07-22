/**
 * Unified Automated Test Suite for Jarvis OS
 * Validates Platform, Integration, Simulation, Regression, Executive, Cognitive, Capability, Environment, and Autonomous modules.
 * Rewritten to support fully sequential awaited execution of async and sync suites.
 */

import { CognitiveWorkspace } from "../src/cognition/workspace.js";
import { SessionState, getSession } from "../src/cognition/session.js";
import { ObservationPlatform } from "../src/observation/index.js";
import { AutonomousExecutive } from "../src/execution/autonomous_executive.js";
import { LongTermLearningEngine } from "../src/cognition/long_term_learning.js";
import { ExecutiveBoard } from "../src/execution/executive_board.js";
import { grantCapability, revokeCapability, hasGrant, listGrants } from "../src/execution/permissions.js";
import { executeTool, getAllToolDeclarations } from "../src/execution/tools.js";
import { embedText, remember, recall } from "../src/cognition/memory-store.js";
import { pushNotification, getNotifications, markAllRead, registerJob } from "../src/execution/scheduler.js";
import { buildIdentityContext, generateProactiveThought, extractSelfReflection } from "../src/cognition/identity.js";
import { extractAndStore } from "../src/cognition/knowledge-graph.js";
import { reflectAndLearn } from "../src/cognition/reflection.js";
import { ConfidenceModel } from "../src/cognition/kernel/confidence.js";
import { proposeMcpServer, getMcpServer, listMcpServers, markMcpServerApproved, setMcpServerStatus } from "../src/data/mcp-servers-repo.js";
import {
  createBuildRequest,
  getBuildRequest,
  getLatestAwaitingConsult,
  listBuildRequests,
  recordDirectionConfirmed,
  rejectCode as rejectBuildCode,
} from "../src/data/build-requests-repo.js";
import { isValidToolSchema, getCachedMcpTools } from "../src/execution/mcp-registry.js";
import * as departments from "../src/execution/departments.js";
import { toGroqSchema, toGroqTools } from "../src/cognition/groq-client.js";
import { spawn, ChildProcess } from "child_process";
import net from "net";

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  error?: string;
}

interface TestDef {
  category: string;
  name: string;
  fn: () => void | Promise<void>;
}

const tests: TestDef[] = [];

function registerTest(category: string, name: string, fn: () => void | Promise<void>) {
  tests.push({ category, name, fn });
}

// ---------- 1. Platform Tests ----------
registerTest("Platform", "Workspace separation of concerns", () => {
  const ws = new CognitiveWorkspace();
  if (ws.goal.activeGoal !== "Align system with human preferences") {
    throw new Error("Goal Context initial value mismatch");
  }
  if (ws.plan.status !== "idle") {
    throw new Error("Execution Context initial state mismatch");
  }
  if (ws.userContext.loadedFacts.length < 3) {
    throw new Error("Knowledge Context initial rules are missing");
  }
});

// ---------- 2. Cognitive Tests ----------
registerTest("Cognitive", "Dynamic memory and preference caching", () => {
  const ws = new CognitiveWorkspace();
  ws.userContext.addFact("User prefers typescript over python");
  ws.userContext.setPreference("notifications", "vibrate");

  if (!ws.userContext.loadedFacts.includes("User prefers typescript over python")) {
    throw new Error("Failed to add dynamic facts into Knowledge Context");
  }
  if (ws.userContext.userPreferences.notifications !== "vibrate") {
    throw new Error("Failed to assign user preferences dynamically");
  }
});

// ---------- 3. Executive Tests ----------
registerTest("Executive", "Intent planning loops and goal credits", () => {
  const ws = new CognitiveWorkspace();
  ws.goal.setGoal("Build deep testing suite", 10, 50);

  if (ws.goal.activeGoal !== "Build deep testing suite") {
    throw new Error("Failed to schedule custom objective");
  }
  if (ws.goal.priority !== 10) {
    throw new Error("Incorrect priority assignment");
  }
  if (ws.goal.budgetCredits !== 50) {
    throw new Error("Incorrect goal credit thresholds");
  }
});

// ---------- 4. Capability Tests ----------
registerTest("Capability", "Capability registry tracking", () => {
  const ws = new CognitiveWorkspace();
  ws.capabilities.setCapability("PostgreSQL Vector Matcher");
  ws.capabilities.recordResult({ matched_nodes: 5, latency: 45 });

  if (ws.capabilities.selectedCapability !== "PostgreSQL Vector Matcher") {
    throw new Error("Selected capability was not successfully bound");
  }
  if (ws.capabilities.lastExecutionResult.matched_nodes !== 5) {
    throw new Error("Failed to cache capability results cleanly");
  }
});

// ---------- 5. Environment Tests ----------
registerTest("Environment", "Host OS boundaries verification", () => {
  const ws = new CognitiveWorkspace();
  ws.environment.updateMetrics("darwin", true, 3);

  if (ws.environment.osType !== "darwin") {
    throw new Error("Failed to cache Host OS metric");
  }
  if (!ws.environment.networkConnected) {
    throw new Error("Incorrect network metrics assignment");
  }
  if (ws.environment.activeSessionsCount !== 3) {
    throw new Error("Incorrect concurrent session counter");
  }
});

// ---------- 6. Cognitive Workspace 2.0 Compartment Tests ----------
registerTest("Cognitive 2.0", "Working memory compartment cells validation", () => {
  const ws = new CognitiveWorkspace();
  
  // Verify Compartment 1: Current Mission
  ws.mission.setMission("Develop Flask API", "in_progress", 45);
  if (ws.mission.currentMission !== "Develop Flask API" || ws.mission.progressPercent !== 45) {
    throw new Error("Workspace 2.0: Mission compartment failed verification");
  }

  // Verify Compartment 2: Current Thought
  ws.thought.setThought("Thinking about database migrations", 0.8);
  if (ws.thought.activeThought !== "Thinking about database migrations" || ws.thought.intensity !== 0.8) {
    throw new Error("Workspace 2.0: Thought compartment failed verification");
  }

  // Verify Compartment 3: Current Goal
  ws.goal.setGoal("Establish deep testing suite", 9, 70);
  if (ws.goal.activeGoal !== "Establish deep testing suite" || ws.goal.priority !== 9) {
    throw new Error("Workspace 2.0: Goal compartment failed verification");
  }

  // Verify Compartment 4: Current Plan
  ws.plan.setPlan(["Step 1", "Step 2"]);
  ws.plan.advanceStep();
  if (ws.plan.steps.length !== 2 || ws.plan.currentStepIndex !== 1) {
    throw new Error("Workspace 2.0: Plan compartment failed verification");
  }

  // Verify Compartment 5: Current Environment
  ws.environment.updateMetrics("win32", false, 0);
  if (ws.environment.osType !== "win32" || ws.environment.networkConnected) {
    throw new Error("Workspace 2.0: Environment compartment failed verification");
  }

  // Verify Compartment 6: Current User Context
  ws.userContext.addFact("User is a senior cloud engineer");
  ws.userContext.setPreference("accessibility", "high-contrast");
  if (!ws.userContext.loadedFacts.includes("User is a senior cloud engineer") || ws.userContext.userPreferences.accessibility !== "high-contrast") {
    throw new Error("Workspace 2.0: UserContext compartment failed verification");
  }

  // Verify Compartment 7: Active Capabilities
  ws.capabilities.setCapability("Gemini Pro Live");
  ws.capabilities.recordResult({ latency: 15 });
  if (ws.capabilities.selectedCapability !== "Gemini Pro Live" || ws.capabilities.lastExecutionResult.latency !== 15) {
    throw new Error("Workspace 2.0: Capabilities compartment failed verification");
  }

  // Verify Compartment 8: Attention
  ws.attention.focusOn("src/server.ts");
  ws.attention.focusVariable("app");
  if (!ws.attention.focusedFiles.includes("src/server.ts") || !ws.attention.focusedVariables.includes("app")) {
    throw new Error("Workspace 2.0: Attention compartment failed verification");
  }

  // Verify Compartment 9: Reasoning State
  ws.reasoningState.setThought("Synthesized debate context complete", 0.99);
  if (ws.reasoningState.currentThought !== "Synthesized debate context complete" || ws.reasoningState.confidenceScore !== 0.99) {
    throw new Error("Workspace 2.0: Reasoning State compartment failed verification");
  }
});

// ---------- 7. Autonomous Executive Tests ----------
registerTest("Executive 2.0", "Autonomous executive real dispatch pipeline (no AI available)", async () => {
  const session = new SessionState();
  const obs = ObservationPlatform.getInstance();
  const exec = AutonomousExecutive.getInstance(obs, null); // No AI client — exercises the degrade-safety fallback path

  const report = await exec.executeObjective("Deploy microservices orchestrator", session, "test_user");

  if (report.status !== "success") {
    throw new Error("Autonomous Executive: Execution status mismatch");
  }
  if (report.totalStepsExecuted !== 1) {
    throw new Error(`Autonomous Executive: expected 1 step in the no-AI fallback, got ${report.totalStepsExecuted}`);
  }
  if (!report.findings?.[0]?.includes("No capable model is available")) {
    throw new Error("Autonomous Executive: expected the no-AI research fallback message in findings");
  }
  if (session.workspace.mission.status !== "completed") {
    throw new Error("Autonomous Executive: Mission status did not resolve to 'completed'");
  }
  if (session.workspace.mission.progressPercent !== 100) {
    throw new Error("Autonomous Executive: Mission progress percent did not resolve to 100%");
  }
});

// ---------- 7.5. Long-Term Learning Adaptation Tests ----------
registerTest("Learning 2.0", "Persistent style, workflow, and mistake adaptation", () => {
  const engine = LongTermLearningEngine.getInstance();

  // Test 1: Style caching
  engine.updateStylePreference({ namingConvention: "snake_case", tabSize: 4 });
  const prefs = engine.getStylePreferences();
  if (prefs.namingConvention !== "snake_case" || prefs.tabSize !== 4) {
    throw new Error("Learning Engine: Style cache failed to persist preference changes");
  }

  // Test 2: Workflow optimization
  engine.optimizeWorkflow("Generate test reports", ["Read code coverage", "Write summary report"], 450);
  const flow = engine.getOptimizedWorkflow("Generate test reports");
  if (!flow || flow.optimizedSteps.length !== 2 || flow.averageLatencyMs !== 450) {
    throw new Error("Learning Engine: Workflow optimizer failed to cache successful plans");
  }

  // Test 3: Mistake logging and proactive search
  engine.logMistake(
    "TypeError: Cannot read properties of undefined (reading 'toSnapshot')",
    "src/server.ts",
    "Accessing workspace before instantiation.",
    "Instantiate CognitiveWorkspace as top level assignment."
  );
  const fixEntry = engine.searchFixForError("toSnapshot");
  if (!fixEntry || fixEntry.affectedFile !== "src/server.ts" || !fixEntry.successfulFix.includes("Instantiate")) {
    throw new Error("Learning Engine: Mistake log failed to match signature and locate fix");
  }
});

// ---------- 7.6. Multi-Agent Executive Board Consensus Tests ----------
registerTest("Consensus 2.0", "Multi-agent virtual board debate and voting", async () => {
  const board = new ExecutiveBoard();
  
  // Test 1: Code with potential warnings (ESM relative imports or credentials)
  const report = await board.conveneDebate(
    "Implement Workspace snapshot database saving",
    "const key = 'secret_key_123'; console.log('Saving snapshot...');"
  );

  if (report.finalConsensus !== "AMENDED") {
    throw new Error("Executive Board: Consensus should be AMENDED due to secret disclosure warning");
  }

  const riskSpeech = report.debates.find(d => d.role === "Risk Officer");
  if (!riskSpeech || riskSpeech.vote !== "APPROVED_WITH_CONDITIONS") {
    throw new Error("Executive Board: Risk Officer failed to flag secret disclosure");
  }

  // Test 2: Standard safe clean proposal
  const safeReport = await board.conveneDebate(
    "How does memory storage work?",
    "Memory storage works using client-side key-value pairs stored in the Working Memory cells of Cognitive Workspace 2.0."
  );

  if (safeReport.finalConsensus !== "APPROVED") {
    throw new Error("Executive Board: Consensus should be APPROVED for safe, non-code proposals");
  }
});

// ---------- 8. Observation Platform Tests ----------
registerTest("Observation", "Telemetry buffer and metrics ingestion", () => {
  const obs = ObservationPlatform.getInstance();
  const initialCount = obs.getTelemetry().length;
  
  obs.logTelemetry("info", "Cognition", "Unit test validation trigger event");
  const updatedLogs = obs.getTelemetry();

  if (updatedLogs.length <= initialCount && updatedLogs.length < 200) {
    throw new Error("Telemetry log failed to append to observation buffer");
  }

  obs.recordLatency(120);
  const metrics = obs.getMetrics();
  if (metrics.counters.averageLatencyMs === 0) {
    throw new Error("Failed to correctly incorporate response latency averages");
  }
});

// ---------- 9. Explainability Trace Tests ----------
registerTest("Explainability", "Decision trace dimension standards", () => {
  const obs = ObservationPlatform.getInstance();
  
  obs.recordDecisionTrace({
    intent: "Verify test harness functionality",
    goals: ["Self-diagnostics"],
    strategy: "Mock execute plan sequence",
    planner: ["Perform assert matches"],
    capabilitySelection: ["Internal Testing Suite"],
    reasoning: "Executing code sanity checking",
    knowledgeUsed: ["Heuristic policy v1"],
    executionResult: "All tests green",
    reflection: "No anomalies detected",
    confidence: 1.0
  });

  const traces = obs.getDecisionTraces();
  const latest = obs.getLatestDecisionTrace();

  if (traces.length === 0 || !latest) {
    throw new Error("Decision trace was not successfully logged");
  }
  if (latest.confidence !== 1.0) {
    throw new Error("Confidence trace dimension has been modified");
  }
  if (latest.intent !== "Verify test harness functionality") {
    throw new Error("Decision trace intent mismatch");
  }
});

// ---------- 10. Audit Logging Tests ----------
registerTest("Audit", "Pragmatic append-only audit tracking", () => {
  const obs = ObservationPlatform.getInstance();
  const initialLogsCount = obs.getAuditLogs().length;

  obs.logAuditEvent("TestRunner", "assert_equality", "success", "Completed audit unit test validation");
  const logs = obs.getAuditLogs();

  if (logs.length <= initialLogsCount) {
    throw new Error("Audit event trace was not written to logs");
  }
  if (!logs[logs.length - 1].includes("Completed audit unit test validation")) {
    throw new Error("Audit content mismatch or missing details");
  }
});

// ---------- 11. Session Tests ----------
registerTest("Session", "Per-user session isolation", async () => {
  const sessionA = await getSession("test_user_a");
  const sessionB = await getSession("test_user_b");

  if (sessionA === sessionB) {
    throw new Error("Session: different usernames must not share a SessionState instance");
  }

  const sameSessionAgain = await getSession("test_user_a");
  if (sameSessionAgain !== sessionA) {
    throw new Error("Session: same username must return the same SessionState instance");
  }

  sessionA.workspace.userContext.addFact("Session A specific fact");
  if (sessionB.workspace.userContext.loadedFacts.includes("Session A specific fact")) {
    throw new Error("Session: workspace state leaked between sessions");
  }
});

registerTest("Session", "updateState synchronizes workspace and audits the transition", () => {
  const session = new SessionState();
  const obs = ObservationPlatform.getInstance();
  const auditCountBefore = obs.getAuditLogs().length;

  session.updateState({ currentThought: "Testing", executiveStatus: "Thinking" }, obs);

  if (session.getState().currentThought !== "Testing") {
    throw new Error("Session: updateState did not update the underlying MindState");
  }
  if (session.workspace.thought.activeThought !== "Testing") {
    throw new Error("Session: updateState did not synchronize the workspace");
  }
  if (obs.getAuditLogs().length <= auditCountBefore) {
    throw new Error("Session: updateState did not record an audit event");
  }
});

// ---------- 12. Permissions Tests ----------
registerTest("Permissions", "Default-deny grants with admin pre-seeded", async () => {
  if (!hasGrant("admin", "github.read")) {
    throw new Error("Permissions: admin should have github.read granted by default");
  }
  if (hasGrant("brand_new_test_user", "github.read")) {
    throw new Error("Permissions: a fresh username must not have any grants by default");
  }

  // No live Postgres in this test harness — grantCapability/revokeCapability
  // still update the in-memory cache and just log a warning on the failed
  // DB write, so this exercises the in-memory contract independent of DB
  // availability (persistence itself is verified live, not by this suite).
  await grantCapability("brand_new_test_user", "email.send", "test-harness");
  if (!hasGrant("brand_new_test_user", "email.send")) {
    throw new Error("Permissions: grantCapability did not take effect");
  }
  if (!listGrants("brand_new_test_user").includes("email.send")) {
    throw new Error("Permissions: listGrants did not reflect the new grant");
  }

  await revokeCapability("brand_new_test_user", "email.send", "test-harness");
  if (hasGrant("brand_new_test_user", "email.send")) {
    throw new Error("Permissions: revokeCapability did not take effect");
  }
});

// ---------- 13. Tools Tests (permission gating only — no live network calls) ----------
registerTest("Tools", "executeTool denies calls without a grant", async () => {
  const result = await executeTool("github_get_repo_or_file", { owner: "x", repo: "y" }, "ungranted_test_user");
  if (result.ok !== false) {
    throw new Error("Tools: executeTool should deny a call with no capability grant");
  }
  if (!result.error || !result.error.toLowerCase().includes("grant")) {
    throw new Error("Tools: denial error message should mention the missing grant");
  }
});

registerTest("Tools", "executeTool rejects unknown tool names", async () => {
  const result = await executeTool("not_a_real_tool", {}, "admin");
  if (result.ok !== false) {
    throw new Error("Tools: executeTool should reject an unrecognized tool name");
  }
});

registerTest("Tools", "view_screen returns a client-action sentinel when nothing is attached yet", async () => {
  const result = await executeTool("view_screen", {}, "admin", null, null, { alreadyAttached: false, supportsRoundTrip: true });
  if (result.ok !== false || result.needsClientAction !== "capture_screen") {
    throw new Error("Tools: view_screen should return needsClientAction='capture_screen' when supportsRoundTrip is true and nothing is attached yet");
  }
});

registerTest("Tools", "view_screen answers directly once a screenshot is already attached", async () => {
  const result = await executeTool("view_screen", {}, "admin", null, null, { alreadyAttached: true, supportsRoundTrip: true });
  if (result.ok !== true || result.needsClientAction) {
    throw new Error("Tools: view_screen should answer directly (ok:true, no needsClientAction) when alreadyAttached is true");
  }
});

registerTest("Tools", "view_screen declines cleanly where the round trip isn't supported (e.g. voice mode)", async () => {
  const result = await executeTool("view_screen", {}, "admin", null, null, { alreadyAttached: false, supportsRoundTrip: false });
  if (result.ok !== false || result.needsClientAction) {
    throw new Error("Tools: view_screen should fail cleanly with no needsClientAction when supportsRoundTrip is false");
  }
});

registerTest("Tools", "view_screen's default screenContext is safe (supportsRoundTrip: false) — the property live-voice.ts's call site relies on", async () => {
  const result = await executeTool("view_screen", {}, "admin");
  if (result.ok !== false || result.needsClientAction) {
    throw new Error("Tools: view_screen with NO screenContext argument (the default) must decline cleanly with no needsClientAction — if this fails, the default was flipped to supportsRoundTrip: true again, which would break live-voice.ts's safe fallback");
  }
});

registerTest("Tools", "display_content executes without any capability grant", async () => {
  const result = await executeTool("display_content", { type: "image", title: "Test", content: { url: "https://example.com/x.png" } }, "ungranted_test_user");
  if (result.ok !== true) {
    throw new Error("Tools: display_content should succeed with no grant required");
  }
  if (!result.displayDirective || result.displayDirective.type !== "image") {
    throw new Error("Tools: display_content should return a displayDirective matching the call's type");
  }
});

registerTest("Tools", "unrelated tools never carry a displayDirective", async () => {
  const result = await executeTool("view_screen", {}, "admin", null, null, { alreadyAttached: true, supportsRoundTrip: true });
  if ((result as any).displayDirective) {
    throw new Error("Tools: displayDirective should only ever be set by display_content");
  }
});

registerTest("Tools", "set_objective denies calls without objectives.write grant", async () => {
  const result = await executeTool("set_objective", { description: "test goal" }, "ungranted_test_user");
  if (result.ok !== false || !result.error?.toLowerCase().includes("grant")) {
    throw new Error("Tools: set_objective should deny a call with no capability grant");
  }
});

registerTest("Tools", "update_objective_status reports a clear error for a non-existent objective", async () => {
  const result = await executeTool("update_objective_status", { objectiveId: 999999, status: "completed" }, "admin");
  if (result.ok !== false || !result.error) {
    throw new Error("Tools: update_objective_status should fail cleanly for an id that doesn't exist");
  }
});

registerTest("Tools", "update_objective_status rejects an invalid status value before touching the DB", async () => {
  const result = await executeTool("update_objective_status", { objectiveId: 1, status: "done" }, "admin");
  if (result.ok !== false || !result.error?.includes("completed") ) {
    throw new Error("Tools: update_objective_status should reject a status value that isn't 'completed' or 'abandoned'");
  }
});

registerTest("Tools", "record_command_outcome denies calls without system.execute grant", async () => {
  const result = await executeTool("record_command_outcome", { commandId: 1, outcome: "worked" }, "ungranted_test_user");
  if (result.ok !== false || !result.error?.toLowerCase().includes("grant")) {
    throw new Error("Tools: record_command_outcome should deny a call with no capability grant");
  }
});

registerTest("Tools", "record_command_outcome rejects an invalid outcome value before touching the DB", async () => {
  const result = await executeTool("record_command_outcome", { commandId: 1, outcome: "sort of" }, "admin");
  if (result.ok !== false || !result.error?.includes("worked")) {
    throw new Error("Tools: record_command_outcome should reject an outcome value that isn't 'worked' or 'not_worked'");
  }
});

registerTest("Tools", "record_command_outcome reports a clean error for a non-existent command id", async () => {
  const result = await executeTool("record_command_outcome", { commandId: 999999, outcome: "worked" }, "admin");
  if (result.ok !== false || !result.error) {
    throw new Error("Tools: record_command_outcome should fail cleanly for a command id that doesn't exist");
  }
});

registerTest("Tools", "propose_mcp_server denies calls without system.mcp_manage grant", async () => {
  const result = await executeTool("propose_mcp_server", { name: "test-server", url: "http://example.invalid/mcp" }, "ungranted_test_user");
  if (result.ok !== false || !result.error?.toLowerCase().includes("grant")) {
    throw new Error("Tools: propose_mcp_server should deny a call with no capability grant");
  }
});

registerTest("Tools", "confirm_build_direction denies calls without executive.plan grant", async () => {
  const result = await executeTool("confirm_build_direction", { directionNotes: "use React" }, "ungranted_test_user");
  if (result.ok !== false || !result.error?.toLowerCase().includes("grant")) {
    throw new Error("Tools: confirm_build_direction should deny a call with no capability grant");
  }
});

registerTest("Tools", "confirm_build_direction reports cleanly when no build request is awaiting consult", async () => {
  const result = await executeTool("confirm_build_direction", { directionNotes: "use React" }, "admin");
  if (result.ok !== false || !result.error?.toLowerCase().includes("no build request")) {
    throw new Error(`Tools: expected a clean 'no build request awaiting consult' error, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Tools", "executeTool reports unknown tool for a name that isn't static or a cached MCP tool", async () => {
  const result = await executeTool("not_a_real_tool", {}, "admin");
  if (result.ok !== false || !result.error?.toLowerCase().includes("unknown")) {
    throw new Error("Tools: expected a clean 'unknown tool' error for a name matching neither a static tool nor a cached MCP tool");
  }
});

registerTest("Tools", "getAllToolDeclarations includes every static declaration with nothing MCP-approved", () => {
  const declarations = getAllToolDeclarations();
  if (declarations.length < 25) { // 24 static tools as of Phase 3, plus propose_mcp_server = 25
    throw new Error(`Tools: expected at least 25 static declarations, got ${declarations.length}`);
  }
});

// ---------- 14. Semantic Memory Tests (no external DB/network dependency) ----------
registerTest("Memory", "embedText returns null with no provider configured", async () => {
  const result = await embedText("hello world", null, null);
  if (result !== null) {
    throw new Error("Memory: embedText should return null when no embedding provider is available");
  }
});

registerTest("Memory", "remember/recall degrade cleanly when pgvector isn't initialized", async () => {
  // This test process never calls initDatabase() (src/data/db.ts), so
  // isVectorReady() is false — remember/recall must degrade gracefully
  // rather than attempt a DB connection that doesn't exist here.
  const stored = await remember("test_user", "a memory", null, null);
  if (stored !== false) {
    throw new Error("Memory: remember should return false, not throw, when pgvector isn't ready");
  }
  const recalled = await recall("test_user", "a memory", null, null);
  if (!Array.isArray(recalled) || recalled.length !== 0) {
    throw new Error("Memory: recall should return an empty array when pgvector isn't ready");
  }
});

// ---------- 15. Scheduler Tests ----------
registerTest("Scheduler", "Notifications: push, list, and mark read", () => {
  const user = "scheduler_test_user";
  pushNotification(user, "Test notification one", "info");
  pushNotification(user, "Test notification two", "warning");

  const items = getNotifications(user);
  if (items.length !== 2) {
    throw new Error("Scheduler: expected 2 notifications after pushing 2");
  }
  if (items.some(n => n.read)) {
    throw new Error("Scheduler: freshly pushed notifications should start unread");
  }

  markAllRead(user);
  if (getNotifications(user).some(n => !n.read)) {
    throw new Error("Scheduler: markAllRead should mark every notification as read");
  }
});

registerTest("Scheduler", "registerJob ticks on an interval and survives a throwing job", async () => {
  let ticks = 0;
  const handle = registerJob("test-tick-job", 50, () => {
    ticks++;
    if (ticks === 1) throw new Error("Deliberate test failure");
  });

  await new Promise(resolve => setTimeout(resolve, 180));
  clearInterval(handle);

  if (ticks < 2) {
    throw new Error(`Scheduler: expected registerJob to tick at least twice, got ${ticks}`);
  }
});

// ---------- Files/Notes Tests ----------
// Runs against a real temp directory (not JARVIS_FILES_DIR) so the security
// boundary itself — not just the happy path — has permanent regression
// coverage, independent of any live-verification done in a given session.
registerTest("Files", "scoped read/write/list stay within the root, and traversal is rejected", async () => {
  const os = await import("os");
  const path = await import("path");
  const fsSync = await import("fs");
  const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "jarvis-files-test-"));
  process.env.JARVIS_FILES_DIR_MOUNT = tmpRoot;

  // getRoot() reads process.env.JARVIS_FILES_DIR_MOUNT fresh on every call,
  // so setting it above is enough — no need to re-import the module.
  const files = await import("../src/integrations/files.js");

  try {
    await files.writeFile("note.txt", "hello jarvis");
    const content = await files.readFile("note.txt");
    if (content !== "hello jarvis") {
      throw new Error(`Files: read back "${content}", expected "hello jarvis"`);
    }

    const listed = await files.listFiles();
    if (!listed.some((f: any) => f.name === "note.txt")) {
      throw new Error("Files: listFiles did not include the file just written");
    }

    let escaped = false;
    try {
      await files.readFile("../../../etc/passwd");
      escaped = true;
    } catch (err: any) {
      if (!/escapes/.test(err.message)) throw new Error(`Files: wrong error for traversal attempt: ${err.message}`);
    }
    if (escaped) throw new Error("Files: a '../../../etc/passwd' path was NOT rejected — traversal protection failed");

    let escapedAbsolute = false;
    try {
      await files.readFile("/etc/passwd");
      escapedAbsolute = true;
    } catch (err: any) {
      if (!/escapes/.test(err.message)) throw new Error(`Files: wrong error for absolute-path attempt: ${err.message}`);
    }
    if (escapedAbsolute) throw new Error("Files: an absolute '/etc/passwd' path was NOT rejected");

    await files.deleteFile("note.txt");
    const afterDelete = await files.listFiles();
    if (afterDelete.some((f: any) => f.name === "note.txt")) {
      throw new Error("Files: deleteFile did not actually remove the file");
    }
  } finally {
    delete process.env.JARVIS_FILES_DIR_MOUNT;
    fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------- Objectives Tests (no live Postgres in this test process) ----------
import { createObjective, listActiveObjectives, updateObjectiveStatus, collectDueObjectives, markCheckedIn } from "../src/data/objectives-repo.js";
import { recordCommandOutcome, getRecentOutcomeSuccessRate } from "../src/data/command-proposals-repo.js";

registerTest("Objectives", "createObjective degrades cleanly when Postgres isn't reachable", async () => {
  try {
    await createObjective("test_user", "run a marathon", null);
    throw new Error("Objectives: expected createObjective to reject without a live Postgres connection");
  } catch (err: any) {
    if (err.message?.includes("expected createObjective to reject")) throw err;
    // Any other thrown error (connection refused/DNS failure) is the expected
    // behavior in this no-DB test process — createObjective is a genuine
    // write with no sensible fallback value, so it's allowed to reject; the
    // read-side functions below are the ones required to degrade silently.
  }
});

registerTest("Objectives", "listActiveObjectives degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listActiveObjectives("test_user");
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`Objectives: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Objectives", "updateObjectiveStatus degrades cleanly when Postgres isn't reachable", async () => {
  const result = await updateObjectiveStatus("test_user", 999999, "completed");
  if (result !== false) {
    throw new Error(`Objectives: expected false with no DB, got: ${result}`);
  }
});

registerTest("Objectives", "collectDueObjectives degrades cleanly when Postgres isn't reachable", async () => {
  const result = await collectDueObjectives("test_user");
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`Objectives: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Objectives", "markCheckedIn never throws, even with no DB or an empty list", async () => {
  await markCheckedIn([]);
  await markCheckedIn([999999]);
  // Reaching this line without an unhandled rejection is the assertion.
});

// ---------- Briefing Tests ----------
import { prioritizeSignals, synthesizeBriefing } from "../src/execution/briefing.js";

registerTest("Briefing", "prioritizeSignals scores a near-due objective as high urgency", () => {
  const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow
  const items = prioritizeSignals({
    emails: [],
    githubNotifications: [],
    objectives: [{
      id: 1, username: "admin", description: "finish the report", target_date: soon,
      status: "active", created_at: new Date(), updated_at: new Date(), last_checked_at: null,
    }],
  });
  const obj = items.find(i => i.id === "objective:1");
  if (!obj || obj.urgency !== "high") {
    throw new Error(`Briefing: expected a near-due objective to score "high", got: ${JSON.stringify(obj)}`);
  }
});

registerTest("Briefing", "prioritizeSignals scores a distant objective as medium urgency", () => {
  const distant = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10); // 30 days out
  const items = prioritizeSignals({
    emails: [],
    githubNotifications: [],
    objectives: [{
      id: 2, username: "admin", description: "get better at guitar", target_date: distant,
      status: "active", created_at: new Date(), updated_at: new Date(), last_checked_at: null,
    }],
  });
  const obj = items.find(i => i.id === "objective:2");
  if (!obj || obj.urgency !== "medium") {
    throw new Error(`Briefing: expected a distant objective to score "medium", got: ${JSON.stringify(obj)}`);
  }
});

registerTest("Briefing", "prioritizeSignals scores an objective with no target date as medium urgency", () => {
  const items = prioritizeSignals({
    emails: [],
    githubNotifications: [],
    objectives: [{
      id: 3, username: "admin", description: "get better at guitar", target_date: null,
      status: "active", created_at: new Date(), updated_at: new Date(), last_checked_at: null,
    }],
  });
  const obj = items.find(i => i.id === "objective:3");
  if (!obj || obj.urgency !== "medium") {
    throw new Error(`Briefing: expected an undated objective to score "medium", got: ${JSON.stringify(obj)}`);
  }
});

registerTest("Briefing", "synthesizeBriefing falls back to a plain list with no Groq client", async () => {
  const items = [{ id: "email:1", source: "email" as const, urgency: "high" as const, summary: "test item" }];
  const text = await synthesizeBriefing(null, items, []);
  if (!text.includes("test item")) {
    throw new Error(`Briefing: expected the plain-list fallback to include the raw item summary, got: "${text}"`);
  }
});

// ---------- Command Outcome Tracking Tests (no live Postgres in this test process) ----------

registerTest("CommandOutcomes", "recordCommandOutcome degrades cleanly when Postgres isn't reachable", async () => {
  const result = await recordCommandOutcome(999999, "worked");
  if (result !== false) {
    throw new Error(`CommandOutcomes: expected false with no DB, got: ${result}`);
  }
});

registerTest("CommandOutcomes", "getRecentOutcomeSuccessRate degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getRecentOutcomeSuccessRate();
  if (result !== null) {
    throw new Error(`CommandOutcomes: expected null with no DB, got: ${result}`);
  }
});

// ---------- Identity (Continuity of Self) Tests ----------
registerTest("Identity", "buildIdentityContext degrades cleanly when Postgres isn't reachable", async () => {
  // This test process never calls initDatabase(), so there's no live
  // Postgres connection here — buildIdentityContext must return "" rather
  // than throw or block the chat system-instruction it's spliced into.
  const context = await buildIdentityContext();
  if (context !== "") {
    throw new Error(`Identity: expected empty context with no DB, got: "${context}"`);
  }
});

registerTest("Identity", "generateProactiveThought never fabricates a thought when there's no real history", async () => {
  // Same no-live-DB environment as above. The DB read fails first (before
  // the fake ai client below would ever be touched), so this also proves
  // the function fails toward "no thought" rather than throwing and taking
  // down the scheduler job that calls it.
  const fakeAi = {} as any;
  const result = await generateProactiveThought(fakeAi);
  if (result !== null) {
    throw new Error("Identity: expected null (no real history to draw from), got a fabricated result");
  }
});

registerTest("Identity", "extractSelfReflection no-ops with no Groq client", async () => {
  // Must return (not throw) immediately on the `if (!groq) return;` guard,
  // without ever touching the database or a Groq client. If the guard were
  // missing/broken, calling groq.chat.completions.create on null would throw
  // inside the try/catch and log a "warn" telemetry event instead — so we
  // assert no such warn entry was appended, not just that nothing threw.
  const obs = ObservationPlatform.getInstance();
  const before = obs.getTelemetry().length;
  await extractSelfReflection(null, "hello", "some reply");
  const newEntries = obs.getTelemetry().slice(before);
  if (newEntries.some(e => e.level === "warn" && e.subsystem === "Identity")) {
    throw new Error("Identity: expected the null-groq guard to return silently, but a warn-level failure was logged instead — the guard may be missing");
  }
});

registerTest("KnowledgeGraph", "extractAndStore no-ops with no Groq client", async () => {
  const obs = ObservationPlatform.getInstance();
  const before = obs.getTelemetry().length;
  await extractAndStore(null, "hello", "some reply");
  const newEntries = obs.getTelemetry().slice(before);
  if (newEntries.some(e => e.level === "warn" && e.subsystem === "KnowledgeGraph")) {
    throw new Error("KnowledgeGraph: expected the null-groq guard to return silently, but a warn-level failure was logged instead — the guard may be missing");
  }
});

registerTest("Learning", "reflectAndLearn no-ops with no Groq client", async () => {
  const obs = ObservationPlatform.getInstance();
  const before = obs.getTelemetry().length;
  await reflectAndLearn(null, "hello", "some reply");
  const newEntries = obs.getTelemetry().slice(before);
  if (newEntries.some(e => e.level === "warn" && e.subsystem === "Learning")) {
    throw new Error("Learning: expected the null-groq guard to return silently, but a warn-level failure was logged instead — the guard may be missing");
  }
});

// ---------- HTTP Boundary ----------
// Every other test in this file imports internal modules directly — none of
// them would have caught today's real incident, where the Express app
// itself failed to boot at all (a missing npm dependency) while everything
// unit-testable in isolation was fine. This actually starts the process the
// way Docker does and confirms it comes up and serves a real HTTP response.

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

registerTest("HTTP Boundary", "Express server boots from a cold start and serves /health", async () => {
  // If something's already listening on :3000 (e.g. this suite running
  // alongside a live dev/docker instance on the same host), don't spawn a
  // second process into the same port — just confirm whatever's already
  // there responds, which still exercises the same assertion.
  const alreadyRunning = await isPortInUse(3000);
  let child: ChildProcess | null = null;

  if (!alreadyRunning) {
    child = spawn("npx", ["tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        INTERNAL_API_KEY: process.env.INTERNAL_API_KEY || "test-only-smoke-test-key-not-a-real-secret",
      },
      stdio: "ignore",
    });
  }

  try {
    const deadline = Date.now() + 25_000;
    let lastErr: any = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch("http://127.0.0.1:3000/health");
        if (res.ok) return;
        lastErr = new Error(`/health returned HTTP ${res.status}`);
      } catch (err: any) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Server never became reachable on :3000/health: ${lastErr?.message || lastErr}`);
  } finally {
    if (child) child.kill();
  }
});

// ---------- ConfidenceModel Tests (pure, no DB) ----------

registerTest("Confidence", "calculateOverallConfidence matches today's 5-input average when outcomeConfidence is omitted", () => {
  const model = new ConfidenceModel();
  const result = model.calculateOverallConfidence({
    memoryConfidence: 0.8,
    toolConfidence: 1.0,
    validationConfidence: 1.0,
    capabilityConfidence: 0.9,
    environmentConfidence: 1.0
  });
  const expected = Math.round(((0.8 + 1.0 + 1.0 + 0.9 + 1.0) / 5) * 100);
  if (result !== expected) {
    throw new Error(`Confidence: expected ${expected} with outcomeConfidence omitted, got ${result}`);
  }
});

registerTest("Confidence", "calculateOverallConfidence factors outcomeConfidence in when provided", () => {
  const model = new ConfidenceModel();
  const result = model.calculateOverallConfidence({
    memoryConfidence: 0.8,
    toolConfidence: 1.0,
    validationConfidence: 1.0,
    capabilityConfidence: 0.9,
    environmentConfidence: 1.0,
    outcomeConfidence: 0.5
  });
  const expected = Math.round(((0.8 + 1.0 + 1.0 + 0.9 + 1.0 + 0.5) / 6) * 100);
  if (result !== expected) {
    throw new Error(`Confidence: expected ${expected} with outcomeConfidence 0.5, got ${result}`);
  }
});

registerTest("Confidence", "calculateOverallConfidence returns 100 for a fully empty input", () => {
  const model = new ConfidenceModel();
  const result = model.calculateOverallConfidence({});
  if (result !== 100) {
    throw new Error(`Confidence: expected 100 for an empty input, got ${result}`);
  }
});

// ---------- MCP Servers Repo Tests (no live Postgres in this test process) ----------

registerTest("McpServers", "proposeMcpServer degrades cleanly when Postgres isn't reachable", async () => {
  try {
    await proposeMcpServer("test-server", "http://example.invalid/mcp", "admin");
    throw new Error("McpServers: expected proposeMcpServer to reject without a live Postgres connection");
  } catch (err: any) {
    if (err.message?.includes("expected proposeMcpServer to reject")) throw err;
    // Any other thrown error (connection refused/DNS failure) is expected here.
  }
});

registerTest("McpServers", "getMcpServer degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getMcpServer(999999);
  if (result !== null) {
    throw new Error(`McpServers: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("McpServers", "listMcpServers degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listMcpServers();
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`McpServers: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("McpServers", "markMcpServerApproved degrades cleanly when Postgres isn't reachable", async () => {
  const result = await markMcpServerApproved(999999);
  if (result !== null) {
    throw new Error(`McpServers: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("McpServers", "setMcpServerStatus degrades cleanly when Postgres isn't reachable", async () => {
  const result = await setMcpServerStatus(999999, "disabled");
  if (result !== null) {
    throw new Error(`McpServers: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

// ---------- MCP Registry Tests (pure schema validation, no network/DB) ----------

registerTest("McpRegistry", "isValidToolSchema accepts a well-formed tool", () => {
  const valid = isValidToolSchema({ name: "search_issues", description: "Search GitHub issues", inputSchema: { type: "object", properties: {} } });
  if (!valid) {
    throw new Error("McpRegistry: expected a well-formed tool schema to be accepted");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects a tool name with unsafe characters", () => {
  const valid = isValidToolSchema({ name: "search issues; rm -rf", description: "x", inputSchema: { type: "object" } });
  if (valid) {
    throw new Error("McpRegistry: expected a tool name with unsafe characters to be rejected");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects a tool with no inputSchema", () => {
  const valid = isValidToolSchema({ name: "no_schema", description: "x" });
  if (valid) {
    throw new Error("McpRegistry: expected a tool with a missing inputSchema to be rejected");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects an oversized description", () => {
  const valid = isValidToolSchema({ name: "long_desc", description: "x".repeat(2000), inputSchema: { type: "object" } });
  if (valid) {
    throw new Error("McpRegistry: expected an oversized description to be rejected");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects an inputSchema that is an array", () => {
  const valid = isValidToolSchema({ name: "array_schema", description: "x", inputSchema: [] });
  if (valid) {
    throw new Error("McpRegistry: expected an array inputSchema to be rejected");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects an inputSchema missing type: \"object\"", () => {
  const missingType = isValidToolSchema({ name: "no_type", description: "x", inputSchema: { properties: {} } });
  if (missingType) {
    throw new Error("McpRegistry: expected an inputSchema with no type to be rejected");
  }
  const wrongType = isValidToolSchema({ name: "wrong_type", description: "x", inputSchema: { type: "string", properties: {} } });
  if (wrongType) {
    throw new Error("McpRegistry: expected an inputSchema with type !== \"object\" to be rejected");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects an inputSchema with non-object properties", () => {
  const valid = isValidToolSchema({ name: "bad_properties", description: "x", inputSchema: { type: "object", properties: [] } });
  if (valid) {
    throw new Error("McpRegistry: expected an inputSchema with array properties to be rejected");
  }
});

registerTest("McpRegistry", "getCachedMcpTools returns an empty array with nothing approved", () => {
  const tools = getCachedMcpTools();
  if (!Array.isArray(tools) || tools.length !== 0) {
    throw new Error(`McpRegistry: expected an empty array with nothing approved, got: ${JSON.stringify(tools)}`);
  }
});

// ---------- Build Requests Repo Tests (no live Postgres in this test process) ----------

registerTest("BuildRequests", "createBuildRequest degrades cleanly when Postgres isn't reachable", async () => {
  try {
    await createBuildRequest("test objective", "admin");
    throw new Error("BuildRequests: expected createBuildRequest to reject without a live Postgres connection");
  } catch (err: any) {
    if (err.message?.includes("expected createBuildRequest to reject")) throw err;
    // Any other thrown error (connection refused/DNS failure) is expected here.
  }
});

registerTest("BuildRequests", "getBuildRequest degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getBuildRequest(999999);
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("BuildRequests", "getLatestAwaitingConsult degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getLatestAwaitingConsult("admin");
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("BuildRequests", "listBuildRequests degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listBuildRequests();
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`BuildRequests: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("BuildRequests", "recordDirectionConfirmed degrades cleanly when Postgres isn't reachable", async () => {
  const result = await recordDirectionConfirmed(999999, "some direction notes");
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("BuildRequests", "rejectCode degrades cleanly when Postgres isn't reachable", async () => {
  const result = await rejectBuildCode(999999);
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

// ---------- Departments Tests (no live AI/network in this test process) ----------

registerTest("Departments", "decomposeObjective falls back to a single research step with no AI client", async () => {
  const steps = await departments.decomposeObjective("Build me a website", null, false);
  if (steps.length !== 1 || steps[0].department !== "research") {
    throw new Error(`Departments: expected a single research-tagged fallback step, got: ${JSON.stringify(steps)}`);
  }
});

registerTest("Departments", "decomposeObjective falls back to research when offline mode is on, even with an AI client", async () => {
  // A real GoogleGenAI instance isn't available in this test process; `{} as
  // any` is safe here because offlineMode=true short-circuits before any
  // property on it is ever touched.
  const steps = await departments.decomposeObjective("Build me a website", {} as any, true);
  if (steps.length !== 1 || steps[0].department !== "research") {
    throw new Error(`Departments: expected offline mode to force the research-only fallback, got: ${JSON.stringify(steps)}`);
  }
});

registerTest("Departments", "runResearch degrades cleanly with no AI client", async () => {
  const result = await departments.runResearch("test objective", null);
  if (!result.summary.includes("No capable model is available")) {
    throw new Error(`Departments: expected the no-AI degrade message, got: ${result.summary}`);
  }
});

registerTest("Departments", "draftCodeChanges degrades cleanly with no AI client", async () => {
  const result = await departments.draftCodeChanges("test objective", "research", "direction", null);
  if (result.ok !== false || !result.error.includes("No capable model is available")) {
    throw new Error(`Departments: expected a clean failure with no AI client, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Departments", "reviewCodeDiff degrades cleanly with no AI client", async () => {
  const result = await departments.reviewCodeDiff("test objective", [{ path: "a.ts", content: "x" }], null);
  if (!result.includes("No capable model was available")) {
    throw new Error(`Departments: expected the no-AI degrade message, got: ${result}`);
  }
});

// ---------- Groq Client Tests (pure functions, no network) ----------

registerTest("GroqClient", "toGroqSchema lowercases a simple type field", () => {
  const result = toGroqSchema({ type: "STRING", description: "x" });
  if (result.type !== "string") {
    throw new Error(`GroqClient: expected lowercase "string", got: ${JSON.stringify(result)}`);
  }
});

registerTest("GroqClient", "toGroqSchema recursively lowercases a nested object/array schema", () => {
  const geminiShaped = {
    type: "OBJECT",
    properties: {
      steps: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            step: { type: "STRING" },
            department: { type: "STRING" },
          },
          required: ["step", "department"],
        },
      },
    },
    required: ["steps"],
  };
  const result = toGroqSchema(geminiShaped);
  if (
    result.type !== "object" ||
    result.properties.steps.type !== "array" ||
    result.properties.steps.items.type !== "object" ||
    result.properties.steps.items.properties.step.type !== "string"
  ) {
    throw new Error(`GroqClient: expected fully recursive lowercasing, got: ${JSON.stringify(result)}`);
  }
  // Non-type fields must survive untouched.
  if (result.properties.steps.items.required?.[0] !== "step") {
    throw new Error("GroqClient: expected the 'required' array to survive untouched");
  }
});

registerTest("GroqClient", "toGroqSchema is idempotent on an already-lowercase (MCP-style) schema", () => {
  const alreadyLowercase = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const result = toGroqSchema(alreadyLowercase);
  if (result.type !== "object" || result.properties.name.type !== "string") {
    throw new Error(`GroqClient: expected an already-lowercase schema to pass through unchanged, got: ${JSON.stringify(result)}`);
  }
});

registerTest("GroqClient", "toGroqTools wraps a declaration in Groq's function-tool shape", () => {
  const declarations = [{ name: "search_web", description: "Search the web", parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] } }];
  const result = toGroqTools(declarations);
  if (result.length !== 1 || result[0].type !== "function" || result[0].function.name !== "search_web") {
    throw new Error(`GroqClient: expected one function-shaped tool, got: ${JSON.stringify(result)}`);
  }
  if (result[0].function.parameters.type !== "object") {
    throw new Error("GroqClient: expected the wrapped parameters schema to be lowercased too");
  }
});

// ---------- Execution Main Block ----------
async function main() {
  console.log("🧪 STARTING JARVIS OS PHASE XIV AUTOMATED TEST SUITE...");
  console.log("=====================================================");

  const results: TestResult[] = [];
  let passedCount = 0;

  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, category: t.category, passed: true });
      passedCount++;
    } catch (err: any) {
      results.push({ name: t.name, category: t.category, passed: false, error: err.message || err });
    }
  }

  console.log("\n=====================================================");
  console.log("🧪 TEST RESULTS:");
  console.log("-----------------------------------------------------");

  results.forEach(res => {
    if (res.passed) {
      console.log(`✅ [PASSED] [Category: ${res.category}] - ${res.name}`);
    } else {
      console.log(`❌ [FAILED] [Category: ${res.category}] - ${res.name}`);
      console.log(`    Error: ${res.error}`);
    }
  });

  console.log("=====================================================");
  console.log(`TOTALS: ${passedCount} / ${results.length} Tests Passed.`);
  console.log("=====================================================");

  if (passedCount < results.length) {
    process.exit(1);
  } else {
    console.log("🎉 ALL PLATFORM CONSTRAINTS MET! JARVIS OS v3.0 HEALTHY.");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Fatal Test Suite Error:", err);
  process.exit(1);
});
