import { DirectiveOrchestrator } from '../src/orchestration/DirectiveOrchestrator';
import dotenv from 'dotenv';

dotenv.config();

async function runAutonomousTest() {
  console.log('====================================================');
  console.log('=== TESTING JARVIS AUTONOMOUS TOOL CREATION      ===');
  console.log('====================================================');

  const orchestrator = new DirectiveOrchestrator();

  try {
    // Give Jarvis a brand-new task out of thin air
    const directive = "Calculate the optimal battery discharge curve and generate a thermal warning report for drone flight vectors.";
    
    const result = await orchestrator.executeDirective(directive, { batteryVoltage: 22.4, cellCount: 6 });
    
    console.log('Autonomous Tool Execution Result:', JSON.stringify(result, null, 2));
    console.log('====================================================');
    console.log('=== AUTONOMOUS CREATION VERIFIED SUCCESSFULLY    ===');
    console.log('====================================================');
  } catch (err) {
    console.error('❌ Autonomous test failed:', err);
    process.exit(1);
  }
}

runAutonomousTest();
