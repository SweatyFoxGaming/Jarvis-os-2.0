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
  cadFormat?: 'SCAD' | 'SVG' | 'STL';
  cadModel?: CSGNode;
  hardwareCommand?: HardwareCommand;
  toolCode?: { toolId: string; code?: string };
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

  public decomposeDirective(directive: string): MultiStepPlan {
    const planId = `plan_${Date.now()}`;
    const subTasks: SubTask[] = [];
    const lower = directive.toLowerCase();

    // 1. Dynamic CAD Generation Subtasks (SCAD, SVG, STL)
    if (lower.includes('design') || lower.includes('cad') || lower.includes('mount') || lower.includes('chassis')) {
      const baseModel: CSGNode = {
        operation: 'DIFFERENCE',
        children: [
          { type: 'CUBE', dimensions: [60, 60, 15] },
          { type: 'CYLINDER', dimensions: [20, 15] }
        ]
      };

      subTasks.push({
        subTaskId: `${planId}_sub_cad_scad`,
        description: `Synthesize 3D OpenSCAD model for directive: "${directive}"`,
        domain: 'CAD',
        cadFormat: 'SCAD',
        cadModel: baseModel
      });

      subTasks.push({
        subTaskId: `${planId}_sub_cad_svg`,
        description: `Export 2D SVG layout vector profile`,
        domain: 'CAD',
        cadFormat: 'SVG',
        cadModel: baseModel
      });

      subTasks.push({
        subTaskId: `${planId}_sub_cad_stl`,
        description: `Export 3D printable STL mesh file`,
        domain: 'CAD',
        cadFormat: 'STL',
        cadModel: baseModel
      });
    }

    // 2. Dynamic Tool Synthesis
    if (lower.includes('tool') || lower.includes('diagnostic') || lower.includes('monitor') || lower.includes('synthesize')) {
      const toolId = `telemetry_tool_${Date.now()}`;
      subTasks.push({
        subTaskId: `${planId}_sub_synth`,
        description: 'Synthesize custom TS telemetry monitor utility',
        domain: 'SYNTHESIS',
        toolCode: {
          toolId,
          code: `export function processTelemetry(data: any) {\n  return {\n    toolId: '${toolId}',\n    processedAt: Date.now(),\n    status: 'OPTIMAL',\n    inputs: data\n  };\n}`
        }
      });
    }

    // 3. Hardware Execution
    if (lower.includes('hardware') || lower.includes('spin') || lower.includes('flight') || lower.includes('test')) {
      const dependsOn = subTasks.map(st => st.subTaskId);
      subTasks.push({
        subTaskId: `${planId}_sub_hw`,
        description: `Execute hardware commands over MAVLink/Serial protocol`,
        domain: 'HARDWARE',
        hardwareCommand: lower.includes('spin') || lower.includes('flight')
          ? { action: 'TAKEOFF', parameters: { altitude: 3.0 } }
          : { action: 'ARM', parameters: {} },
        dependsOn
      });
    }

    if (subTasks.length === 0) {
      subTasks.push({
        subTaskId: `${planId}_sub_default`,
        description: `Default CAD design task for: ${directive}`,
        domain: 'CAD',
        cadFormat: 'SCAD',
        cadModel: { operation: 'UNION', children: [{ type: 'CUBE', dimensions: [20, 20, 20] }] }
      });
    }

    return { planId, directive, subTasks };
  }

  public async processTask(task: TaskRequest): Promise<OrchestrationResult> {
    const executionLog: string[] = [];
    const evaluations: EvaluationResult[] = [];
    executionLog.push(`[Orchestrator] Initiating task ${task.taskId}: "${task.description}"`);

    try {
      if ((task.targetDomain === 'CAD' || task.targetDomain === 'HYBRID') && task.cadModel) {
        executionLog.push(`[Orchestrator] Executing CAD synthesis for ${task.taskId}`);
        const renderResult = await this.cadEngine.generateArtifact('SCAD', task.cadModel, `jarvis-workspace/cad/${task.taskId}.scad`);
        executionLog.push(`[Orchestrator] CAD artifact generated: ${renderResult.outputFilePath}`);
        
        evaluations.push(await this.evaluator.evaluateOutput({
          channel: 'TERMINAL',
          rawOutput: `Generated CAD file ${renderResult.outputFilePath}`
        }));
      }

      if ((task.targetDomain === 'HARDWARE' || task.targetDomain === 'HYBRID') && task.hardwareCommand) {
        executionLog.push(`[Orchestrator] Dispatching command to Hardware Engine: ${task.hardwareCommand.action}`);
        const hwResponse = await this.hardwareEngine.execute(task.hardwareCommand);
        executionLog.push(`[Orchestrator] Hardware response: ${hwResponse.message}`);

        const telemetry = await this.hardwareEngine.pollTelemetry();
        if (telemetry) {
          evaluations.push(await this.evaluator.evaluateOutput({
            channel: 'TELEMETRY',
            rawOutput: JSON.stringify(telemetry)
          }));
        }
      }

      executionLog.push(`[Orchestrator] Task ${task.taskId} successfully processed.`);
      return { taskId: task.taskId, status: 'COMPLETED', executionLog, evaluations };
    } catch (error: any) {
      executionLog.push(`[Orchestrator] Execution failure: ${error.message}`);
      return { taskId: task.taskId, status: 'FAILED', executionLog, evaluations };
    }
  }

  public async processDirective(directive: string, customPlan?: MultiStepPlan): Promise<MultiStepOrchestrationResult> {
    const plan = customPlan || this.decomposeDirective(directive);
    const executionLog: string[] = [];
    const evaluations: EvaluationResult[] = [];
    const subTaskResults: MultiStepOrchestrationResult['subTaskResults'] = [];

    executionLog.push(`[Orchestrator] Processing directive "${directive}" under Plan ID: ${plan.planId}`);
    let overallSuccess = true;

    for (const subtask of plan.subTasks) {
      executionLog.push(`\n[SubTask] Starting ${subtask.subTaskId} (${subtask.domain})`);

      try {
        if (subtask.domain === 'CAD' && subtask.cadModel) {
          const format = subtask.cadFormat || 'SCAD';
          const ext = format.toLowerCase();
          const outputPath = `jarvis-workspace/cad/${subtask.subTaskId}.${ext}`;
          const renderResult = await this.cadEngine.generateArtifact(format, subtask.cadModel, outputPath);
          executionLog.push(`[CAD Engine] Rendered ${renderResult.format} at ${renderResult.outputFilePath}`);
          
          evaluations.push(await this.evaluator.evaluateOutput({
            channel: 'TERMINAL',
            rawOutput: `Generated ${format} artifact at ${outputPath}`
          }));
        } else if (subtask.domain === 'SYNTHESIS' && subtask.toolCode) {
          const synthResult = await this.synthesizer.synthesizeTool(subtask.toolCode.toolId, subtask.toolCode.code);
          executionLog.push(`[Synthesizer] Dynamic tool written to ${synthResult.filePath}`);
        } else if (subtask.domain === 'HARDWARE' && subtask.hardwareCommand) {
          const hwRes = await this.hardwareEngine.execute(subtask.hardwareCommand);
          executionLog.push(`[Hardware Engine] ${hwRes.message}`);

          const telemetry = await this.hardwareEngine.pollTelemetry();
          if (telemetry) {
            evaluations.push(await this.evaluator.evaluateOutput({
              channel: 'TELEMETRY',
              rawOutput: JSON.stringify(telemetry)
            }));
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
