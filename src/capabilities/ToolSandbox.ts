import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// Cache the pristine compiler instance to avoid re-evaluating the VM context
let pristineTsCompiler: any = null;

function transpileTsCode(sourceCode: string): string {
  if (!pristineTsCompiler) {
    const tsPath = path.resolve(process.cwd(), 'node_modules', 'typescript', 'lib', 'typescript.js');
    if (!fs.existsSync(tsPath)) {
      throw new Error(`Critical Sandbox Error: typescript library not found at ${tsPath}`);
    }

    // Read the raw compiler file, bypassing all module hooks and ESM/CJS interop
    const code = fs.readFileSync(tsPath, 'utf8');
    
    // Create a sterile execution environment
    const sandbox: any = {
      module: { exports: {} },
      exports: {},
      process,
      console,
      Buffer,
      setTimeout,
      clearTimeout,
      require // Allows TS to require built-in node modules like 'os'
    };
    
    // Execute TypeScript compiler source inside the isolated VM
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    
    // Extract the raw compiler object
    if (sandbox.ts && typeof sandbox.ts.transpileModule === 'function') {
      pristineTsCompiler = sandbox.ts;
    } else if (sandbox.module.exports && typeof sandbox.module.exports.transpileModule === 'function') {
      pristineTsCompiler = sandbox.module.exports;
    } else {
      throw new Error('Failed to extract transpileModule from isolated VM sandbox.');
    }
  }

  // Use raw enum values: ModuleKind.CommonJS = 1, ScriptTarget.ES2022 = 9
  const result = pristineTsCompiler.transpileModule(sourceCode, {
    compilerOptions: {
      module: 1,
      target: 9,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true
    }
  });
  
  return result.outputText;
}

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
        transpiledCode = transpileTsCode(sourceCode);
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
            
            // Handle multiple export shapes safely (default, exported const, module.exports)
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
