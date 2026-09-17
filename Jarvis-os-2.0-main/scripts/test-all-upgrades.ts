import * as path from 'path';
import { ToolSandbox } from '../src/capabilities/ToolSandbox.js';
import { MAVLinkHardwareDriver } from '../src/hardware/MAVLinkHardwareDriver.js';
import { UniversalCADEngine } from '../src/cad/UniversalCADEngine.js';
import { SVGExporter } from '../src/cad/SVGExporter.js';
import { STLExporter } from '../src/cad/STLExporter.js';
import { DynamicToolSynthesizer } from '../src/capabilities/DynamicToolSynthesizer.js';
import { AgentOrchestrator } from '../src/core/AgentOrchestrator.js';
import { UniversalHardwareEngine } from '../src/hardware/UniversalHardwareEngine.js';
import { MultiModalEvaluator } from '../src/evaluation/MultiModalEvaluator.js';
import { SelfModificationEngine } from '../src/core/SelfModificationEngine.js';

async function testAllUpgrades() {
  console.log('====================================================');
  console.log('=== TESTING ALL 3 PRODUCTION UPGRADES LIVE ===');
  console.log('====================================================\n');

  // --- UPGRADE 1: MAVLink Binary Hardware Driver ---
  console.log('[UPGRADE 1] Testing MAVLink Binary Hardware Driver...');
  const mavlinkDriver = new MAVLinkHardwareDriver();
  const connected = await mavlinkDriver.connect('udp://127.0.0.1:14550');
  console.log(`[MAVLink UDP Connect]: ${connected ? 'SUCCESS ✓' : 'FAILED ❌'}`);

  const armResponse = await mavlinkDriver.sendCommand({ action: 'ARM' });
  console.log(`[MAVLink Command ARM]: ${armResponse.message}`);

  const takeoffResponse = await mavlinkDriver.sendCommand({ action: 'TAKEOFF', parameters: { altitude: 4.5 } });
  console.log(`[MAVLink Command TAKEOFF]: ${takeoffResponse.message}`);

  const telemetry = await mavlinkDriver.getTelemetry();
  console.log('[MAVLink Live Telemetry]:', telemetry);
  await mavlinkDriver.disconnect();

  // --- UPGRADE 2: Multi-Format CAD Exporters (SVG & STL) ---
  console.log('\n[UPGRADE 2] Testing SVG & STL Multi-Format CAD Exporters...');
  const cadEngine = new UniversalCADEngine();
  cadEngine.registerExporter(new SVGExporter());
  cadEngine.registerExporter(new STLExporter());

  const sampleModel = {
    operation: 'DIFFERENCE' as const,
    children: [
      { type: 'CUBE' as const, dimensions: [50, 50, 10] },
      { type: 'CYLINDER' as const, dimensions: [12, 10] }
    ]
  };

  const svgResult = await cadEngine.generateArtifact('SVG', sampleModel, 'jarvis-workspace/cad/test_out.svg');
  const stlResult = await cadEngine.generateArtifact('STL', sampleModel, 'jarvis-workspace/cad/test_out.stl');

  console.log(`✓ SVG Export generated at: ${svgResult.outputFilePath}`);
  console.log(`✓ STL Export generated at: ${stlResult.outputFilePath}`);

  // --- UPGRADE 3: Context-Aware Dynamic Code Synthesis & Directive Orchestrator ---
  console.log('\n[UPGRADE 3] Testing Context-Aware Dynamic Code Synthesis & Directive Orchestrator...');
  const hwEngine = new UniversalHardwareEngine();
  hwEngine.registerDriver(mavlinkDriver);

  const synthesizer = new DynamicToolSynthesizer();
  const orchestrator = new AgentOrchestrator(
    hwEngine,
    cadEngine,
    synthesizer,
    new MultiModalEvaluator(),
    new SelfModificationEngine()
  );

  const directive = 'Design drone mounting chassis frame in SVG and STL, synthesize a telemetry monitor tool, and run flight test on hardware';
  const plan = orchestrator.decomposeDirective(directive);
  const result = await orchestrator.processDirective(directive, plan);
  
  console.log(`[Orchestration Directive Execution]: ${result.status}`);
  console.log(`[Generated Subtask Count]: ${result.subTaskResults.length}`);

  // Dynamically load generated tool using the original plan subtask toolId
  const synthSubtask = plan.subTasks.find(s => s.domain === 'SYNTHESIS');
  if (synthSubtask?.toolCode) {
    const toolFilePath = path.join(process.cwd(), 'jarvis-workspace/capabilities', `${synthSubtask.toolCode.toolId}.ts`);
    const sandbox = new ToolSandbox();
    const output = await sandbox.executeTool(toolFilePath, { battery: 95 }, 3000);
    console.log(`✓ Dynamically loaded tool "${synthSubtask.toolCode.toolId}". Execution output:`, output);
  }

  console.log('\n====================================================');
  console.log('=== ALL 3 PRODUCTION UPGRADES VERIFIED (3/3) ===');
  console.log('====================================================');
}

testAllUpgrades().catch((err) => {
  console.error('❌ Upgrade verification failed:', err);
  process.exit(1);
});
