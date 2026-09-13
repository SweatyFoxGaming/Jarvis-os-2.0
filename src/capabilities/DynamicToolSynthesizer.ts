import * as fs from 'fs/promises';
import * as path from 'path';

export interface SynthesizedTool {
  toolId: string;
  filePath: string;
  sourceCode: string;
}

export class DynamicToolSynthesizer {
  async synthesizeTool(toolId: string, code: string): Promise<SynthesizedTool> {
    const dir = path.join(process.cwd(), 'jarvis-workspace', 'capabilities');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${toolId}.ts`);
    await fs.writeFile(filePath, code, 'utf-8');
    return { toolId, filePath, sourceCode: code };
  }
}
