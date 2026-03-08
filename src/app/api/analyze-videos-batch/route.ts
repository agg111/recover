import { NextRequest } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";
const longTimeoutAgent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

interface NomadicEvent {
  timestamp: string;
  summary: string;
  category: string;
  thumbnail_url?: string;
}

interface VideoResult {
  video_id: string;
  video_url: string;
  phases: NomadicEvent[];
  form_events: NomadicEvent[];
  rom_events: NomadicEvent[];
  pain_events: NomadicEvent[];
  all_events: NomadicEvent[];
}

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, payload: Record<string, unknown> | string) => {
        const data = typeof payload === "string" ? { type, message: payload } : { type, ...payload };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const formData = await req.formData();
        const videos = formData.getAll("videos") as File[];
        const userId = formData.get("userId") as string | null;
        const injuryProfileId = formData.get("injuryProfileId") as string | null;
        const injuryType = formData.get("injuryType") as string | null;
        const exerciseName = formData.get("exerciseName") as string | null;

        if (videos.length < 2) {
          send("error", "Upload at least 2 videos for batch analysis");
          controller.close();
          return;
        }

        send("progress", `Uploading ${videos.length} videos...`);

        // Upload all to Supabase in parallel
        const uploadedUrls = await Promise.all(
          videos.map(async (video) => {
            const arrayBuffer = await video.arrayBuffer();
            const fileName = `exercises/${Date.now()}-${Math.random().toString(36).slice(2)}-${video.name}`;
            const { data, error } = await supabase.storage
              .from("media")
              .upload(fileName, Buffer.from(arrayBuffer), { contentType: video.type });
            if (error) throw new Error(`Upload failed: ${error.message}`);
            return `${process.env.SUPABASE_URL}/storage/v1/object/public/media/${data.path}`;
          })
        );

        send("progress", `Running batch analysis on ${videos.length} videos — segmentation + form/ROM/compensation...`);

        const batchResponse = await undiciFetch(`${VIDEO_SERVICE_URL}/analyze-batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            video_urls: uploadedUrls,
            injury_type: injuryType,
            exercise_name: exerciseName,
          }),
          dispatcher: longTimeoutAgent,
        });

        if (!batchResponse.ok) {
          throw new Error(`Batch video service error: ${await batchResponse.text()}`);
        }

        const batchResult = await batchResponse.json() as {
          status: string;
          video_count: number;
          batch_metadata: Record<string, unknown>;
          videos: VideoResult[];
        };

        // Report per-video findings
        for (let i = 0; i < batchResult.videos.length; i++) {
          const v = batchResult.videos[i];
          const total = v.all_events.length;
          send("progress", `✓ Video ${i + 1}: ${v.phases.length} phases, ${total} issue${total !== 1 ? "s" : ""} found`);
        }

        send("progress", "Generating comparative feedback...");

        // Save sessions to Supabase
        const sessionIds: (string | null)[] = [];
        if (userId) {
          for (const v of batchResult.videos) {
            const { data: session } = await supabase
              .from("exercise_sessions")
              .insert({
                user_id: userId,
                injury_profile_id: injuryProfileId,
                video_url: v.video_url,
                exercise_name: exerciseName,
                nomadicml_video_id: v.video_id,
                analysis_status: "processing",
              })
              .select("id")
              .single();
            sessionIds.push(session?.id ?? null);
          }
        }

        const feedback = await generateBatchFeedback(batchResult.videos, injuryType, exerciseName);

        // Update sessions with results
        for (let i = 0; i < batchResult.videos.length; i++) {
          const sid = sessionIds[i];
          const vf = feedback.videos[i];
          if (sid && vf) {
            await supabase
              .from("exercise_sessions")
              .update({
                analysis_status: "completed",
                raw_events: {
                  phases: batchResult.videos[i].phases,
                  form_events: batchResult.videos[i].form_events,
                  rom_events: batchResult.videos[i].rom_events,
                  pain_events: batchResult.videos[i].pain_events,
                },
                corrections: vf.corrections,
                overall_score: vf.overall_score,
                feedback_summary: vf.summary,
              })
              .eq("id", sid);
          }
        }

        send("result", {
          feedback,
          sessionIds,
          videoUrls: uploadedUrls,
          batchMetadata: batchResult.batch_metadata,
        });
      } catch (error) {
        console.error("analyze-videos-batch error:", error);
        send("error", String(error));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function generateBatchFeedback(
  videos: VideoResult[],
  injuryType: string | null,
  exerciseName: string | null
) {
  const videoSummaries = videos.map((v, i) => {
    const phases = v.phases.map(p => `[${p.timestamp}] ${p.summary}`).join(", ") || "none detected";
    const events = v.all_events.map((e, j) =>
      `  ${j + 1}. [${e.timestamp}] (${e.category}) ${e.summary}${e.thumbnail_url ? ` (thumbnail: ${e.thumbnail_url})` : ""}`
    ).join("\n") || "  No issues detected";
    return `VIDEO ${i + 1}:\nPhases: ${phases}\nIssues:\n${events}`;
  }).join("\n\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    messages: [{
      role: "user",
      content: `You are a physical therapist reviewing ${videos.length} exercise videos from a patient recovering from ${injuryType || "an injury"} doing ${exerciseName || "rehabilitation exercises"}.

${videoSummaries}

Produce a JSON response:
{
  "comparison_summary": "2-3 sentences comparing all videos — what improved, what's consistent across videos",
  "videos": [
    {
      "overall_score": <0-100>,
      "summary": "<1-2 sentence assessment for this specific video>",
      "corrections": [
        {
          "timestamp": "<from event>",
          "category": "form" | "rom" | "pain",
          "issue": "<plain language problem>",
          "correction": "<actionable fix>",
          "priority": "high" | "medium" | "low",
          "thumbnail_url": "<copy exactly or null>"
        }
      ],
      "encouragement": "<one motivational sentence>"
    }
  ]
}

One entry in "videos" per input video, in order. Preserve thumbnail_url values exactly.`
    }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse batch feedback JSON");
  return JSON.parse(match[0]);
}
