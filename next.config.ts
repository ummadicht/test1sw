import type { NextConfig } from "next";

// SwapUp is served at the root of its own host, so there is no basePath —
// which removes the whole class of fetch()/<a href> prefix bugs the estate's
// sub-path apps keep hitting.
const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — keep it out of the server bundler.
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
};

export default nextConfig;
