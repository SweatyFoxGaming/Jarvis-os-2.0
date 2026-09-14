import { Worker } from 'worker_threads';

export class ToolSandbox {
  /**
   * Executes a dynamically generated TypeScript module inside an isolated worker thread.
   * @param toolFilePath Absolute path to the .ts tool file
   * @param inputData Data to pass into the tool
   * @param timeoutMs Hard timeout to terminate the thread (default 2000ms)
   */
  public async executeTool(toolFilePath: string, inputData: any, timeoutMs: number = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const workerCode = `
        const { parentPort, workerData } = require('worker_threads');
        (async () => {
          try {
            const mod = await import(workerData.toolFilePath);
            
            // Automatically find the first exported function
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

      // Guarantee tsx loader is active in worker thread execArgv for TS support
      const execArgv = [...process.execArgv];
      if (!execArgv.some(arg => arg.includes('tsx') || arg.includes('import'))) {
        execArgv.push('--import', 'tsx');
      }

      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { toolFilePath: `file://${toolFilePath}`, inputData },
        execArgv
      });

      const timeoutId = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Sandbox Security Timeout: Tool execution exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      worker.on('message', (msg) => {
        clearTimeout(timeoutId);
        if (msg.success) resolve(msg.result);
        else reject(new Error(`Tool Execution Error: ${msg.error}`));
      });

      worker.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });

      worker.on('exit', (code) => {
        clearTimeout(timeoutId);
        if (code !== 0) reject(new Error(`Sandbox thread crashed with exit code ${code}`));
      });
    });
  }
}
