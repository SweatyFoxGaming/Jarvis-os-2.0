import { DirectiveOrchestrator } from '../src/orchestration/DirectiveOrchestrator';
import dotenv from 'dotenv';

dotenv.config();

async function runOrchestratorTest() {
  console.log('====================================================');
  console.log('=== TESTING SEMANTIC ORCHESTRATOR & PGVECTOR LOOP ===');
  console.log('====================================================');

  const orchestrator = new DirectiveOrchestrator();

  try {
    // Test 1: First call synthesizes and indexes a new tool
    const directive1 = "Analyze system telemetry and optimize performance metrics";
    const res1 = await orchestrator.executeDirective(directive1, { value: 21 });
    console.log('Test 1 Execution Output:', res1);

    console.log('\n----------------------------------------------------');
    
    // Test 2: Highly overlapping semantic directive should trigger pgvector cache reuse
    const directive2 = "Analyze system telemetry and optimize performance metrics";
    const res2 = await orchestrator.executeDirective(directive2, { value: 50 });
    console.log('Test 2 Execution Output (Cache Reuse Expected):', res2);

    console.log('\n====================================================');
    console.log('=== SEMANTIC ORCHESTRATOR VERIFICATION COMPLETE ===');
    console.log('====================================================');
  } catch (err) {
    console.error('❌ Orchestrator verification failed:', err);
    process.exit(1);
  }
}

runOrchestratorTest();
