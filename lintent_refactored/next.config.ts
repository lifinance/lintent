import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  experimental: {
    // Required for Emotion / MUI SSR
    optimizePackageImports: ["@mui/material", "@mui/icons-material"],
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@lifi/intent-refactored/svm": path.resolve(
        __dirname,
        "../intent.ts_refactored/src/svm/index.ts",
      ),
      "@lifi/intent-refactored/evm": path.resolve(
        __dirname,
        "../intent.ts_refactored/src/evm/index.ts",
      ),
      "@lifi/intent-refactored/shared": path.resolve(
        __dirname,
        "../intent.ts_refactored/src/shared/index.ts",
      ),
    };
    config.resolve.modules = [
      "node_modules",
      path.resolve(__dirname, "node_modules"),
    ];
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "pino-pretty": false,
    };
    return config;
  },
};

export default nextConfig;
