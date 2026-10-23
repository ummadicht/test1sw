/**
 * Stand-in for next/headers in tests: headers() returns whatever the test put
 * on globalThis.__swapupTestHeaders (e.g. an Authorization: Bearer token), and
 * cookies() reads the jar the test put on globalThis.__swapupTestCookies
 * (e.g. the desk's swapup_session); writes go nowhere.
 */
export async function headers() {
  return new Headers(globalThis.__swapupTestHeaders ?? {});
}
export async function cookies() {
  const jar = globalThis.__swapupTestCookies ?? {};
  return { get: (name) => (name in jar ? { name, value: jar[name] } : undefined), set: () => {}, delete: () => {} };
}
