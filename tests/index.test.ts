/**
 * Unified Automated Test Suite for Jarvis OS
 * Validates Platform, Integration, Simulation, Regression, Executive, Cognitive, Capability, Environment, and Autonomous modules.
 * Rewritten to support fully sequential awaited execution of async and sync suites.
 */

import { CognitiveWorkspace } from "../src/cognition/workspace.js";
import { SessionState } from "../src/cognition/session.js";
import { ObservationPlatform } from "../src/observation/index.js";
import { AutonomousExecutive } from "../src/execution/autonomous_executive.js";
import { LongTermLearningEngine } from "../src/cognition/long_term_learning.js";
import { ExecutiveBoard } from "../src/execution/executive_board.js";

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
registerTest("Executive 2.0", "Autonomous executive 5-stage pipeline validation", async () => {
  const session = new SessionState();
  const obs = ObservationPlatform.getInstance();
  const exec = new AutonomousExecutive(obs, null); // Run in simulated mode

  const report = await exec.executeObjective("Deploy microservices orchestrator", session);

  if (report.status !== "success") {
    throw new Error("Autonomous Executive: Execution status mismatch");
  }
  if (report.totalStepsExecuted !== 4) {
    throw new Error("Autonomous Executive: Core steps count mismatch");
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
