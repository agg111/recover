import { NextRequest } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";
const longTimeoutAgent = new Agent({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ streamId: string }> }
) {
  const { streamId } = await params;
  const upstream = await undiciFetch(
    `${VIDEO_SERVICE_URL}/livestream/${streamId}/events`,
    { dispatcher: longTimeoutAgent }
  );

  if (!upstream.ok) {
    return new Response("Stream not found", { status: 404 });
  }

  return new Response(upstream.body as unknown as ReadableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
