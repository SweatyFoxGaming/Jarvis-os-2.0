import express from 'express';
import { createServer } from 'http';
import { createOrchestratorRouter } from '../src/interaction/routes/orchestrator-routes.js';

async function testApiEndpoint() {
  console.log('=== TESTING AGENT ORCHESTRATOR HTTP ENDPOINT ===\n');

  const app = express();
  app.use(express.json());
  app.use('/api/orchestrator', createOrchestratorRouter());

  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind server address');
  }

  const port = address.port;
  console.log(`[Server] Listening on http://127.0.0.1:${port}`);

  const payload = {
    taskId: 'api_test_task_01',
    description: 'Test orchestrator API route via HTTP POST',
    targetDomain: 'HYBRID',
    cadModel: {
      operation: 'UNION',
      children: [
        { type: 'CUBE', dimensions: [15, 15, 15] },
        { type: 'SPHERE', dimensions: [10] }
      ]
    },
    hardwareCommand: {
      action: 'HOLD',
      parameters: { durationSec: 5 }
    }
  };

  console.log('[HTTP] Dispatching POST /api/orchestrator/task...');
  const response = await fetch(`http://127.0.0.1:${port}/api/orchestrator/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const json: any = await response.json();
  console.log(`[HTTP Response] Status: ${response.status}`);
  console.log('[HTTP Response Body]:\n', JSON.stringify(json, null, 2));

  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (response.status !== 200 || json.status !== 'COMPLETED') {
    throw new Error(`API endpoint test failed with HTTP status ${response.status}`);
  }

  console.log('\n✓ Test Passed: AgentOrchestrator HTTP endpoint operational.');
}

testApiEndpoint().catch((err) => {
  console.error('❌ API endpoint test failed:', err);
  process.exit(1);
});
