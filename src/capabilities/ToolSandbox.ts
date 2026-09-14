import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as tsModule from 'typescript';
import tsDefault from 'typescript';

function unwrapCompiler(candidate: any): any {
  let curr = candidate;
  const visited = new Set();
  while (curr && (typeof curr === 'object' || typeof curr === 'function') && !visited.has(curr)) {
    visited.add(curr);
    if (typeof curr.transpileModule === 'function') {
      return curr;
    }
    if (curr.default) {
      curr = curr.default;
    } else {
      break;
    }
  }
  return null;
}

function resolveTsCompiler(): any {
  // 1. Try unwrapping direct ESM imports
  const directCandidates = [tsModule, tsDefault];
  for (const cand of directCandidates) {
    const unwrapped = unwrapCompiler(cand);
    if (unwrapped) return unwrapped;
  }

  // 2. Try property search on ESM imports
  for (const cand of directCandidates) {
    if (cand && typeof cand === 'object') {
      for (const key of Object.keys(cand)) {
        try {
          const unwrapped = unwrapCompiler(cand[key]);
          if (unwrapped) return unwrapped;
        } catch {
          // ignore
        }
      }
    }
  }

  // 3. Fallback to createRequire resolution with file URL / path fallbacks
  const requirePaths: string[] = [];
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      requirePaths.push(fileURLToPath(import.meta.url));
    }
  } catch {
    // ignore
  }
  requirePaths.push(path.resolve(process.cwd(), 'package.json'));

  for (const reqPath of requirePaths) {
    try {
      const req = createRequire(reqPath);
      const cjsTs = req('typescript');
      const unwrapped = unwrapCompiler(cjsTs);
      if (unwrapped) return unwrapped;
    } catch {
      // ignore
    }
  }

  return tsModule?.default || tsModule || tsDefault;
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
