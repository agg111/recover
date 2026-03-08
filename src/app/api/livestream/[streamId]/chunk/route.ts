import { NextRequest, NextResponse } from "next/server";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ streamId: string }> }
) {
  const { streamId } = await params;
  const chunk = await req.arrayBuffer();
  const res = await fetch(`${VIDEO_SERVICE_URL}/livestream/${streamId}/chunk`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: chunk,
  });
  if (!res.ok) {
    return NextResponse.json({ error: "chunk failed" }, { status: res.status });
  }
  return NextResponse.json(await res.json());
}
