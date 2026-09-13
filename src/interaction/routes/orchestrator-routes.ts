import { Router, Request, Response } from 'express';
import { AgentOrchestrator, TaskRequest } from '../../core/AgentOrchestrator.js';
import { UniversalHardwareEngine } from '../../hardware/UniversalHardwareEngine.js';
import { MockHardwareDriver } from '../../hardware/MockHardwareDriver.js';
import { UniversalCADEngine } from '../../cad/UniversalCADEngine.js';
import { OpenSCADExporter } from '../../cad/OpenSCADExporter.js';
import { DynamicToolSynthesizer } from '../../capabilities/DynamicToolSynthesizer.js';
import { MultiModalEvaluator } from '../../evaluation/MultiModalEvaluator.js';
import { SelfModificationEngine } from '../../core/SelfModificationEngine.js';

export function createOrchestratorRouter(): Router {
  const router = Router();

  const hwEngine = new UniversalHardwareEngine();
  const mockHw = new MockHardwareDriver();
  hwEngine.registerDriver(mockHw);
  mockHw.connect('mock://localhost:8080').catch(console.error);

  const cadEngine = new UniversalCADEngine();
  cadEngine.registerExporter(new OpenSCADExporter());

  const synthesizer = new DynamicToolSynthesizer();
  const evaluator = new MultiModalEvaluator();
  const selfModEngine = new SelfModificationEngine();

  const orchestrator = new AgentOrchestrator(
    hwEngine,
    cadEngine,
    synthesizer,
    evaluator,
    selfModEngine
  );

  // Single explicit task handler
  router.post('/task', async (req: Request, res: Response) => {
    try {
      const taskRequest: TaskRequest = req.body;
      if (!taskRequest.taskId || !taskRequest.description || !taskRequest.targetDomain) {
        res.status(400).json({ error: 'Missing required task fields: taskId, description, targetDomain' });
        return;
      }
      const result = await orchestrator.processTask(taskRequest);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // High-level directive task decomposition handler
  router.post('/directive', async (req: Request, res: Response) => {
    try {
      const { directive } = req.body;
      if (!directive || typeof directive !== 'string') {
        res.status(400).json({ error: 'Missing or invalid field: directive (string)' });
        return;
      }
      const result = await orchestrator.processDirective(directive);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
