import { AgentOrchestrator, TaskRequest } from '../src/core/AgentOrchestrator.js';
import { UniversalHardwareEngine } from '../src/hardware/UniversalHardwareEngine.js';
import { MockHardwareDriver } from '../src/hardware/MockHardwareDriver.js';
import { UniversalCADEngine } from '../src/cad/UniversalCADEngine.js';
import { OpenSCADExporter } from '../src/cad/OpenSCADExporter.js';
import { DynamicToolSynthesizer } from '../src/capabilities/DynamicToolSynthesizer.js';
import { MultiModalEvaluator } from '../src/evaluation/MultiModalEvaluator.js';
import { SelfModificationEngine } from '../src/core/SelfModificationEngine.js';

async function testOrchestrator() {
  console.log('=== TESTING AUTONOMOUS R&D ORCHESTRATOR ===\n');

  const hwEngine = new UniversalHardwareEngine();
  const mockHw = new MockHardwareDriver();
  hwEngine.registerDriver(mockHw);
  await mockHw.connect('mock://localhost:8080');

  const cadEngine = new UniversalCADEngine();
  cadEngine.registerExporter(new OpenSCADExporter());

  const synthesizer = new DynamicToolSynthesizer();
  const evaluator = new MultiModalEvaluator();
  const selfMod = new SelfModificationEngine();

  const orchestrator = new AgentOrchestrator(
    hwEngine,
    cadEngine,
    synthesizer,
    evaluator,
    selfMod
  );

  const task: TaskRequest = {
    taskId: 'hybrid_r_and_d_01',
    description: 'Synthesize drone motor housing CAD and issue TAKEOFF directive',
    targetDomain: 'HYBRID',
    cadModel: {
      operation: 'DIFFERENCE',
      children: [
        { type: 'CUBE', dimensions: [40, 40, 20] },
        { type: 'CYLINDER', dimensions: [25, 10] }
      ]
    },
    hardwareCommand: {
      action: 'TAKEOFF',
      parameters: { targetAltitude: 3.0 }
    }
  };

  const result = await orchestrator.processTask(task);
  console.log('Orchestrator Result:\n', JSON.stringify(result, null, 2));

  if (result.status !== 'COMPLETED') {
    throw new Error('Orchestrator integration test failed');
  }

  console.log('\n✓ Test Passed: Autonomous Orchestrator pipeline successfully verified.');
}

testOrchestrator().catch(err => {
  console.error('❌ Test execution failed:', err);
  process.exit(1);
});
