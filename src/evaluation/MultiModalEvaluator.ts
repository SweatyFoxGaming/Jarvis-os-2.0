export interface EvaluationResult {
  success: boolean;
  score: number;
  feedback?: string;
  channel: string;
}

export class MultiModalEvaluator {
  async evaluateOutput(params: { channel: string; rawOutput: string }): Promise<EvaluationResult> {
    const hasContent = params.rawOutput.trim().length > 0;
    return {
      success: hasContent,
      score: hasContent ? 1.0 : 0.0,
      feedback: hasContent ? 'Output evaluated successfully' : 'Empty output received',
      channel: params.channel
    };
  }
}
