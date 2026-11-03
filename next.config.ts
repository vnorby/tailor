import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  // Protocol SDKs are large and use Node APIs; keep them out of the bundler.
  serverExternalPackages: [
    "@kamino-finance/klend-sdk", "@kamino-finance/kliquidity-sdk", "@drift-labs/sdk",
    "@mrgnlabs/marginfi-client-v2", "@ellipsis-labs/rise", "@titanexchange/sdk-ts",
  ],
};

export default nextConfig;
