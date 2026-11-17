import type { NextConfig } from "next";

// SwapUp is served at the root of its own host, so there is no basePath.
const nextConfig: NextConfig = {
  // Database driver configuration
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  allowedDevOrigins: [
    "*.run.app",
    "ais-dev-egeiwczs7kiexah24wg34c-992872337627.asia-east1.run.app",
    "ais-pre-egeiwczs7kiexah24wg34c-992872337627.asia-east1.run.app",
  ],
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

