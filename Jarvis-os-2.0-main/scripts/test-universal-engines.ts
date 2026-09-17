import * as fs from 'fs/promises';
import * as path from 'path';
import { UniversalHardwareEngine } from '../src/hardware/UniversalHardwareEngine.js';
import { MockHardwareDriver } from '../src/hardware/MockHardwareDriver.js';
import { UniversalCADEngine, CSGNode } from '../src/cad/UniversalCADEngine.js';
import { OpenSCADExporter } from '../src/cad/OpenSCADExporter.js';

async function runUniversalEngineTests() {
  console.log('=== TESTING UNIVERSAL HARDWARE & CAD ENGINES ===\n');

  // --- TEST 1: Universal Hardware Engine ---
  console.log('--- TEST 1: Hardware Abstraction & Telemetry ---');
  const hwEngine = new UniversalHardwareEngine();
  const mockDriver = new MockHardwareDriver();

  hwEngine.registerDriver(mockDriver);
  await mockDriver.connect('mock://localhost:8080');

  const cmdResult = await hwEngine.execute({ action: 'TAKEOFF', parameters: { altitude: 10 } });
  console.log(`[Hardware Command] Result:`, cmdResult);

  const telemetry = await hwEngine.pollTelemetry();
  console.log(`[Hardware Telemetry]:`, telemetry);

  if (!telemetry || telemetry.systemStatus !== 'ARMED') {
    throw new Error('Hardware driver telemetry failed validation');
  }
  console.log('✓ Test 1 Passed: Hardware telemetry & execution operational.');

  // --- TEST 2: Universal CAD Engine ---
  console.log('\n--- TEST 2: Dynamic CAD CSG Code Generation ---');
  const cadEngine = new UniversalCADEngine();
  cadEngine.registerExporter(new OpenSCADExporter());

  const csgModel: CSGNode = {
    operation: 'DIFFERENCE',
    children: [
      { type: 'CUBE', dimensions: [10, 10, 10] },
      { type: 'CYLINDER', dimensions: [12, 3] }
    ]
  };

  const outputDir = path.join(process.cwd(), 'jarvis-workspace', 'cad');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'test_housing.scad');

  const renderResult = await cadEngine.generateArtifact('SCAD', csgModel, outputPath);
  console.log(`[CAD Render Result]:`, renderResult);

  const generatedCode = await fs.readFile(outputPath, 'utf-8');
  console.log(`[Generated OpenSCAD Code]:\n${generatedCode}`);

  if (!generatedCode.includes('difference()')) {
    throw new Error('CAD code generation failed CSG compilation');
  }
  console.log('✓ Test 2 Passed: OpenSCAD artifact compiled and saved.');

  console.log('\n=== ALL UNIVERSAL ENGINE TESTS PASSED ===');
}

runUniversalEngineTests().catch((err) => {
  console.error('❌ Test execution failed:', err);
  process.exit(1);
});
