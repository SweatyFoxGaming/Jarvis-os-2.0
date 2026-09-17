import { AgentOrchestrator } from '../src/core/AgentOrchestrator.js';
import { UniversalHardwareEngine } from '../src/hardware/UniversalHardwareEngine.js';
import { MockHardwareDriver } from '../src/hardware/MockHardwareDriver.js';
import { UniversalCADEngine } from '../src/cad/UniversalCADEngine.js';
import { OpenSCADExporter } from '../src/cad/OpenSCADExporter.js';
import { DynamicToolSynthesizer } from '../src/capabilities/DynamicToolSynthesizer.js';
import { MultiModalEvaluator } from '../src/evaluation/MultiModalEvaluator.js';
import { SelfModificationEngine } from '../src/core/SelfModificationEngine.js';

async function testDirectiveDecomposition() {
  console.log('=== TESTING TASK DECOMPOSITION & DIRECTIVE ORCHESTRATION ===\n');

  const hwEngine = new UniversalHardwareEngine();
  const mockHw = new MockHardwareDriver();
  hwEngine.registerDriver(mockHw);
  await mockHw.connect('mock://localhost:8080');

  const cadEngine = new UniversalCADEngine();
  cadEngine.registerExporter(new OpenSCADExporter());

  const orchestrator = new AgentOrchestrator(
    hwEngine,
    cadEngine,
    new DynamicToolSynthesizer(),
    new MultiModalEvaluator(),
    new SelfModificationEngine()
  );

  const directive = 'Design a custom drone motor housing frame, synthesize a telemetry monitor tool, and run pre-flight spin-up test on hardware';
  
  console.log(`[Input Directive]: "${directive}"\n`);
  
  // Test planning/decomposition
  const plan = orchestrator.decomposeDirective(directive);
  console.log('[Decomposed Multi-Step Plan]:');
  console.dir(plan, { depth: null });

  if (plan.subTasks.length < 3) {
    throw new Error('Decomposition failed to extract 3 distinct domain subtasks');
  }

  // Test execution of directive plan
  const result = await orchestrator.processDirective(directive, plan);
  console.log('\n[Execution Result]:');
  console.log(JSON.stringify(result, null, 2));

  if (result.status !== 'COMPLETED' || result.subTaskResults.length !== 3) {
    throw new Error('Directive multi-step execution failed');
  }

  console.log('\n✓ Test Passed: High-level directive successfully decomposed and executed.');
}

testDirectiveDecomposition().catch((err) => {
  console.error('❌ Decomposition test failed:', err);
  process.exit(1);
});
