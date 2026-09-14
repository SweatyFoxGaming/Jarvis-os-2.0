import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import * as tsModule from 'typescript';

function resolveTsCompiler(): any {
  // Helper to safely obtain a working CJS require function
  const getRequire = (): NodeRequire => {
    if (typeof require === 'function') {
      return require;
    }
    return createRequire(path.resolve(process.cwd(), 'package.json'));
  };

  // 1. Direct native CJS module load (bypasses tsx ESM synthetic wrapper)
  try {
    const req = getRequire();
    const loaded = req('typescript');
    if (loaded && typeof loaded.transpileModule === 'function') return loaded;
    if (loaded?.default && typeof loaded.default.transpileModule === 'function') return loaded.default;
  } catch {
    // Fall through to secondary attempts
  }

  // 2. Direct absolute path resolution to node_modules
  try {
    const req = getRequire();
    const libPath = path.resolve(process.cwd(), 'node_modules', 'typescript', 'lib', 'typescript.js');
    if (fs.existsSync(libPath)) {
      const loadedLib = req(libPath);
      if (loadedLib && typeof loadedLib.transpileModule === 'function') return loadedLib;
      if (loadedLib?.default && typeof loadedLib.default.transpileModule === 'function') return loadedLib.default;
    }
  } catch {
    // Fall through
  }

  // 3. Fallback to tsModule inspection
  if (typeof (tsModule as any)?.transpileModule === 'function') return tsModule;
  if (typeof (tsModule as any)?.default?.transpileModule === 'function') return (tsModule as any).default;

  return tsModule;
}

const ts = resolveTsCompiler();

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

      const activeTs = typeof ts?.transpileModule === 'function' ? ts : resolveTsCompiler();

      if (!activeTs || typeof activeTs.transpileModule !== 'function') {
        const availableKeys = activeTs ? Object.keys(activeTs).join(', ') : 'null';
        return reject(
          new Error(
            `TypeScript Compiler Error: transpileModule not found. Available keys: ${availableKeys}`
          )
        );
      }

      let transpiledCode: string;
      try {
        const sourceCode = fs.readFileSync(absFilePath, 'utf8');
        const result = activeTs.transpileModule(sourceCode, {
          compilerOptions: {
            module: activeTs.ModuleKind?.CommonJS ?? 1,
            target: activeTs.ScriptTarget?.ES2022 ?? 9,
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
