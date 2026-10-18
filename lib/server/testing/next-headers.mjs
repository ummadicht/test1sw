/**
 * Stand-in for next/headers in tests: headers() returns whatever the test put
 * on globalThis.__swapupTestHeaders (e.g. an Authorization: Bearer token), and
 * there is no cookie jar.
 */
export async function headers() {
  return new Headers(globalThis.__swapupTestHeaders ?? {});
}
export async function cookies() {
  return { get: () => undefined, set: () => {}, delete: () => {} };
}
