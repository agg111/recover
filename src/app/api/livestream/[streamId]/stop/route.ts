import { NextRequest, NextResponse } from "next/server";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ streamId: string }> }
) {
  const { streamId } = await params;
  const res = await fetch(`${VIDEO_SERVICE_URL}/livestream/${streamId}/stop`, {
    method: "POST",
  });
  if (!res.ok) {
    return NextResponse.json({ error: "stop failed" }, { status: res.status });
  }
  return NextResponse.json(await res.json());
}
