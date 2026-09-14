import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

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
        const req = typeof require !== 'undefined' ? require : createRequire(path.join(process.cwd(), 'dummy.js'));
        
        // Use tsx's internal transform sync or simple regex/babel/esbuild fallback, 
        // or typescript compiler API if available. Let's use standard node evaluation fallback:
        // Actually, tsx registers a require hook! We can require tsx/cjs/api or transpile using simple tsx support.
        // Let's use esbuild if available, or fallback to tsx transform.
        const esbuild = req('esbuild');
        const result = esbuild.transformSync(sourceCode, {
          loader: 'ts',
          format: 'cjs',
          target: 'es2022'
        });
        transpiledCode = result.code;
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

            // Execute the compiled CommonJS string in isolated function context
            const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', workerData.transpiledCode);
            fn(module, exports, customRequire, workerData.absFilePath, workerData.dirName);

            const mod = module.exports;
            let func = typeof mod === 'function' ? mod : null;
            if (!func && mod && typeof mod.default === 'function') func = mod.default;
            if (!func && mod) func = Object.values(mod).find(v => typeof v === 'function');
            
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
