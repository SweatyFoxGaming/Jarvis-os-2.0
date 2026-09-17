import express from 'express';
import { createServer, Server } from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createOrchestratorRouter } from '../src/interaction/routes/orchestrator-routes.js';
import { AgentOrchestrator, TaskRequest } from '../src/core/AgentOrchestrator.js';
import { UniversalHardwareEngine, IHardwareDriver, HardwareCommand, TelemetryPacket } from '../src/hardware/UniversalHardwareEngine.js';
import { UniversalCADEngine, CSGNode } from '../src/cad/UniversalCADEngine.js';
import { OpenSCADExporter } from '../src/cad/OpenSCADExporter.js';
import { DynamicToolSynthesizer } from '../src/capabilities/DynamicToolSynthesizer.js';
import { MultiModalEvaluator } from '../src/evaluation/MultiModalEvaluator.js';
import { SelfModificationEngine } from '../src/core/SelfModificationEngine.js';

// --- Faulty Driver Mock for Failure Mode Testing ---
class FaultyHardwareDriver implements IHardwareDriver {
  driverId = 'faulty_driver_v1';
  supportedActions = ['TAKEOFF', 'LAND'];
  private connected = true;

  async connect(target: string): Promise<boolean> { return true; }
  async disconnect(): Promise<void> { this.connected = false; }
  
  async sendCommand(cmd: HardwareCommand): Promise<{ success: boolean; message?: string }> {
    if (cmd.action === 'FAIL_CMD') {
      return { success: false, message: 'Hardware motor controller fault detected' };
    }
    return { success: true, message: 'Executed command' };
  }

  async getTelemetry(): Promise<TelemetryPacket> {
    return {
      timestamp: Date.now(),
      batteryPercentage: 4, // Critical low battery fault
      systemStatus: 'ERROR'
    };
  }
}

async function runRealWorldTestSuite() {
  console.log('====================================================');
  console.log('=== JARVIS REAL-WORLD RESILIENCE & STRESS SUITE ===');
  console.log('====================================================\n');

  // Start temporary express server
  const app = express();
  app.use(express.json());
  app.use('/api/orchestrator', createOrchestratorRouter());
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}/api/orchestrator/task`;
  console.log(`[Test Server] Live on http://127.0.0.1:${address.port}\n`);

  try {
    // -------------------------------------------------------------
    // SCENARIO 1: Deeply Nested CAD CSG Assembly
    // -------------------------------------------------------------
    console.log('--- SCENARIO 1: Deeply Nested CAD CSG Assembly ---');
    const nestedCadModel: CSGNode = {
      operation: 'DIFFERENCE',
      children: [
        {
          operation: 'UNION',
          children: [
            { type: 'CUBE', dimensions: [100, 20, 10] }, // Main boom arm
            { type: 'CYLINDER', dimensions: [15, 25] }   // Motor mount pad
          ]
        },
        { type: 'CYLINDER', dimensions: [18, 3] },        // Motor bolt cutout 1
        { type: 'CYLINDER', dimensions: [18, 3] },        // Motor bolt cutout 2
        { type: 'CUBE', dimensions: [80, 10, 5] }         // Cable pass-through slot
      ]
    };

    const cadTask: TaskRequest = {
      taskId: 'rw_cad_assembly_01',
      description: 'Synthesize complex quadcopter boom arm with wire routing cutouts',
      targetDomain: 'CAD',
      cadModel: nestedCadModel
    };

    const res1 = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cadTask)
    });
    const body1 = await res1.json();
    
    // Verify file output was actually written and valid
    const scadPath = path.join(process.cwd(), 'jarvis-workspace', 'cad', 'rw_cad_assembly_01.scad');
    const scadContent = await fs.readFile(scadPath, 'utf-8');
    
    if (res1.status === 200 && scadContent.includes('difference()') && scadContent.includes('union()')) {
      console.log('✓ Scenario 1 Passed: Complex CSG model successfully compiled & verified on disk.');
    } else {
      throw new Error('Scenario 1 Failed: CSG output invalid or missing from disk.');
    }

    // -------------------------------------------------------------
    // SCENARIO 2: Hardware Telemetry & Fault Recovery
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 2: Hardware Telemetry Fault Detection ---');
    const faultyHwEngine = new UniversalHardwareEngine();
    const faultyDriver = new FaultyHardwareDriver();
    faultyHwEngine.registerDriver(faultyDriver);

    const directOrchestrator = new AgentOrchestrator(
      faultyHwEngine,
      new UniversalCADEngine(),
      new DynamicToolSynthesizer(),
      new MultiModalEvaluator(),
      new SelfModificationEngine()
    );

    const faultTask: TaskRequest = {
      taskId: 'rw_fault_test_01',
      description: 'Dispatch command to failing hardware module',
      targetDomain: 'HARDWARE',
      hardwareCommand: { action: 'FAIL_CMD' }
    };

    const faultResult = await directOrchestrator.processTask(faultTask);
    const telemetryEval = faultResult.evaluations.find(e => e.channel === 'TELEMETRY');
    
    if (faultResult.executionLog.some(log => log.includes('Hardware motor controller fault detected'))) {
      console.log('✓ Scenario 2 Passed: Hardware driver fault caught and recorded without crash.');
    } else {
      throw new Error('Scenario 2 Failed: Orchestrator failed to capture hardware fault.');
    }

    // -------------------------------------------------------------
    // SCENARIO 3: Concurrent Task Execution & Race Condition Safety
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 3: Stress Test (10 Concurrent HTTP Task Dispatches) ---');
    const concurrentCount = 10;
    const concurrentPromises = Array.from({ length: concurrentCount }).map((_, i) => {
      const task: TaskRequest = {
        taskId: `rw_concurrent_task_${i}`,
        description: `Concurrent task dispatch #${i}`,
        targetDomain: 'HYBRID',
        cadModel: { type: 'CUBE', dimensions: [i + 5, i + 5, i + 5] },
        hardwareCommand: { action: 'HOLD', parameters: { index: i } }
      };
      return fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task)
      }).then(r => r.json());
    });

    const results = await Promise.all(concurrentPromises);
    const allSuccessful = results.every(r => r.status === 'COMPLETED');
    
    if (allSuccessful && results.length === concurrentCount) {
      console.log(`✓ Scenario 3 Passed: All ${concurrentCount} concurrent tasks processed cleanly.`);
    } else {
      throw new Error('Scenario 3 Failed: Race condition or task failure detected under concurrent load.');
    }

    // -------------------------------------------------------------
    // SCENARIO 4: Invalid Request Payload & Graceful Error Handling
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 4: Malformed Request Payload Handling ---');
    const malformedPayload = {
      taskId: 'rw_malformed_01',
      // missing description and targetDomain
    };

    const res4 = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(malformedPayload)
    });

    if (res4.status === 400) {
      console.log('✓ Scenario 4 Passed: Server properly rejected malformed payload with HTTP 400.');
    } else {
      throw new Error(`Scenario 4 Failed: Expected HTTP 400, got ${res4.status}`);
    }

    console.log('\n====================================================');
    console.log('=== ALL REAL-WORLD RESILIENCE TESTS PASSED (4/4) ===');
    console.log('====================================================');

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runRealWorldTestSuite().catch(err => {
  console.error('\n❌ Real-World Test Suite Failed:', err);
  process.exit(1);
});
