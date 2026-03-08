import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { fetch as undiciFetch, Agent } from "undici";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { Resend } from "resend";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";
const longTimeoutAgent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });
const resend = new Resend(process.env.RESEND_API_KEY!);

const SYSTEM_PROMPT = `You are Recover, an AI physical therapist. You help patients recover from injuries through personalized exercise guidance and real-time form analysis.

CAPABILITIES — use these tools naturally, never ask permission:
- When you see an injury photo: analyze it yourself (you can see images), then call save_injury_profile to persist it
- When the user shares ONE exercise video URL: call analyze_exercise_video — NomadicML single-angle analysis
- When the user shares TWO OR MORE video URLs from different angles (front + side, etc.): call analyze_exercise_multiview — NomadicML fuses results across angles for much richer feedback. Ask the user which angle each video is if not clear.
- When the user asks for reminders or to email their plan: call send_reminder
- When the user asks how they're doing over time: call get_progress_summary
- Live Analysis sessions are handled client-side; when the user mentions going live, encourage them to use the 📎 menu

RESPONSE STYLE for each situation:
- After injury photo: 2 sentences on the injury, 2 exercises (name + reps only), say you'll email the full plan, ask them to record or go live
- After video analysis: warm summary of the top corrections, score, encouragement
- General chat: concise, warm, non-clinical

Always keep context from prior messages. Never repeat the injury summary unless asked.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "save_injury_profile",
    description: "Persist the injury analysis after examining a patient's photo. Call this immediately after assessing an injury image.",
    input_schema: {
      type: "object" as const,
      properties: {
        injury_type: { type: "string" },
        severity: { type: "string" },
        affected_area: { type: "string" },
        dos: { type: "array", items: { type: "string" } },
        donts: { type: "array", items: { type: "string" } },
        exercises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              reps: { type: "string" },
            },
            required: ["name", "description", "reps"],
          },
        },
        when_to_see_doctor: { type: "string" },
        recovery_timeline: { type: "string" },
      },
      required: ["injury_type", "severity", "affected_area", "dos", "donts", "exercises", "when_to_see_doctor", "recovery_timeline"],
    },
  },
  {
    name: "analyze_exercise_video",
    description: "Run AI motion analysis on an exercise video using NomadicML. Returns form corrections, scores, and annotated thumbnails. Call this whenever the user shares a video URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        video_url: { type: "string", description: "Public URL of the exercise video" },
        exercise_name: { type: "string" },
        injury_type: { type: "string" },
      },
      required: ["video_url"],
    },
  },
  {
    name: "send_reminder",
    description: "Send the patient's exercise plan or a follow-up email.",
    input_schema: {
      type: "object" as const,
      properties: {
        reminder_type: { type: "string", enum: ["exercise", "followup"] },
        personal_note: { type: "string", description: "Short personal note to include" },
      },
      required: ["reminder_type"],
    },
  },
  {
    name: "get_progress_summary",
    description: "Fetch the patient's historical exercise sessions and generate a progress comparison. Call when asked about improvement over time.",
    input_schema: {
      type: "object" as const,
      properties: {
        exercise_name: { type: "string" },
      },
    },
  },
  {
    name: "analyze_exercise_multiview",
    description: "Run multi-angle AI motion analysis using NomadicML's multiview fusion. Use when the user provides 2+ video URLs from different camera angles (e.g. front and side). Fuses results across angles for richer form feedback than a single camera.",
    input_schema: {
      type: "object" as const,
      properties: {
        views: {
          type: "array",
          description: "Each video with its camera angle label",
          items: {
            type: "object",
            properties: {
              view_key: { type: "string", description: "Camera angle: FRONT, SIDE, BACK, LEFT, or RIGHT" },
              video_url: { type: "string" },
            },
            required: ["view_key", "video_url"],
          },
        },
        exercise_name: { type: "string" },
        injury_type: { type: "string" },
      },
      required: ["views"],
    },
  },
];

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
        const body = await req.json();
        const { messages, userId, injuryContext } = body as {
          messages: Array<{ role: "user" | "assistant"; content: string | Anthropic.ContentBlockParam[] }>;
          userId?: string;
          injuryContext?: Record<string, unknown> | null;
        };

        // Manual agentic loop — gives us SSE control during long tool calls
        let loopMessages = [...messages];
        let injuryState = injuryContext ?? null;

        while (true) {
          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages: loopMessages,
          });

          // Stream any text Claude produced
          for (const block of response.content) {
            if (block.type === "text" && block.text) {
              send("text", { text: block.text });
            }
          }

          if (response.stop_reason === "end_turn") break;

          // Execute all tool calls
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const input = block.input as Record<string, unknown>;

            send("tool_start", { tool: block.name });

            let result: string;
            try {
              result = await executeTool(block.name, input, { send, userId, injuryState, setInjuryState: (s) => { injuryState = s; } });
            } catch (e) {
              result = `Tool error: ${String(e)}`;
            }

            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }

          loopMessages = [
            ...loopMessages,
            { role: "assistant", content: response.content },
            { role: "user", content: toolResults },
          ];
        }

        send("done", { injuryContext: injuryState });
      } catch (err) {
        console.error("agent error:", err);
        send("error", { message: String(err) });
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

// ── Tool executor ─────────────────────────────────────────────────────────────

type SendFn = (type: string, payload: Record<string, unknown> | string) => void;

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { send: SendFn; userId?: string; injuryState: Record<string, unknown> | null; setInjuryState: (s: Record<string, unknown>) => void }
): Promise<string> {
  const { send, userId, injuryState, setInjuryState } = ctx;

  if (name === "save_injury_profile") {
    const { data } = await supabase
      .from("injury_profiles")
      .insert({ user_id: userId ?? null, ...input })
      .select("id")
      .single();

    const profile = { ...input, profileId: data?.id ?? null, success: true, imageUrl: null };
    setInjuryState(profile);
    send("injury_card", { card: profile });
    return JSON.stringify({ profileId: data?.id ?? null, saved: true });
  }

  if (name === "analyze_exercise_video") {
    const { video_url, exercise_name, injury_type } = input as {
      video_url: string; exercise_name?: string; injury_type?: string;
    };

    send("progress", "Starting 4-pass AI motion analysis — form, range of motion, compensation patterns, and exercise phases...");

    // Call Python video service
    const serviceRes = await undiciFetch(`${VIDEO_SERVICE_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_url,
        injury_type: injury_type ?? injuryState?.injury_type,
        exercise_name: exercise_name ?? injuryState?.exercises?.[0]?.name,
      }),
      dispatcher: longTimeoutAgent,
    });

    if (!serviceRes.ok) throw new Error(`Video service: ${await serviceRes.text()}`);

    const nomadicResult = await serviceRes.json() as {
      phases: Array<{ timestamp: string; summary: string }>;
      form_events: Array<{ timestamp: string; summary: string; thumbnail_url?: string }>;
      rom_events: Array<{ timestamp: string; summary: string; thumbnail_url?: string }>;
      pain_events: Array<{ timestamp: string; summary: string; thumbnail_url?: string }>;
    };

    send("progress", `✓ Phase detection — ${nomadicResult.phases.length} phase(s) found`);
    send("progress", nomadicResult.form_events.length > 0
      ? `✓ Form — ${nomadicResult.form_events.length} issue(s) detected`
      : "✓ Form — looks good");
    send("progress", nomadicResult.rom_events.length > 0
      ? `✓ Range of motion — ${nomadicResult.rom_events.length} concern(s)`
      : "✓ Range of motion — within expected range");

    send("progress", "Generating personalised feedback...");

    // Format with Claude
    const feedback = await formatVideoFeedback(nomadicResult, String(injury_type ?? injuryState?.injury_type ?? ""), String(exercise_name ?? ""));

    // Save session
    if (userId) {
      const { data: session } = await supabase
        .from("exercise_sessions")
        .insert({
          user_id: userId,
          injury_profile_id: injuryState?.profileId,
          video_url,
          exercise_name: exercise_name ?? injuryState?.exercises?.[0]?.name,
          analysis_status: "completed",
          nomadicml_video_id: (nomadicResult as { video_id?: string }).video_id,
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
        .select("id")
        .single();
      send("video_card", { card: { ...feedback, sessionId: session?.id, phases: nomadicResult.phases } });
    } else {
      send("video_card", { card: { ...feedback, phases: nomadicResult.phases } });
    }

    return JSON.stringify({ overall_score: feedback.overall_score, summary: feedback.summary, correction_count: feedback.corrections.length });
  }

  if (name === "send_reminder") {
    if (!injuryState) return "No injury profile yet.";
    const exercises = (injuryState.exercises as Array<{ name: string; description: string; reps: string }>) ?? [];
    const note = String(input.personal_note ?? "Here's your exercise plan for today.");
    const type = String(input.reminder_type);
    const exerciseHtml = exercises.map(e => `<li><strong>${e.name}</strong> — ${e.reps}<br/><span style="color:#6b7280">${e.description}</span></li>`).join("");
    const emailResult = await resend.emails.send({
      from: "Recover <onboarding@resend.dev>",
      to: "aishwaryagune@gmail.com",
      subject: type === "exercise" ? "Your recovery exercises 💪" : "Recovery check-in",
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px"><h2 style="color:#6366f1">Recover</h2><p>${note}</p><h3>${injuryState.injury_type} — exercises:</h3><ul>${exerciseHtml}</ul><p style="color:#6b7280;font-size:13px">Reply with any questions.</p></div>`,
    });
    console.log("[Resend] send result:", JSON.stringify(emailResult));
    if ((emailResult as { error?: unknown }).error) {
      throw new Error(`Resend error: ${JSON.stringify((emailResult as { error: unknown }).error)}`);
    }
    if (userId) {
      await supabase.from("reminders").insert({
        user_id: userId, injury_profile_id: injuryState.profileId,
        email: "aishwaryagune@gmail.com", reminder_type: type, sent_at: new Date().toISOString(),
      });
    }
    return "Email sent to aishwaryagune@gmail.com.";
  }

  if (name === "analyze_exercise_multiview") {
    const { views, exercise_name, injury_type } = input as {
      views: Array<{ view_key: string; video_url: string }>;
      exercise_name?: string;
      injury_type?: string;
    };

    send("progress", `Starting multi-view analysis across ${views.map(v => v.view_key).join(" + ")} — NomadicML will fuse results...`);

    const serviceRes = await undiciFetch(`${VIDEO_SERVICE_URL}/analyze-multiview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        views,
        injury_type: injury_type ?? injuryState?.injury_type,
        exercise_name: exercise_name ?? injuryState?.exercises?.[0]?.name,
      }),
      dispatcher: longTimeoutAgent,
    });

    if (!serviceRes.ok) throw new Error(`Multiview service: ${await serviceRes.text()}`);

    const result = await serviceRes.json() as {
      views: string[];
      fusion_method: string;
      phases: Array<{ timestamp: string; summary: string }>;
      form_events: unknown[]; rom_events: unknown[]; pain_events: unknown[];
      all_events: unknown[];
    };

    const fusedLabel = result.fusion_method === "unfused" ? "per-view" : "fused";
    send("progress", `✓ ${result.all_events.length} issue(s) found across ${result.views.join(" + ")} (${fusedLabel})`);
    if (result.phases.length > 0) send("progress", `✓ ${result.phases.length} phase(s) detected`);
    send("progress", "Generating multi-angle feedback...");

    // Reuse the same Claude formatter (embedded here inline)
    const fmt = (events: unknown[], label: string) => {
      const evs = events as Array<{ timestamp: string; summary: string; view_key?: string; thumbnail_url?: string }>;
      return evs.length > 0
        ? `${label}:\n${evs.map((e, i) => `  ${i + 1}. [${e.timestamp}]${e.view_key ? ` (${e.view_key})` : ""} ${e.summary}${e.thumbnail_url ? ` (thumbnail: ${e.thumbnail_url})` : ""}`).join("\n")}`
        : `${label}: None`;
    };

    const phasesText = result.phases.length > 0
      ? `PHASES:\n${result.phases.map(p => `  [${p.timestamp}] ${p.summary}`).join("\n")}\n`
      : "";

    const feedbackRes = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      messages: [{
        role: "user",
        content: `Physical therapist reviewing multi-angle exercise analysis (${result.views.join(" + ")} cameras, ${fusedLabel}) for ${exercise_name || "rehab exercise"}, recovering from ${injury_type || "injury"}.\n\n${phasesText}${fmt(result.form_events, "FORM")}\n${fmt(result.rom_events, "RANGE OF MOTION")}\n${fmt(result.pain_events, "COMPENSATION")}\n\nReturn JSON: {"summary":"2-3 sentences referencing which angle caught what","overall_score":0-100,"corrections":[{"timestamp":"","category":"form"|"rom"|"pain","view_key":"angle or null","issue":"","correction":"","priority":"high"|"medium"|"low","thumbnail_url":"copy or null"}],"encouragement":"one sentence","multiview_insight":"what multi-angle caught that single cam would miss or null"}`,
      }],
    });

    let feedbackText = "";
    for (const b of feedbackRes.content) if (b.type === "text") feedbackText += b.text;
    const match = feedbackText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Could not parse multiview feedback");
    const feedback = JSON.parse(match[0]);

    if (userId) {
      await supabase.from("exercise_sessions").insert(
        views.map(v => ({
          user_id: userId,
          injury_profile_id: injuryState?.profileId,
          video_url: v.video_url,
          exercise_name: exercise_name ?? injuryState?.exercises?.[0]?.name,
          analysis_status: "completed",
          corrections: feedback.corrections,
          overall_score: feedback.overall_score,
          feedback_summary: feedback.summary,
        }))
      );
    }

    send("video_card", {
      card: {
        ...feedback,
        phases: result.phases,
        views: result.views,
        fusionMethod: result.fusion_method,
        isMultiview: true,
      },
    });

    return JSON.stringify({ overall_score: feedback.overall_score, views: result.views, fusion_method: result.fusion_method });
  }

  if (name === "get_progress_summary") {
    const exerciseName = String(input.exercise_name ?? injuryState?.exercises?.[0]?.name ?? "");
    const params = new URLSearchParams({ userId: userId ?? "" });
    if (exerciseName) params.set("exerciseName", exerciseName);
    if (injuryState?.profileId) params.set("injuryProfileId", String(injuryState.profileId));

    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001"}/api/progress-summary?${params}`);
    const progress = await res.json();
    if (progress.hasProgress) send("progress_card", { card: progress });
    return JSON.stringify(progress);
  }

  return `Unknown tool: ${name}`;
}

// ── Claude formats NomadicML events into feedback ────────────────────────────

async function formatVideoFeedback(
  result: { phases: unknown[]; form_events: unknown[]; rom_events: unknown[]; pain_events: unknown[] },
  injuryType: string,
  exerciseName: string
) {
  type NEvent = { timestamp: string; summary: string; thumbnail_url?: string; category?: string };
  const { phases, form_events, rom_events, pain_events } = result as {
    phases: NEvent[]; form_events: NEvent[]; rom_events: NEvent[]; pain_events: NEvent[];
  };
  const totalEvents = form_events.length + rom_events.length + pain_events.length;

  if (totalEvents === 0 && phases.length === 0) {
    return { summary: "Excellent form!", overall_score: 95, corrections: [], encouragement: "Keep it up!", phase_notes: null };
  }

  const fmt = (events: NEvent[], label: string) =>
    events.length > 0
      ? `${label}:\n${events.map((e, i) => `  ${i + 1}. [${e.timestamp}] ${e.summary}${e.thumbnail_url ? ` (thumbnail: ${e.thumbnail_url})` : ""}`).join("\n")}`
      : `${label}: None`;

  const phasesText = phases.length > 0
    ? `PHASES:\n${phases.map(p => `  [${p.timestamp}] ${p.summary}`).join("\n")}\n`
    : "";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    messages: [{
      role: "user", content:
        `You are a physical therapist reviewing AI motion analysis for a patient recovering from ${injuryType || "an injury"} doing ${exerciseName || "rehabilitation exercise"}.\n\n${phasesText}${fmt(form_events, "FORM")}\n\n${fmt(rom_events, "RANGE OF MOTION")}\n\n${fmt(pain_events, "COMPENSATION")}\n\nReturn JSON:\n{"summary":"2-3 sentences","overall_score":0-100,"corrections":[{"timestamp":"","category":"form"|"rom"|"pain","issue":"","correction":"","priority":"high"|"medium"|"low","thumbnail_url":"copy exactly or null"}],"encouragement":"one sentence","phase_notes":"brief or null"}\n\nMap every event. Preserve thumbnail_url exactly.`
    }],
  });

  let text = "";
  for (const b of response.content) if (b.type === "text") text += b.text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse feedback JSON");
  return JSON.parse(match[0]);
}
