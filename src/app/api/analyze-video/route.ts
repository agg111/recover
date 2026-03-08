import { NextRequest } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";
// Custom undici agent with long timeouts — Next.js native fetch defaults to 30s headers timeout
const longTimeoutAgent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

interface NomadicEvent {
  timestamp: string;
  summary: string;
  category: string;
  confidence?: string;
  thumbnail_url?: string;
}

interface NomadicResult {
  video_id: string;
  status: string;
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
        const data =
          typeof payload === "string"
            ? { type, message: payload }
            : { type, ...payload };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const formData = await req.formData();
        const video = formData.get("video") as File | null;
        const videoUrl = formData.get("videoUrl") as string | null;
        const userId = formData.get("userId") as string | null;
        const injuryProfileId = formData.get("injuryProfileId") as string | null;
        const injuryType = formData.get("injuryType") as string | null;
        const exerciseName = formData.get("exerciseName") as string | null;

        if (!video && !videoUrl) {
          send("error", "No video provided");
          controller.close();
          return;
        }

        let uploadedVideoUrl: string | null = videoUrl;

        // Step 1 — upload to Supabase Storage
        if (video) {
          send("progress", "Uploading your exercise video...");
          const arrayBuffer = await video.arrayBuffer();
          const fileName = `exercises/${Date.now()}-${video.name}`;
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from("media")
            .upload(fileName, Buffer.from(arrayBuffer), { contentType: video.type });

          if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);
          uploadedVideoUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/media/${uploadData.path}`;
        }

        // Create exercise session record
        let sessionId: string | null = null;
        if (userId) {
          const { data: session } = await supabase
            .from("exercise_sessions")
            .insert({
              user_id: userId,
              injury_profile_id: injuryProfileId,
              video_url: uploadedVideoUrl,
              exercise_name: exerciseName,
              analysis_status: "processing",
            })
            .select("id")
            .single();
          sessionId = session?.id ?? null;
        }

        // Step 2 — NomadicML 4-pass analysis
        send("progress", "Starting 4-pass AI motion analysis — form, range of motion, compensation patterns, and exercise phases...");

        // Use undici directly to avoid Next.js native fetch's 30s headers timeout
        const videoServiceResponse = await undiciFetch(`${VIDEO_SERVICE_URL}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            video_url: uploadedVideoUrl,
            injury_type: injuryType,
            exercise_name: exerciseName,
            session_id: sessionId,
          }),
          dispatcher: longTimeoutAgent,
        });

        if (!videoServiceResponse.ok) {
          throw new Error(`Video service error: ${await videoServiceResponse.text()}`);
        }

        const nomadicResult = await videoServiceResponse.json() as NomadicResult;

        // Step 3 — report what each pass found
        if (nomadicResult.phases.length > 0) {
          const phaseCount = nomadicResult.phases.length;
          const phaseNames = nomadicResult.phases.map(p => p.summary).filter(Boolean);
          const phaseDesc = phaseNames.length > 0
            ? ` (${phaseNames.join(" → ")})`
            : "";
          send("progress", `✓ Exercise phase detection — ${phaseCount} phase${phaseCount !== 1 ? "s" : ""} identified${phaseDesc}`);
        }

        send("progress",
          nomadicResult.form_events.length > 0
            ? `✓ Form & technique — ${nomadicResult.form_events.length} issue${nomadicResult.form_events.length !== 1 ? "s" : ""} detected`
            : "✓ Form & technique — looks good"
        );
        send("progress",
          nomadicResult.rom_events.length > 0
            ? `✓ Range of motion — ${nomadicResult.rom_events.length} concern${nomadicResult.rom_events.length !== 1 ? "s" : ""} flagged`
            : "✓ Range of motion — within expected range"
        );
        send("progress",
          nomadicResult.pain_events.length > 0
            ? `✓ Compensation patterns — ${nomadicResult.pain_events.length} pattern${nomadicResult.pain_events.length !== 1 ? "s" : ""} found`
            : "✓ Compensation patterns — none detected"
        );

        // Step 4 — Claude formats the feedback
        send("progress", "Generating your personalized feedback...");

        const feedback = await formatFeedbackWithClaude(nomadicResult, injuryType, exerciseName);

        // Persist to Supabase
        if (sessionId) {
          await supabase
            .from("exercise_sessions")
            .update({
              nomadicml_video_id: nomadicResult.video_id,
              analysis_status: "completed",
              raw_events: {
                phases: nomadicResult.phases,
                form_events: nomadicResult.form_events,
                rom_events: nomadicResult.rom_events,
                pain_events: nomadicResult.pain_events,
              },
              corrections: feedback.corrections,
              overall_score: feedback.overall_score,
              feedback_summary: feedback.summary,
            })
            .eq("id", sessionId);
        }

        send("result", { feedback, sessionId, videoUrl: uploadedVideoUrl, phases: nomadicResult.phases });
      } catch (error) {
        console.error("analyze-video error:", error);
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

async function formatFeedbackWithClaude(
  result: NomadicResult,
  injuryType: string | null,
  exerciseName: string | null
) {
  const { phases, form_events, rom_events, pain_events } = result;
  const totalEvents = form_events.length + rom_events.length + pain_events.length;

  if (totalEvents === 0 && phases.length === 0) {
    return {
      summary: "Excellent form! No significant issues detected across all analysis passes.",
      overall_score: 95,
      corrections: [],
      encouragement: "Keep up the outstanding work!",
      phase_notes: null,
    };
  }

  const fmt = (events: NomadicEvent[], label: string) =>
    events.length > 0
      ? `${label}:\n${events.map((e, i) => `  ${i + 1}. [${e.timestamp}] ${e.summary}${e.thumbnail_url ? ` (thumbnail: ${e.thumbnail_url})` : ""}`).join("\n")}`
      : `${label}: None detected`;

  const phasesText =
    phases.length > 0
      ? `EXERCISE PHASES:\n${phases.map((p) => `  [${p.timestamp}] ${p.summary}`).join("\n")}\n`
      : "";

  const prompt = `You are a physical therapist reviewing AI motion analysis of a patient's exercise video.

Patient: recovering from ${injuryType || "an injury"}
Exercise: ${exerciseName || "rehabilitation exercise"}

${phasesText}
${fmt(form_events, "FORM & TECHNIQUE ISSUES")}

${fmt(rom_events, "RANGE OF MOTION ISSUES")}

${fmt(pain_events, "PAIN & COMPENSATION PATTERNS")}

Produce a JSON response with exactly these fields:
{
  "summary": "2-3 sentence overall assessment. If phases were detected, reference them (e.g. 'Your setup phase looks solid, but during the working reps...'). Be specific and encouraging.",
  "overall_score": <integer 0-100>,
  "corrections": [
    {
      "timestamp": "<timestamp from the event>",
      "category": "form" | "rom" | "pain",
      "issue": "<specific problem in plain language>",
      "correction": "<actionable fix the patient can apply immediately>",
      "priority": "high" | "medium" | "low",
      "thumbnail_url": "<copy the thumbnail_url from the event exactly, or null>"
    }
  ],
  "encouragement": "<one warm, motivational sentence>",
  "phase_notes": "<if phases detected: brief note on phase structure, else null>"
}

Rules: map every event to a correction, preserve thumbnail_url values exactly, high = safety risk, medium = form degradation, low = minor refinement. Keep language accessible, not clinical.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });

  let responseText = "";
  for (const block of response.content) {
    if (block.type === "text") responseText += block.text;
  }

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse feedback JSON from Claude");

  return JSON.parse(jsonMatch[0]);
}
