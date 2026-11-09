import type { NextConfig } from "next";

// SwapUp is served at the root of its own host, so there is no basePath.
const nextConfig: NextConfig = {
  // Database driver configuration
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
