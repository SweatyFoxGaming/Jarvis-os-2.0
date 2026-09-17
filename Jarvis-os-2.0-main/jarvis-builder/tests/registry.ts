interface TestDef {
  category: string;
  name: string;
  fn: () => void | Promise<void>;
}

const tests: TestDef[] = [];

export function registerTest(category: string, name: string, fn: () => void | Promise<void>): void {
  tests.push({ category, name, fn });
}

export function getTests(): TestDef[] {
  return tests;
}
