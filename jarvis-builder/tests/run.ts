/**
 * Minimal hand-rolled test runner for jarvis-builder, mirroring the main
 * repo's tests/index.test.ts style (registerTest + a single pass at the
 * end) rather than pulling in a new test-framework dependency for a package
 * this small and dependency-light on purpose (see package.json's own
 * description of why: smaller code surface = smaller blast radius for the
 * one service in this stack with Docker-socket access).
 *
 * registerTest/getTests live in their own registry.ts module rather than
 * here: ES module import statements are hoisted above a file's own
 * top-level code, so a same-file `import "./workspace.test.js"` sitting
 * below `const tests = []` would still run before that declaration
 * executes (a real TDZ crash hit while writing this) — putting the shared
 * array in a separate module sidesteps that entirely.
 */
import { getTests } from "./registry.js";

// Registration files import registerTest as a side effect of being imported
// below — importing them here (rather than each test file self-registering
// against a shared singleton some other way) keeps this the one place that
// knows the full list of test files.
import "./workspace.test.js";
import "./server-auth.test.js";

async function runAll(): Promise<void> {
  let passedCount = 0;
  const results: { category: string; name: string; passed: boolean; error?: string }[] = [];

  for (const t of getTests()) {
    try {
      await t.fn();
      results.push({ category: t.category, name: t.name, passed: true });
      passedCount++;
    } catch (err: any) {
      results.push({ category: t.category, name: t.name, passed: false, error: err.message || String(err) });
    }
  }

  console.log("\n=====================================================");
  results.forEach(r => {
    if (r.passed) {
      console.log(`✅ [PASSED] [Category: ${r.category}] - ${r.name}`);
    } else {
      console.log(`❌ [FAILED] [Category: ${r.category}] - ${r.name}`);
      console.log(`    Error: ${r.error}`);
    }
  });
  console.log("=====================================================");
  console.log(`TOTALS: ${passedCount} / ${results.length} Tests Passed.`);
  console.log("=====================================================");

  if (passedCount < results.length) process.exit(1);
}

runAll().catch(err => {
  console.error("Fatal test suite error:", err);
  process.exit(1);
});
