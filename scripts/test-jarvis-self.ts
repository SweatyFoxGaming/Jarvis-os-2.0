import * as path from 'path';
import { AgentOrchestrator } from '../src/core/AgentOrchestrator.js';
import { SelfModificationEngine } from '../src/core/SelfModificationEngine.js';
import { UniversalHardwareEngine } from '../src/hardware/UniversalHardwareEngine.js';
import { MockHardwareDriver } from '../src/hardware/MockHardwareDriver.js';
import { UniversalCADEngine } from '../src/cad/UniversalCADEngine.js';
import { OpenSCADExporter } from '../src/cad/OpenSCADExporter.js';
import { DynamicToolSynthesizer } from '../src/capabilities/DynamicToolSynthesizer.js';
import { MultiModalEvaluator } from '../src/evaluation/MultiModalEvaluator.js';

async function runJarvisSelfTest() {
  console.log('====================================================');
  console.log('=== JARVIS AUTONOMOUS SELF-TESTING PROTOCOL ===');
  console.log('====================================================\n');

  const selfModEngine = new SelfModificationEngine();
  const evaluator = new MultiModalEvaluator();
  const synthesizer = new DynamicToolSynthesizer();

  // PHASE 1: Shadow Build Integrity
  console.log('[PHASE 1] Running Shadow Build Verification...');
  const buildCheck = await selfModEngine.verifyShadowBuild();
  console.log(`[Shadow Build]: ${buildCheck.success ? 'PASSED ✓' : 'FAILED ❌'} - ${buildCheck.message}`);
  
  if (!buildCheck.success) {
    throw new Error('Self-test aborted: Codebase shadow compilation failed.');
  }

  // PHASE 2: Subsystem Initialization
  console.log('\n[PHASE 2] Initializing Jarvis Orchestrator Subsystems...');
  const hwEngine = new UniversalHardwareEngine();
  const mockHw = new MockHardwareDriver();
  hwEngine.registerDriver(mockHw);
  await mockHw.connect('mock://localhost:8080');

  const cadEngine = new UniversalCADEngine();
  cadEngine.registerExporter(new OpenSCADExporter());

  const orchestrator = new AgentOrchestrator(
    hwEngine,
    cadEngine,
    synthesizer,
    evaluator,
    selfModEngine
  );
  console.log('✓ All core engines initialized successfully.');

  // PHASE 3: Self-Directed Directive Execution
  const selfDirective = 'Design a Jarvis mounting chassis CAD frame, synthesize a live diagnostic tool, and run hardware system spin-up test';
  console.log(`\n[PHASE 3] Dispatching Self-Directive:\n"${selfDirective}"`);

  const plan = orchestrator.decomposeDirective(selfDirective);
  console.log(`[Self-Plan]: Generated ${plan.subTasks.length} subtasks.`);

  const result = await orchestrator.processDirective(selfDirective, plan);
  console.log(`[Self-Execution Status]: ${result.status}`);

  if (result.status !== 'COMPLETED') {
    throw new Error('Self-directive execution failed or returned partial status.');
  }

  // PHASE 4: Dynamic Tool Loading & Runtime Execution
  console.log('\n[PHASE 4] Verifying Dynamic Capability Loading...');
  const synthSubtask = plan.subTasks.find(st => st.domain === 'SYNTHESIS');
  
  if (synthSubtask && synthSubtask.toolCode) {
    const toolId = synthSubtask.toolCode.toolId;
    const modulePath = path.join(process.cwd(), 'jarvis-workspace', 'capabilities', `${toolId}.ts`);
    
    const dynamicModule = await import(`file://${modulePath}`);
    if (typeof dynamicModule.processTelemetry === 'function') {
      const telemetryOutput = dynamicModule.processTelemetry({ battery: 100 });
      console.log(`[Dynamic Tool Execution]: Loaded module "${toolId}". Output:`, telemetryOutput);
    } else {
      throw new Error('Synthesized dynamic tool failed to export required interface.');
    }
  }

  // PHASE 5: Multi-Modal Evaluation Report
  console.log('\n[PHASE 5] Evaluating Overall Self-Test Diagnostics...');
  const overallScore = result.evaluations.reduce((acc, curr) => acc + curr.score, 0) / result.evaluations.length;
  console.log(`[Diagnostic Evaluation Score]: ${(overallScore * 100).toFixed(0)}%`);

  console.log('\n====================================================');
  console.log('=== JARVIS SELF-TEST COMPLETE: ALL SYSTEMS NOMINAL ===');
  console.log('====================================================');
}

runJarvisSelfTest().catch(err => {
  console.error('\n❌ Jarvis Self-Test Failed:', err);
  process.exit(1);
});
