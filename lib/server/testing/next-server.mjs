/** Stand-in for next/server in tests: NextResponse.json is a plain JSON Response. */
export class NextResponse extends Response {
  static json(data, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), { ...init, headers });
  }
}
