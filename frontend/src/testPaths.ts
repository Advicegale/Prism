/** Path-only, so every indexed language is classified the same way. Misses (inline
 * `#[cfg(test)]` modules, helpers outside test folders) simply read as normal files. */
const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', '__mocks__', 'spec', 'specs', 'e2e', 'testdata', 'fixtures', 'itest', 'itests'])
export function isTestPath(path: string) {
  const parts = path.split('/'), file = parts.pop() || ''
  if (parts.some(part => TEST_DIRECTORIES.has(part.toLowerCase()))) return true
  if (/\.(test|spec|e2e)\.[^.]+$/i.test(file)) return true                              // foo.test.ts, foo.spec.tsx
  if (/^(test[_-]|conftest\.)/i.test(file) || /^Test[A-Z0-9_]/.test(file)) return true  // test_foo.py, conftest.py, TestFoo.java
  const stem = file.replace(/\.[^.]*$/, '')
  return /_(test|tests|spec|unittest)$/i.test(stem) || /[a-z0-9](Test|Tests|Spec|IT)$/.test(stem)  // foo_test.go, FooTest.java, FooTests.cs, FooIT.java
}

/** Stable partition: non-test items first, test items after, each keeping its order. */
export function testsLast<T extends {path: string}>(items: readonly T[]): T[] {
  return [...items.filter(i => !isTestPath(i.path)), ...items.filter(i => isTestPath(i.path))]
}
