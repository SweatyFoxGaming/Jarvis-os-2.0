import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

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

      // We no longer manually transpile. The worker thread inherits the 'tsx' loader 
      // from the main process and compiles the .ts file natively on import.
      const workerCode = `
        const { parentPort, workerData } = require('worker_threads');
        
        (async () => {
          try {
            // Format path safely for the file:// protocol (works across Linux/Windows)
            const formattedPath = workerData.absFilePath.replace(/\\\\/g, '/');
            const fileUrl = formattedPath.startsWith('/') ? 'file://' + formattedPath : 'file:///' + formattedPath;
            
            let mod;
            try {
              // Prefer ESM dynamic import, which correctly hooks into modern tsx loaders
              mod = await import(fileUrl);
            } catch (importErr) {
              // Fallback for older CJS environments
              mod = require(workerData.absFilePath);
            }
            
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
        execArgv: process.execArgv, // Inherit the loader arguments from the main process
        workerData: {
          absFilePath,
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
