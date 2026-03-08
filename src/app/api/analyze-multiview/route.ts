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
  view_key?: string;
}

interface MultiviewResult {
  status: string;
  view_count: number;
  views: string[];
  fusion_method: string;
  phases: NomadicEvent[];
  form_events: NomadicEvent[];
  rom_events: NomadicEvent[];
  pain_events: NomadicEvent[];
  all_events: NomadicEvent[];
  per_view_events: Record<string, NomadicEvent[]>;
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
        const userId = formData.get("userId") as string | null;
        const injuryProfileId = formData.get("injuryProfileId") as string | null;
        const injuryType = formData.get("injuryType") as string | null;
        const exerciseName = formData.get("exerciseName") as string | null;

        // Collect view files: fields named "FRONT", "SIDE", "BACK", etc.
        const viewKeys = ["FRONT", "SIDE", "BACK", "LEFT", "RIGHT"];
        const views: Array<{ view_key: string; video_url: string }> = [];

        send("progress", "Uploading videos...");

        for (const key of viewKeys) {
          const file = formData.get(key) as File | null;
          if (!file) continue;

          const arrayBuffer = await file.arrayBuffer();
          const fileName = `exercises/${Date.now()}-${key.toLowerCase()}-${file.name}`;
          const { data, error } = await supabase.storage
            .from("media")
            .upload(fileName, Buffer.from(arrayBuffer), { contentType: file.type });

          if (error) throw new Error(`Upload failed for ${key}: ${error.message}`);
          const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/media/${data.path}`;
          views.push({ view_key: key, video_url: url });
          send("progress", `✓ ${key} view uploaded`);
        }

        if (views.length < 2) {
          send("error", "Upload at least 2 views (e.g. FRONT and SIDE)");
          controller.close();
          return;
        }

        send("progress", `Running multi-view analysis across ${views.length} angles — NomadicML will fuse results...`);

        const serviceRes = await undiciFetch(`${VIDEO_SERVICE_URL}/analyze-multiview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ views, injury_type: injuryType, exercise_name: exerciseName }),
          dispatcher: longTimeoutAgent,
        });

        if (!serviceRes.ok) throw new Error(`Video service: ${await serviceRes.text()}`);

        const result = await serviceRes.json() as MultiviewResult;

        const fusedLabel = result.fusion_method === "unfused" ? "per-view" : "fused";
        send("progress", `✓ Analysis complete — ${result.all_events.length} issue(s) found across ${result.views.join(" + ")} views (${fusedLabel})`);
        if (result.phases.length > 0) send("progress", `✓ ${result.phases.length} exercise phase(s) detected`);

        send("progress", "Generating multi-angle feedback...");

        const feedback = await formatMultiviewFeedback(result, injuryType, exerciseName);

        // Save session per view
        if (userId) {
          for (const v of views) {
            await supabase.from("exercise_sessions").insert({
              user_id: userId,
              injury_profile_id: injuryProfileId,
              video_url: v.video_url,
              exercise_name: exerciseName,
              analysis_status: "completed",
              raw_events: {
                phases: result.phases,
                form_events: result.form_events.filter(e => !e.view_key || e.view_key === v.view_key),
                rom_events:  result.rom_events.filter(e => !e.view_key  || e.view_key === v.view_key),
                pain_events: result.pain_events.filter(e => !e.view_key || e.view_key === v.view_key),
              },
              corrections: feedback.corrections,
              overall_score: feedback.overall_score,
              feedback_summary: feedback.summary,
            });
          }
        }

        send("result", {
          feedback,
          views: result.views,
          fusionMethod: result.fusion_method,
          phases: result.phases,
          videoUrls: views.map(v => v.video_url),
        });
      } catch (err) {
        console.error("analyze-multiview error:", err);
        send("error", String(err));
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

async function formatMultiviewFeedback(
  result: MultiviewResult,
  injuryType: string | null,
  exerciseName: string | null
) {
  const { phases, form_events, rom_events, pain_events, views, fusion_method } = result;
  const totalEvents = form_events.length + rom_events.length + pain_events.length;

  if (totalEvents === 0) {
    return {
      summary: "Excellent form from all angles! No issues detected across any view.",
      overall_score: 96,
      corrections: [],
      encouragement: "Outstanding work — keep it up!",
      multiview_insight: null,
    };
  }

  const fmt = (events: NomadicEvent[], label: string) =>
    events.length > 0
      ? `${label}:\n${events.map((e, i) =>
          `  ${i + 1}. [${e.timestamp}]${e.view_key ? ` (${e.view_key} view)` : ""} ${e.summary}${e.thumbnail_url ? ` (thumbnail: ${e.thumbnail_url})` : ""}`
        ).join("\n")}`
      : `${label}: None detected`;

  const phasesText = phases.length > 0
    ? `EXERCISE PHASES:\n${phases.map(p => `  [${p.timestamp}] ${p.summary}`).join("\n")}\n`
    : "";

  const prompt = `You are a physical therapist reviewing AI motion analysis of a patient's exercise from ${views.length} camera angles (${views.join(" + ")}).

Patient: recovering from ${injuryType || "an injury"}
Exercise: ${exerciseName || "rehabilitation exercise"}
Analysis: ${fusion_method === "unfused" ? "per-view (angles analyzed separately)" : "fused (cross-angle correlation)"}

${phasesText}
${fmt(form_events, "FORM & TECHNIQUE ISSUES")}

${fmt(rom_events, "RANGE OF MOTION ISSUES")}

${fmt(pain_events, "PAIN & COMPENSATION PATTERNS")}

Produce a JSON response with exactly these fields:
{
  "summary": "2-3 sentences. Reference which camera angle revealed the key issues. Note if the fused analysis caught something a single angle would have missed.",
  "overall_score": <integer 0-100>,
  "corrections": [
    {
      "timestamp": "<from event>",
      "category": "form" | "rom" | "pain",
      "view_key": "<which camera angle — FRONT/SIDE/etc — or null if fused>",
      "issue": "<specific problem>",
      "correction": "<actionable fix>",
      "priority": "high" | "medium" | "low",
      "thumbnail_url": "<copy exactly or null>"
    }
  ],
  "encouragement": "<one warm sentence>",
  "multiview_insight": "<one sentence on what the multi-angle analysis revealed that a single camera would have missed, or null>"
}

Map every event. Preserve thumbnail_url exactly. high = safety risk, medium = form degradation, low = refinement.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });

  let text = "";
  for (const b of response.content) if (b.type === "text") text += b.text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse multiview feedback JSON");
  return JSON.parse(match[0]);
}
