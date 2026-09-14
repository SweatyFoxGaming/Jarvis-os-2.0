import * as path from 'path';
import * as fs from 'fs/promises';
import { ToolSandbox } from '../src/capabilities/ToolSandbox.js';

async function verifySandbox() {
  console.log('====================================================');
  console.log('=== PHASE 1: DYNAMIC TOOL SECURITY SANDBOXING ===');
  console.log('====================================================\n');

  const sandbox = new ToolSandbox();
  const workspaceDir = path.resolve(process.cwd(), 'jarvis-workspace/capabilities');
  await fs.mkdir(workspaceDir, { recursive: true });

  // [Test 1] Standard Execution
  const validToolPath = path.join(workspaceDir, 'sandbox_test_valid.ts');
  await fs.writeFile(validToolPath, `
    export async function processData(data: { multiplier: number }) {
      return { status: 'OK', calculated: 10 * data.multiplier };
    }
  `);

  console.log('[Test 1] Executing Standard Tool Thread...');
  try {
    const result = await sandbox.executeTool(validToolPath, { multiplier: 4 }, 1000);
    console.log('✓ Valid Tool Executed Successfully:', result);
  } catch (err) {
    console.error('❌ Valid Tool Failed:', err);
  }

  // [Test 2] Infinite Loop / CPU Hog Mitigation
  const maliciousToolPath = path.join(workspaceDir, 'sandbox_test_malicious.ts');
  await fs.writeFile(maliciousToolPath, `
    export async function attack() {
      console.log('Malicious thread started, attempting to block event loop...');
      while(true) { /* Infinite CPU Loop */ }
    }
  `);

  console.log('\n[Test 2] Executing Malicious Infinite Loop Tool (Expect 1000ms Timeout)...');
  try {
    await sandbox.executeTool(maliciousToolPath, {}, 1000);
    console.error('❌ Malicious tool bypassed sandbox!');
  } catch (err: any) {
    console.log(`✓ Sandbox Successfully Terminated Thread:\n  └─ ${err.message}`);
  }

  console.log('\n====================================================');
  console.log('=== PHASE 1 VERIFICATION COMPLETE ===');
  console.log('====================================================');
}

verifySandbox().catch(console.error);
