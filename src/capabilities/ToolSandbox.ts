import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';

// Construct CJS require in ESM scope to import TypeScript runtime compiler
const cjsRequire = createRequire(import.meta.url);
const ts = cjsRequire('typescript');

export class ToolSandbox {
  /**
   * Executes a dynamically generated TypeScript module inside an isolated worker thread.
   * @param toolFilePath Absolute path to the .ts tool file
   * @param inputData Data to pass into the tool
   * @param timeoutMs Hard timeout to terminate the thread (default 2000ms)
   */
  public async executeTool(toolFilePath: string, inputData: any, timeoutMs: number = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const absFilePath = path.resolve(toolFilePath);

      if (!fs.existsSync(absFilePath)) {
        return reject(new Error(`Tool file not found: ${absFilePath}`));
      }

      let transpiledCode: string;
      try {
        const sourceCode = fs.readFileSync(absFilePath, 'utf8');
        const result = ts.transpileModule(sourceCode, {
          compilerOptions: {
            module: ts.ModuleKind?.CommonJS ?? 1,
            target: ts.ScriptTarget?.ES2022 ?? 9,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true
          }
        });
        transpiledCode = result.outputText;
      } catch (err: any) {
        return reject(new Error(`TypeScript Transpilation Error: ${err.message || err}`));
      }

      const workerCode = `
        const { parentPort, workerData } = require('worker_threads');
        const { createRequire } = require('module');

        (async () => {
          try {
            const customRequire = createRequire(workerData.absFilePath);
            const module = { exports: {} };
            const exports = module.exports;

            const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', workerData.transpiledCode);
            fn(module, exports, customRequire, workerData.absFilePath, workerData.dirName);

            const mod = module.exports;
            const func = Object.values(mod).find(v => typeof v === 'function');
            if (!func) {
              throw new Error('No exported function found in generated tool.');
            }

            const result = await func(workerData.inputData);
            parentPort.postMessage({ success: true, result });
          } catch (err) {
            parentPort.postMessage({ success: false, error: err.message || err.toString() });
          }
        })();
      `;

      let settled = false;

      const worker = new Worker(workerCode, {
        eval: true,
        workerData: {
          transpiledCode,
          absFilePath,
          dirName: path.dirname(absFilePath),
          inputData
        }
      });

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(new Error(`Sandbox Security Timeout: Tool execution exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      worker.on('message', (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (msg.success) resolve(msg.result);
        else reject(new Error(`Tool Execution Error: ${msg.error}`));
      });

      worker.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      });

      worker.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (code !== 0) reject(new Error(`Sandbox thread crashed with exit code ${code}`));
      });
    });
  }
}
