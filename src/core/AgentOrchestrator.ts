import { UniversalHardwareEngine, HardwareCommand } from '../hardware/UniversalHardwareEngine.js';
import { UniversalCADEngine, CSGNode } from '../cad/UniversalCADEngine.js';
import { DynamicToolSynthesizer } from '../capabilities/DynamicToolSynthesizer.js';
import { MultiModalEvaluator, EvaluationResult } from '../evaluation/MultiModalEvaluator.js';
import { SelfModificationEngine } from './SelfModificationEngine.js';

export interface TaskRequest {
  taskId: string;
  description: string;
  targetDomain: 'HARDWARE' | 'CAD' | 'HYBRID';
  cadModel?: CSGNode;
  hardwareCommand?: HardwareCommand;
}

export interface OrchestrationResult {
  taskId: string;
  status: 'COMPLETED' | 'FAILED' | 'MODIFIED';
  executionLog: string[];
  evaluations: EvaluationResult[];
}

export class AgentOrchestrator {
  constructor(
    private hardwareEngine: UniversalHardwareEngine,
    private cadEngine: UniversalCADEngine,
    private synthesizer: DynamicToolSynthesizer,
    private evaluator: MultiModalEvaluator,
    private selfModEngine: SelfModificationEngine
  ) {}

  async processTask(task: TaskRequest): Promise<OrchestrationResult> {
    const executionLog: string[] = [];
    const evaluations: EvaluationResult[] = [];
    executionLog.push(`[Orchestrator] Initiating task ${task.taskId}: "${task.description}"`);

    try {
      if (task.targetDomain === 'CAD' || task.targetDomain === 'HYBRID') {
        if (task.cadModel) {
          executionLog.push(`[Orchestrator] Executing CAD synthesis for ${task.taskId}`);
          const renderResult = await this.cadEngine.generateArtifact(
            'SCAD',
            task.cadModel,
            `jarvis-workspace/cad/${task.taskId}.scad`
          );
          executionLog.push(`[Orchestrator] CAD artifact generated: ${renderResult.outputFilePath}`);
          
          const evalResult = await this.evaluator.evaluateOutput({
            channel: 'TERMINAL',
            rawOutput: `Successfully generated CAD model at ${renderResult.outputFilePath}`
          });
          evaluations.push(evalResult);
        }
      }

      if (task.targetDomain === 'HARDWARE' || task.targetDomain === 'HYBRID') {
        if (task.hardwareCommand) {
          executionLog.push(`[Orchestrator] Dispatching command to Hardware Engine: ${task.hardwareCommand.action}`);
          const hwResponse = await this.hardwareEngine.execute(task.hardwareCommand);
          executionLog.push(`[Orchestrator] Hardware response: ${hwResponse.message}`);

          const telemetry = await this.hardwareEngine.pollTelemetry();
          if (telemetry) {
            const evalResult = await this.evaluator.evaluateOutput({
              channel: 'TELEMETRY',
              rawOutput: JSON.stringify(telemetry)
            });
            evaluations.push(evalResult);
          }
        }
      }

      executionLog.push(`[Orchestrator] Task ${task.taskId} successfully processed.`);
      return {
        taskId: task.taskId,
        status: 'COMPLETED',
        executionLog,
        evaluations
      };
    } catch (error: any) {
      executionLog.push(`[Orchestrator] Execution failure: ${error.message}`);
      return {
        taskId: task.taskId,
        status: 'FAILED',
        executionLog,
        evaluations
      };
    }
  }
}
