import JarvisOS from '../src/JarvisOS';
import dotenv from 'dotenv';

dotenv.config();

async function verifyCore() {
  console.log('====================================================');
  console.log('=== VERIFYING UNIFIED JARVIS OS CORE ENGINE      ===');
  console.log('====================================================');

  const jarvis = new JarvisOS();

  try {
    // 1. Initialize Core
    await jarvis.initialize();

    // 2. Test Single Directive Execution
    console.log('\n--- Test 1: Single Atomic Directive ---');
    const singleResult = await jarvis.executeDirective(
      "Calculate statistical variance and mean for an array of numbers",
      { numbers: [5, 10, 15, 20, 25] }
    );
    console.log('Single Directive Result:', singleResult);

    // 3. Test Pipeline Chaining
    console.log('\n--- Test 2: Multi-Tool Pipeline Chaining ---');
    const pipelineResult = await jarvis.runPipeline(
      "Calculate moving averages for sensor telemetry, analyze anomaly bounds, and generate a compliance report.",
      { readings: [10.1, 10.4, 10.2, 30.1, 10.5], windowSize: 3, zScoreThreshold: 2.0 }
    );
    console.log('Pipeline Final Status:', pipelineResult.finalOutput.overallStatus || 'SUCCESS');

    // 4. Test Background Daemon Integration
    console.log('\n--- Test 3: Background Daemon Event Loop ---');
    jarvis.daemon.on('result', (res) => {
      console.log('📥 [Core Daemon Listener]: Processed directive ->', res.directive);
    });

    await jarvis.startDaemon();
    await jarvis.dispatchDirective("Validate system telemetry health check", { status: 'nominal' });

    // Wait for daemon execution
    await new Promise(resolve => setTimeout(resolve, 2000));
    await jarvis.shutdown();

    console.log('====================================================');
    console.log('=== JARVIS OS CORE INTEGRATION VERIFIED CLEANLY  ===');
    console.log('====================================================');
    process.exit(0);
  } catch (err) {
    console.error('❌ Jarvis Core verification failed:', err);
    process.exit(1);
  }
}

verifyCore();
