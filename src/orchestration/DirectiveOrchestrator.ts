import { ToolVectorStore } from '../capabilities/ToolVectorStore.js';
import { ToolSandbox } from '../capabilities/ToolSandbox.js';
import * as fs from 'fs';
import * as path from 'path';

export class DirectiveOrchestrator {
  private vectorStore: ToolVectorStore;
  private sandbox: ToolSandbox;
  private workspaceDir: string;
  private apiKey: string;

  constructor(workspaceDir?: string) {
    this.vectorStore = new ToolVectorStore();
    this.sandbox = new ToolSandbox();
    this.workspaceDir = workspaceDir || path.resolve(process.cwd(), 'jarvis-workspace', 'capabilities');
    this.apiKey = process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || '';
    
    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  private generateEmbedding(text: string): number[] {
    const embedding = Array(768).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const words = normalized.split(/\s+/);

    for (let wIndex = 0; wIndex < words.length; wIndex++) {
      const word = words[wIndex];
      for (let i = 0; i < word.length; i++) {
        const charCode = word.charCodeAt(i);
        const idx = (charCode * (i + 1) + wIndex * 31) % 768;
        embedding[idx] += 1.0;
      }
    }

    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0)) || 1;
    return embedding.map(val => val / magnitude);
  }

  /**
   * Programmatically guarantees that generated TypeScript code adheres to the default export contract.
   */
  private sanitizeAndForceExport(code: string): string {
    if (code.includes('export default')) {
      return code;
    }
    if (code.includes('async function execute')) {
      return code.replace('async function execute', 'export default async function execute');
    }
    if (code.includes('function execute')) {
      return code.replace('function execute', 'export default async function execute');
    }
    // Absolute fallback wrapper if the LLM output is purely raw statements
    return `export default async function execute(inputs: any) {\n${code}\n}`;
  }

  private async synthesizeCodeWithLLM(directiveText: string, sampleInput: any, errorMessage?: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY or GROQ_API_KEY is required for autonomous code synthesis.');
    }

    const prompt = `You are Jarvis OS Senior Systems Engineer & Code Synthesizer. Write a complete, highly robust, production-grade TypeScript asynchronous default export function that fulfills this user directive:
Directive: "${directiveText}"

INPUT CONTRACT:
Your function will receive an 'inputs' object with this exact structure:
${JSON.stringify(sampleInput, null, 2)}

${errorMessage ? `\nIMPORTANT: The previous attempt failed with this error:\n${errorMessage}\nFix this error in your new code while adhering strictly to the input contract and export rules.` : ''}

CRITICAL ENGINEERING RULES:
1. You MUST export a default async function: 'export default async function execute(inputs: any) { ... }'
2. **NO MOCK OR FAKE DATA:** Write real algorithms, validations, statistics, or processing logic using the exact keys present in the input contract.
3. Validate inputs defensively and return clean JSON-serializable results.
4. Output ONLY raw TypeScript code inside markdown code blocks (no extra conversational text).
`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    const codeMatch = text.match(/```(?:typescript|ts)?([\s\S]*?)```/);
    const rawCode = codeMatch ? codeMatch[1].trim() : text.trim();
    
    return this.sanitizeAndForceExport(rawCode);
  }

  public async executeDirective(directiveText: string, inputPayload: any): Promise<any> {
    console.log(`\n🤖 [Jarvis Autonomous Agent] Ingesting Directive: "${directiveText}"`);

    const queryEmbedding = this.generateEmbedding(directiveText);
    const matches = await this.vectorStore.searchTools(queryEmbedding, 1);

    let toolFilePath: string;
    let toolName: string;

    if (matches.length > 0 && matches[0].similarity > 0.85) {
      const matchedTool = matches[0];
      toolName = matchedTool.name;
      toolFilePath = matchedTool.metadata.filePath;
      console.log(`✓ [pgvector Cache Hit]: Reusing existing tool "${toolName}" (Similarity: ${(matches[0].similarity * 100).toFixed(1)}%)`);
    } else {
      toolName = `jarvis_tool_${Date.now()}`;
      toolFilePath = path.join(this.workspaceDir, `${toolName}.ts`);
      
      console.log(`🧠 [Autonomous Synthesis]: Engineering real algorithmic tool for "${toolName}"...`);
      
      let code = await this.synthesizeCodeWithLLM(directiveText, inputPayload);
      fs.writeFileSync(toolFilePath, code, 'utf8');

      let maxRetries = 3;
      let attempt = 0;
      let success = false;
      let lastError: string = '';

      while (attempt < maxRetries && !success) {
        try {
          console.log(`🛡️ [Sandbox Verification] Testing compiled code (Attempt ${attempt + 1})...`);
          await this.sandbox.executeTool(toolFilePath, inputPayload, 3000);
          success = true;
          console.log(`✓ [Self-Healing Success]: Tool compiled and executed cleanly.`);
        } catch (err: any) {
          lastError = err.message || err.toString();
          attempt++;
          console.warn(`⚠️ [Self-Healing Triggered]: Error caught: ${lastError}`);
          if (attempt < maxRetries) {
            console.log(`🔧 [Autonomous Patching]: Instructing LLM to fix code logic...`);
            code = await this.synthesizeCodeWithLLM(directiveText, inputPayload, lastError);
            fs.writeFileSync(toolFilePath, code, 'utf8');
          } else {
            throw new Error(`Autonomous self-healing failed after ${maxRetries} attempts. Last error: ${lastError}`);
          }
        }
      }

      await this.vectorStore.upsertTool(
        toolName,
        `Autonomously engineered tool for: ${directiveText}`,
        queryEmbedding,
        { filePath: toolFilePath, category: 'autonomous' }
      );
      console.log(`✓ Tool indexed into pgvector memory bank.`);
    }

    console.log(`🚀 [Execution]: Running tool in isolated thread...`);
    const result = await this.sandbox.executeTool(toolFilePath, inputPayload, 3000);
    console.log(`[Directive Completed Successfully] ✓\n`);
    
    return result;
  }
}
