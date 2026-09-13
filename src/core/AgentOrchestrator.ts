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

export interface SubTask {
  subTaskId: string;
  description: string;
  domain: 'CAD' | 'HARDWARE' | 'SYNTHESIS';
  cadModel?: CSGNode;
  hardwareCommand?: HardwareCommand;
  toolCode?: { toolId: string; code: string };
  dependsOn?: string[];
}

export interface MultiStepPlan {
  planId: string;
  directive: string;
  subTasks: SubTask[];
}

export interface OrchestrationResult {
  taskId: string;
  status: 'COMPLETED' | 'FAILED' | 'MODIFIED';
  executionLog: string[];
  evaluations: EvaluationResult[];
}

export interface MultiStepOrchestrationResult {
  planId: string;
  directive: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  subTaskResults: Array<{
    subTaskId: string;
    domain: string;
    status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
    log: string;
  }>;
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

  /**
   * Deconstructs a high-level user directive into a structured multi-step plan.
   */
  public decomposeDirective(directive: string): MultiStepPlan {
    const planId = `plan_${Date.now()}`;
    const subTasks: SubTask[] = [];
    const lower = directive.toLowerCase();

    // Step 1: CAD Generation subtask if geometry or design is mentioned
    if (lower.includes('design') || lower.includes('cad') || lower.includes('mount') || lower.includes('frame') || lower.includes('housing')) {
      subTasks.push({
        subTaskId: `${planId}_sub_cad`,
        description: `Synthesize 3D CSG CAD geometry for directive: "${directive}"`,
        domain: 'CAD',
        cadModel: {
          operation: 'DIFFERENCE',
          children: [
            { type: 'CUBE', dimensions: [45, 45, 12] },
            { type: 'CYLINDER', dimensions: [15, 8] }
          ]
        }
      });
    }

    // Step 2: Dynamic Tool Synthesis if custom telemetry or calculation is requested
    if (lower.includes('tool') || lower.includes('monitor') || lower.includes('synthesize')) {
      subTasks.push({
        subTaskId: `${planId}_sub_synth`,
        description: 'Synthesize custom runtime helper utility',
        domain: 'SYNTHESIS',
        toolCode: {
          toolId: `telemetry_helper_${Date.now()}`,
          code: `export function processTelemetry(data: any) { return { status: 'OK', processedAt: Date.now() }; }`
        }
      });
    }

    // Step 3: Hardware execution subtask if action, flight, or physical test is requested
    if (lower.includes('hardware') || lower.includes('spin') || lower.includes('takeoff') || lower.includes('hover') || lower.includes('test') || lower.includes('flight')) {
      const dependsOn = subTasks.map(st => st.subTaskId);
      subTasks.push({
        subTaskId: `${planId}_sub_hw`,
        description: `Execute hardware verification for directive: "${directive}"`,
        domain: 'HARDWARE',
        hardwareCommand: lower.includes('takeoff') || lower.includes('hover') 
          ? { action: 'TAKEOFF', parameters: { altitude: 2.5 } }
          : { action: 'HOLD', parameters: { duration: 5 } },
        dependsOn
      });
    }

    // Fallback if no keywords matched
    if (subTasks.length === 0) {
      subTasks.push({
        subTaskId: `${planId}_sub_default`,
        description: `Default CAD design task for: ${directive}`,
        domain: 'CAD',
        cadModel: { type: 'CUBE', dimensions: [20, 20, 20] }
      });
    }

    return { planId, directive, subTasks };
  }

  /**
   * Processes a single explicit task request (Backward Compatible).
   */
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
      return { taskId: task.taskId, status: 'COMPLETED', executionLog, evaluations };
    } catch (error: any) {
      executionLog.push(`[Orchestrator] Execution failure: ${error.message}`);
      return { taskId: task.taskId, status: 'FAILED', executionLog, evaluations };
    }
  }

  /**
   * Accepts a high-level user directive, decomposes it into subtasks, and executes them sequentially.
   */
  async processDirective(directive: string, customPlan?: MultiStepPlan): Promise<MultiStepOrchestrationResult> {
    const plan = customPlan || this.decomposeDirective(directive);
    const executionLog: string[] = [];
    const evaluations: EvaluationResult[] = [];
    const subTaskResults: MultiStepOrchestrationResult['subTaskResults'] = [];

    executionLog.push(`[Orchestrator] Processing directive "${directive}" under Plan ID: ${plan.planId}`);
    executionLog.push(`[Orchestrator] Decomposed into ${plan.subTasks.length} sequential subtasks`);

    let overallSuccess = true;

    for (const subtask of plan.subTasks) {
      executionLog.push(`\n[SubTask] Starting ${subtask.subTaskId} (${subtask.domain}): "${subtask.description}"`);

      try {
        if (subtask.domain === 'CAD' && subtask.cadModel) {
          const outputPath = `jarvis-workspace/cad/${subtask.subTaskId}.scad`;
          const renderResult = await this.cadEngine.generateArtifact('SCAD', subtask.cadModel, outputPath);
          executionLog.push(`[CAD Engine] Rendered ${renderResult.format} at ${renderResult.outputFilePath}`);
          
          const evalRes = await this.evaluator.evaluateOutput({
            channel: 'TERMINAL',
            rawOutput: `Generated CAD file ${outputPath}`
          });
          evaluations.push(evalRes);
        } else if (subtask.domain === 'SYNTHESIS' && subtask.toolCode) {
          const synthResult = await this.synthesizer.synthesizeTool(subtask.toolCode.toolId, subtask.toolCode.code);
          executionLog.push(`[Synthesizer] Dynamic tool written to ${synthResult.filePath}`);
        } else if (subtask.domain === 'HARDWARE' && subtask.hardwareCommand) {
          const hwRes = await this.hardwareEngine.execute(subtask.hardwareCommand);
          executionLog.push(`[Hardware Engine] ${hwRes.message}`);

          const telemetry = await this.hardwareEngine.pollTelemetry();
          if (telemetry) {
            const evalRes = await this.evaluator.evaluateOutput({
              channel: 'TELEMETRY',
              rawOutput: JSON.stringify(telemetry)
            });
            evaluations.push(evalRes);
          }
        }

        subTaskResults.push({
          subTaskId: subtask.subTaskId,
          domain: subtask.domain,
          status: 'COMPLETED',
          log: `Subtask ${subtask.subTaskId} executed cleanly.`
        });
      } catch (err: any) {
        overallSuccess = false;
        executionLog.push(`[SubTask Error] ${subtask.subTaskId} failed: ${err.message}`);
        subTaskResults.push({
          subTaskId: subtask.subTaskId,
          domain: subtask.domain,
          status: 'FAILED',
          log: err.message
        });
      }
    }

    return {
      planId: plan.planId,
      directive,
      status: overallSuccess ? 'COMPLETED' : 'PARTIAL',
      subTaskResults,
      executionLog,
      evaluations
    };
  }
}
