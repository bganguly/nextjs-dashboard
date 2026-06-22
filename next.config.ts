import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev proxy so the frontend dev server reaches the backend until both are
  // merged into one app. The frontend now calls the backend's real route names
  // directly (/api/stream, /api/orders, /api/aggregates), so a single
  // pass-through rewrite is all that's needed.
  async rewrites() {
    const b = process.env.BACKEND_URL ?? "http://localhost:3004";
    return [{ source: "/api/:path*", destination: `${b}/api/:path*` }];
  },
};

export default nextConfig;
