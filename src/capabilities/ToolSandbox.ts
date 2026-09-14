import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import * as tsModule from 'typescript';

function unwrapTs(candidate: any): any {
  let current = candidate;
  let depth = 0;
  while (current && depth < 10) {
    if (typeof current.transpileModule === 'function') {
      return current;
    }
    if (current.default) {
      current = current.default;
      depth++;
    } else {
      break;
    }
  }
  return null;
}

function findCompiler(root: any): any {
  if (!root) return null;

  // 1. Unroll default wrappers recursively
  const unwrapped = unwrapTs(root);
  if (unwrapped) return unwrapped;

  // 2. Scan top-level keys if wrapped in a secondary namespace
  if (typeof root === 'object' || typeof root === 'function') {
    for (const key of Object.keys(root)) {
      try {
        const found = unwrapTs((root as Record<string, any>)[key]);
        if (found) return found;
      } catch {
        // ignore getter errors
      }
    }
  }
  return null;
}

function resolveTsCompiler(): any {
  // 1. Try static ESM import namespace
  const fromImport = findCompiler(tsModule);
  if (fromImport) return fromImport;

  // 2. Try native require
  try {
    if (typeof require === 'function') {
      const fromReq = findCompiler(require('typescript'));
      if (fromReq) return fromReq;
    }
  } catch {}

  // 3. Try createRequire from working directory
  try {
    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
    const fromCreateReq = findCompiler(req('typescript'));
    if (fromCreateReq) return fromCreateReq;
  } catch {}

  // 4. Direct load from node_modules lib
  try {
    const req = typeof require === 'function' ? require : createRequire(path.resolve(process.cwd(), 'package.json'));
    const libPath = path.resolve(process.cwd(), 'node_modules', 'typescript', 'lib', 'typescript.js');
    if (fs.existsSync(libPath)) {
      const fromLib = findCompiler(req(libPath));
      if (fromLib) return fromLib;
    }
  } catch {}

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
