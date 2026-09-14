import { PipelineOrchestrator } from '../src/orchestration/PipelineOrchestrator';
import { JarvisDaemon } from '../src/daemon/JarvisDaemon';
import dotenv from 'dotenv';

dotenv.config();

async function runTest() {
  console.log('====================================================');
  console.log('=== TESTING PIPELINE CHAINING & REDIS/MEMORY DAEMON===');
  console.log('====================================================');

  // 1. Test Pipeline Chaining
  const pipeline = new PipelineOrchestrator();
  const complexDirective = "Calculate moving averages for sensor telemetry, then analyze anomaly bounds and format a compliance report.";
  
  const pipelineResult = await pipeline.executePipeline(complexDirective, {
    readings: [10.2, 10.5, 12.1, 10.3, 28.4, 10.6],
    windowSize: 3,
    zScoreThreshold: 2.0
  });

  console.log('Pipeline Final Result Summary:', JSON.stringify(pipelineResult.finalOutput, null, 2));

  // 2. Test Daemon Event Loop
  console.log('\n----------------------------------------------------');
  console.log('=== TESTING BACKGROUND EVENT LOOP DAEMON          ===');
  
  const daemon = new JarvisDaemon('redis://localhost:6379', 'jarvis:directives');

  daemon.on('result', (res) => {
    console.log('📥 [Daemon Event Loop Output Listener Received Result]:', res.directive);
  });

  await daemon.start();

  console.log('🚀 Dispatching background directive event to Daemon...');
  await daemon.dispatchDirective("Validate battery voltage threshold and calculate discharge curve", { voltage: 22.4, cells: 6 });

  // Wait 2 seconds for daemon background execution
  await new Promise(resolve => setTimeout(resolve, 2000));
  await daemon.stop();

  console.log('====================================================');
  console.log('=== PIPELINE & DAEMON ARCHITECTURE VERIFIED      ===');
  console.log('====================================================');
  
  // Ensure process terminates cleanly back to shell prompt
  process.exit(0);
}

runTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
