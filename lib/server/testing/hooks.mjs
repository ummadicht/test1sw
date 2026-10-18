/**
 * Test-only module hooks, so `node --test` can load the SERVER modules
 * (lib/server/*.ts) the way Next's bundler does: extensionless relative imports
 * ("./db" → ./db.ts), the "@/…" path alias, a JSON import without attributes
 * (seed-data.json), and two small stand-ins for next/server and next/headers
 * (the server's request context does not exist outside Next). Registered by a
 * test file itself (register.mjs), so the plain `npm test` command can run it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../", import.meta.url);
const STUBS = { "next/server": "./next-server.mjs", "next/headers": "./next-headers.mjs" };
const HAS_EXT = /\.(?:[cm]?[jt]sx?|json|node)$/;

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
  let spec = specifier;
  if (spec.startsWith("@/")) spec = new URL(spec.slice(2), ROOT).href;
  const local = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:");
  if (local && !HAS_EXT.test(spec.split(/[?#]/)[0])) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      try {
        return await next(spec + ext, context);
      } catch {
        /* try the next one */
      }
    }
  }
  return next(spec, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && url.split(/[?#]/)[0].endsWith(".json") && !context.importAttributes?.type) {
    const src = readFileSync(fileURLToPath(url.split(/[?#]/)[0]), "utf8");
    return { format: "module", source: `export default ${src};`, shortCircuit: true };
  }
  return next(url, context);
}

