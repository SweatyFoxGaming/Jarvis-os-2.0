import { DirectiveOrchestrator } from './DirectiveOrchestrator';

export class PipelineOrchestrator {
  private directiveOrchestrator: DirectiveOrchestrator;
  private apiKey: string;

  constructor() {
    this.directiveOrchestrator = new DirectiveOrchestrator();
    this.apiKey = process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || '';
  }

  /**
   * Decomposes a complex multi-step user directive into an ordered sequence of sub-directives.
   */
  private async decomposePipeline(complexDirective: string): Promise<string[]> {
    if (!this.apiKey) {
      return [complexDirective];
    }

    const prompt = `You are Jarvis OS Pipeline Architect. Break down this complex user directive into an ordered list of 2 to 4 sequential atomic sub-directives that can be executed as a pipeline:
Complex Directive: "${complexDirective}"

Rules:
1. Return ONLY a valid JSON array of strings representing the sequential sub-directives. Example: ["Step 1 directive", "Step 2 directive"]
2. No extra conversational text or markdown formatting outside the JSON array.
`;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      console.warn('⚠️ Pipeline decomposition fallback to single step:', err);
    }

    return [complexDirective];
  }

  /**
   * Executes a multi-step pipeline, piping the output of step N into step N+1.
   */
  public async executePipeline(complexDirective: string, initialPayload: any): Promise<any> {
    console.log(`\n⛓️ [Pipeline Orchestrator] Analyzing Complex Directive: "${complexDirective}"`);
    
    const steps = await this.decomposePipeline(complexDirective);
    console.log(`📋 [Pipeline Plan]: Decomposed into ${steps.length} sequential steps:`);
    steps.forEach((step, idx) => console.log(`   [Step ${idx + 1}]: ${step}`));

    let currentPayload = initialPayload;
    const executionHistory: any[] = [];

    for (let i = 0; i < steps.length; i++) {
      const stepDirective = steps[i];
      console.log(`\n--- Executing Pipeline Step ${i + 1} of ${steps.length} ---`);
      
      const result = await this.directiveOrchestrator.executeDirective(stepDirective, currentPayload);
      executionHistory.push({ stepNumber: i + 1, directive: stepDirective, result });
      
      // Pipe output result as input for the next step
      currentPayload = {
        ...currentPayload,
        previousStepOutput: result
      };
    }

    console.log(`\n[Pipeline Execution Completed Successfully] ✓\n`);
    return {
      complexDirective,
      totalSteps: steps.length,
      finalOutput: currentPayload,
      executionHistory
    };
  }
}
