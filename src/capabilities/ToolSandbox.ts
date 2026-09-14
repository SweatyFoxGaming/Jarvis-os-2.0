import { Worker } from 'worker_threads';
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

      const workerCode = `
        const { parentPort, workerData } = require('worker_threads');
        
        try {
          require('tsx/cjs');
        } catch (e) {}

        (async () => {
          try {
            let mod;
            try {
              mod = require(workerData.absFilePath);
            } catch (err) {
              const { register } = require('node:module');
              const { pathToFileURL } = require('node:url');
              register('tsx', pathToFileURL(__filename));
              mod = await import(pathToFileURL(workerData.absFilePath).href);
            }
            
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

      const execArgv = [...process.execArgv];
      if (!execArgv.some(arg => arg.includes('tsx') || arg.includes('import'))) {
        execArgv.push('--import', 'tsx');
      }

      let settled = false;

      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { absFilePath, inputData },
        execArgv
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
