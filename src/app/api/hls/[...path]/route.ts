import { NextRequest, NextResponse } from "next/server";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const filePath = path.join("/");
  const res = await fetch(`${VIDEO_SERVICE_URL}/stream/${filePath}`, {
    headers: { "Cache-Control": "no-cache" },
  });

  if (!res.ok) {
    return new NextResponse("Not found", { status: 404 });
  }

  const contentType = filePath.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : "video/mp2t";

  const body = await res.arrayBuffer();
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
