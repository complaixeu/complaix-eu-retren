import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    serverActions: {
      // The ticket upload ([A1]) takes files up to 10 MB; the rest is multipart overhead. The
      // action checks the real limit itself (features/intake/upload/rules.ts).
      bodySizeLimit: "11mb",
    },
  },
};

export default nextConfig;
