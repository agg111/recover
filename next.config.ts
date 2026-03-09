import type { NextConfig } from "next";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // HLS playlist + segments served at root so NomadicML URL is simply:
      // https://<ngrok>/stream.m3u8  and  https://<ngrok>/stream*.ts
      {
        source: "/stream:slug*",
        destination: `${VIDEO_SERVICE_URL}/stream/stream:slug*`,
      },
      // Legacy per-stream paths (fallback)
      {
        source: "/hls/:path*",
        destination: `${VIDEO_SERVICE_URL}/hls/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
        ],
      },
    ];
  },
};

export default nextConfig;
