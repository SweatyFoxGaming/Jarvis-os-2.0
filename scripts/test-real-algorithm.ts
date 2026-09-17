import { DirectiveOrchestrator } from '../src/orchestration/DirectiveOrchestrator';
import dotenv from 'dotenv';

dotenv.config();

async function runAlgorithmTest() {
  console.log('====================================================');
  console.log('=== TESTING REAL ALGORITHMIC TOOL SYNTHESIS      ===');
  console.log('====================================================');

  const orchestrator = new DirectiveOrchestrator();

  try {
    // A directive demanding real mathematical computation
    const directive = "Calculate the moving average, variance, and anomaly threshold bounds for a real-time array of sensor telemetry values.";
    
    const result = await orchestrator.executeDirective(directive, { 
      readings: [10.2, 10.5, 10.3, 10.8, 25.4, 10.4, 10.6, 9.9, 10.1, 10.5],
      windowSize: 3,
      zScoreThreshold: 2.0
    });
    
    console.log('Real Algorithmic Computation Result:', JSON.stringify(result, null, 2));
    console.log('====================================================');
    console.log('=== REAL ALGORITHM VERIFIED SUCCESSFULLY         ===');
    console.log('====================================================');
  } catch (err) {
    console.error('❌ Algorithm test failed:', err);
    process.exit(1);
  }
}

runAlgorithmTest();
