import type { NextConfig } from "next";

// SwapUp is served at the root of its own host, so there is no basePath.
const nextConfig: NextConfig = {
  // Database driver configuration
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/app/check", destination: "/app/check/index.html" },
      { source: "/app/check/", destination: "/app/check/index.html" },
      { source: "/app/store", destination: "/app/store/index.html" },
      { source: "/app/store/", destination: "/app/store/index.html" },
    ];
  },
};

export default nextConfig;

