import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    if (!process.env.BACKEND_URL) {
      return [];
    }

    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
