import express from 'express';
import { createServer } from 'http';
import { createOrchestratorRouter } from '../src/interaction/routes/orchestrator-routes.js';

async function testDirectiveHttpEndpoint() {
  console.log('=== TESTING AGENT ORCHESTRATOR DIRECTIVE HTTP ENDPOINT ===\n');

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
    directive: 'Design a CAD housing frame, synthesize a telemetry helper tool, and execute flight test on hardware'
  };

  console.log(`[HTTP] Dispatching POST /api/orchestrator/directive with directive:\n"${payload.directive}"...\n`);
  const response = await fetch(`http://127.0.0.1:${port}/api/orchestrator/directive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const json: any = await response.json();
  console.log(`[HTTP Response] Status: ${response.status}`);
  console.log('[HTTP Response Body]:\n', JSON.stringify(json, null, 2));

  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (response.status !== 200 || json.status !== 'COMPLETED') {
    throw new Error(`Directive HTTP endpoint test failed with status ${response.status}`);
  }

  if (!json.subTaskResults || json.subTaskResults.length < 3) {
    throw new Error('Directive failed to decompose into expected subtasks');
  }

  console.log('\n✓ Test Passed: AgentOrchestrator /directive HTTP endpoint operational.');
}

testDirectiveHttpEndpoint().catch((err) => {
  console.error('❌ Directive HTTP test failed:', err);
  process.exit(1);
});
