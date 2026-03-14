import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { fetch as undiciFetch, Agent } from "undici";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 300;
import { Resend } from "resend";

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL || "http://localhost:8000";
const longTimeoutAgent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });
const resend = new Resend(process.env.RESEND_API_KEY!);

function buildIcs({ summary, description, start, durationMinutes }: {
  summary: string;
  description: string;
  start: Date;
  durationMinutes: number;
}): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const uid = `recover-${start.getTime()}@recover.app`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Recover//Recovery App//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    `DTSTAMP:${fmt(new Date())}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function getSystemPrompt() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" });

  return `You are Recover, an AI physical therapist. You help patients recover from injuries through personalized exercise guidance and real-time form analysis.

CURRENT DATE & TIME: ${dateStr}, ${timeStr}
When the user says "today", "tomorrow", "tonight", "9 AM", etc., resolve it against this date/time and pass a precise ISO 8601 datetime to scheduled_at (e.g. "2026-03-10T09:00:00").

SCOPE — STRICTLY ENFORCED:
You ONLY discuss topics directly related to: injury recovery, physical therapy, exercise form, rehabilitation, pain management, and related medical guidance.
If the user asks about ANYTHING outside this scope (coding, general knowledge, relationships, news, other AI topics, etc.), respond with exactly:
"I'm here to help with your injury recovery. I can't help with that, but I'm ready whenever you want to talk about your rehab or share a photo or video."
Do not engage with off-topic questions in any way, even briefly. Do not apologize extensively. Just redirect once, firmly and warmly.

CAPABILITIES — use these tools naturally, never ask permission:
- When you see an injury photo: analyze it yourself (you can see images), then call save_injury_profile to persist it
- When the user shares ONE exercise video URL: call analyze_exercise_video — NomadicML single-angle analysis
- When the user shares TWO OR MORE video URLs from different angles (front + side, etc.): call analyze_exercise_multiview — NomadicML fuses results across angles for much richer feedback. Ask the user which angle each video is if not clear.
- When the user asks for reminders or to email their plan: call send_reminder. Always include scheduled_at if the user mentions a time.
- When the user asks how they're doing over time: call get_progress_summary
RESPONSE STYLE for each situation:
- After injury photo: 2 sentences on the injury, 2 exercises (name + reps only), say you'll email the full plan, ask them to record a short video
- After video analysis: warm summary of the top corrections, score, encouragement
- After send_reminder: ALWAYS explicitly confirm — say what was sent, to which email, and the scheduled time (e.g. "Done! I've emailed your recovery plan and set a reminder for tomorrow at 7 PM."). Never silently complete this.
- General chat: concise, warm, non-clinical

Always keep context from prior messages. Never repeat the injury summary unless asked.
Never call a tool that has already succeeded in this conversation unless the user explicitly asks you to do it again.`;
}

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
    description: "Send the patient's exercise plan or a follow-up email, with an optional calendar invite (.ics) attached so they can add it to Google/Apple/Outlook calendar.",
    input_schema: {
      type: "object" as const,
      properties: {
        reminder_type: { type: "string", enum: ["exercise", "followup"] },
        personal_note: { type: "string", description: "Short personal note to include" },
        scheduled_at: { type: "string", description: "ISO 8601 datetime for the calendar event, e.g. 2026-03-10T09:00:00. Use the user's requested time. If no timezone info, assume America/Los_Angeles." },
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
        const { messages, userId, injuryContext, threadId } = body as {
          messages: Array<{ role: "user" | "assistant"; content: string | Anthropic.ContentBlockParam[] }>;
          userId?: string;
          injuryContext?: Record<string, unknown> | null;
          threadId?: string;
        };

        // Rate limit: max 20 user messages per thread
        if (threadId) {
          const { count } = await supabase
            .from("chat_messages")
            .select("*", { count: "exact", head: true })
            .eq("thread_id", threadId)
            .eq("role", "user");
          if ((count ?? 0) >= 20) {
            send("error", { message: "You've reached the 20-message limit for this conversation. Start a new chat to continue." });
            controller.close();
            return;
          }
        }

        // Agentic loop with streaming — text tokens flow to client immediately
        let loopMessages = [...messages];
        let injuryState = injuryContext ?? null;

        while (true) {
          // Stream Claude's response token-by-token
          const stream = anthropic.messages.stream({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: getSystemPrompt(),
            tools: TOOLS,
            messages: loopMessages,
          });

          // Forward text deltas as they arrive
          stream.on("text", (delta) => {
            if (delta) send("text", { text: delta });
          });

          const response = await stream.finalMessage();

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
              console.error(`Tool error (${block.name}):`, e);
              result = "Tool encountered an error. Please try again.";
            }

            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }

          // Signal Chat.tsx that tools are done so follow-up text is shown
          send("tool_done", {});

          loopMessages = [
            ...loopMessages,
            { role: "assistant", content: response.content },
            { role: "user", content: toolResults },
          ];
        }

        send("done", { injuryContext: injuryState });
      } catch (err) {
        console.error("agent error:", err);
        const msg = err instanceof Error ? err.message : String(err);
        const friendly = msg.includes("image") || msg.includes("file format") || msg.includes("unsupported")
          ? "I couldn't process that image or video — the file format may not be supported. Try a JPEG, PNG, or MP4."
          : msg.includes("credit") || msg.includes("billing")
          ? "Something went wrong on our end. Please try again in a moment."
          : msg.includes("rate_limit")
          ? "We're a bit busy right now. Please try again in a few seconds."
          : "Something went wrong. Please try again.";
        send("error", { message: friendly });
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

    const resolvedExercise = exercise_name ?? (injuryState?.exercises as Array<{name:string}>)?.[0]?.name ?? "";
    const resolvedInjury = injury_type ?? String(injuryState?.injury_type ?? "");

    // Fast early insight from Claude while NomadicML processes (runs in parallel)
    const earlyInsightPromise = anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 120,
      messages: [{
        role: "user",
        content: `You are a physical therapist. A patient recovering from ${resolvedInjury || "an injury"} just sent a video of their ${resolvedExercise || "rehabilitation exercise"}. Write ONE short, warm, encouraging sentence (max 15 words) telling them what you'll look for while the AI motion analysis runs. Be specific to their injury/exercise. No fluff.`,
      }],
    }).then(r => {
      const text = r.content.find(b => b.type === "text")?.text?.trim();
      if (text) send("progress", { message: text });
    }).catch(() => {});

    // Call Python video service — reads SSE stream and forwards progress to client
    const serviceRes = await undiciFetch(`${VIDEO_SERVICE_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_url,
        injury_type: resolvedInjury || undefined,
        exercise_name: resolvedExercise || undefined,
      }),
      dispatcher: longTimeoutAgent,
    });

    if (!serviceRes.ok) throw new Error(`Video service: ${await serviceRes.text()}`);

    // Read SSE stream from Python service, forwarding progress and collecting result
    const svcReader = serviceRes.body!.getReader();
    const svcDecoder = new TextDecoder();
    let svcBuffer = "";
    let nomadicResult: {
      phases: Array<{ timestamp: string; summary: string }>;
      form_events: Array<{ timestamp: string; summary: string; thumbnail_url?: string }>;
      rom_events: Array<{ timestamp: string; summary: string; thumbnail_url?: string }>;
      pain_events: Array<{ timestamp: string; summary: string; thumbnail_url?: string }>;
    } | null = null;

    while (true) {
      const { done, value } = await svcReader.read();
      if (done) break;
      svcBuffer += svcDecoder.decode(value, { stream: true });
      const lines = svcBuffer.split("\n");
      svcBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let evt: { type: string; message?: string } | null = null;
        try {
          evt = JSON.parse(line.slice(6));
        } catch { /* ignore malformed SSE lines */ }
        if (!evt) continue;
        if (evt.type === "progress") send("progress", { message: evt.message });
        else if (evt.type === "result") nomadicResult = evt as unknown as typeof nomadicResult;
        else if (evt.type === "error") throw new Error(evt.message ?? "Video service error");
      }
    }

    if (!nomadicResult) throw new Error("No result from video service");

    await earlyInsightPromise;
    send("progress", { message: "Generating personalised feedback…" });

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
          exercise_name: exercise_name ?? (injuryState?.exercises as Array<{name:string}>)?.[0]?.name,
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

    // Look up user's email from auth
    let userEmail: string | null = null;
    if (userId) {
      const { data: { user: authUser } } = await supabase.auth.admin.getUserById(userId);
      userEmail = authUser?.email ?? null;
    }
    if (!userEmail) return "I couldn't find your email address. Please make sure you're logged in.";

    const exercises = (injuryState.exercises as Array<{ name: string; description: string; reps: string }>) ?? [];
    const dos = (injuryState.dos as string[]) ?? [];
    const donts = (injuryState.donts as string[]) ?? [];
    const note = String(input.personal_note ?? "Here's your personalised recovery plan.");
    const type = String(input.reminder_type);
    const isFollowup = type === "followup";

    const exerciseHtml = exercises.map((e, i) => `
      <tr>
        <td style="padding:16px;border-bottom:1px solid #f3f4f6;vertical-align:top">
          <div style="display:flex;align-items:flex-start;gap:12px">
            <div style="background:#6366f1;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;text-align:center;line-height:28px">${i + 1}</div>
            <div>
              <div style="font-weight:600;font-size:15px;color:#111827;margin-bottom:2px">${e.name}</div>
              <div style="color:#6b7280;font-size:13px;margin-bottom:6px">${e.description}</div>
              <div style="display:inline-block;background:#ede9fe;color:#6366f1;border-radius:20px;padding:2px 10px;font-size:12px;font-weight:600">${e.reps}</div>
            </div>
          </div>
        </td>
      </tr>`).join("");

    const dosHtml = dos.map(d => `<li style="margin-bottom:6px;color:#065f46">✓ ${d}</li>`).join("");
    const dontsHtml = donts.map(d => `<li style="margin-bottom:6px;color:#991b1b">✗ ${d}</li>`).join("");

    const doctorSection = injuryState.when_to_see_doctor ? `
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;padding:14px 16px;margin:24px 0">
        <div style="font-weight:600;color:#92400e;margin-bottom:4px">⚠️ When to see a doctor</div>
        <div style="color:#92400e;font-size:14px">${injuryState.when_to_see_doctor}</div>
      </div>` : "";

    const timelineSection = injuryState.recovery_timeline ? `
      <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:4px;padding:14px 16px;margin:0 0 24px">
        <div style="font-weight:600;color:#1e40af;margin-bottom:4px">📅 Recovery timeline</div>
        <div style="color:#1e40af;font-size:14px">${injuryState.recovery_timeline}</div>
      </div>` : "";

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:32px 32px 28px">
      <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px">Recover</div>
      <div style="color:#e0e7ff;font-size:14px;margin-top:4px">AI-powered physical therapy</div>
    </div>

    <!-- Injury badge -->
    <div style="padding:24px 32px 0">
      <div style="display:inline-block;background:#ede9fe;color:#6366f1;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;margin-bottom:12px">${injuryState.affected_area ?? ""} · ${injuryState.severity ?? ""} severity</div>
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827">${injuryState.injury_type}</h1>
      <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.5">${note}</p>
    </div>

    ${doctorSection ? `<div style="padding:0 32px">${doctorSection}</div>` : ""}
    ${timelineSection ? `<div style="padding:0 32px">${timelineSection}</div>` : ""}

    <!-- Dos & Don'ts -->
    ${(dos.length > 0 || donts.length > 0) ? `
    <div style="padding:0 32px 24px">
      <div style="display:grid;gap:16px">
        ${dos.length > 0 ? `
        <div style="background:#f0fdf4;border-radius:8px;padding:16px">
          <div style="font-weight:600;color:#166534;margin-bottom:10px;font-size:14px">✅ Do these</div>
          <ul style="margin:0;padding-left:4px;list-style:none">${dosHtml}</ul>
        </div>` : ""}
        ${donts.length > 0 ? `
        <div style="background:#fef2f2;border-radius:8px;padding:16px">
          <div style="font-weight:600;color:#991b1b;margin-bottom:10px;font-size:14px">🚫 Avoid these</div>
          <ul style="margin:0;padding-left:4px;list-style:none">${dontsHtml}</ul>
        </div>` : ""}
      </div>
    </div>` : ""}

    <!-- Exercises -->
    ${exercises.length > 0 ? `
    <div style="padding:0 32px 24px">
      <h2 style="margin:0 0 16px;font-size:17px;font-weight:700;color:#111827">🏋️ Your exercise plan</h2>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
        <tbody>${exerciseHtml}</tbody>
      </table>
    </div>` : ""}

    <!-- Footer -->
    <div style="background:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb">
      <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6">
        This plan was generated by Recover AI. Always consult a licensed physical therapist or physician before beginning any exercise program, especially if pain worsens.<br><br>
        © Recover · <a href="#" style="color:#6366f1;text-decoration:none">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;

    // Build .ics calendar attachment if a scheduled time was provided
    const scheduledAt = input.scheduled_at ? new Date(String(input.scheduled_at)) : null;
    const icsAttachment = scheduledAt && !isNaN(scheduledAt.getTime()) ? buildIcs({
      summary: `Recovery session — ${injuryState.injury_type}`,
      description: `Your ${injuryState.injury_type} exercise session. Open the Recover app to log your progress.`,
      start: scheduledAt,
      durationMinutes: 30,
    }) : null;

    const emailResult = await resend.emails.send({
      from: "Recover <onboarding@resend.dev>",
      to: userEmail,
      subject: isFollowup ? `Recovery check-in — ${injuryState.injury_type}` : `Your ${injuryState.injury_type} recovery plan 💪`,
      html,
      ...(icsAttachment ? {
        attachments: [{
          filename: "recovery-session.ics",
          content: Buffer.from(icsAttachment).toString("base64"),
        }],
      } : {}),
    });
    console.log("[Resend] send result:", JSON.stringify(emailResult));
    if ((emailResult as { error?: unknown }).error) {
      throw new Error(`Resend error: ${JSON.stringify((emailResult as { error: unknown }).error)}`);
    }
    if (userId) {
      await supabase.from("reminders").insert({
        user_id: userId,
        injury_profile_id: injuryState.profileId,
        email: userEmail,
        reminder_type: type,
        scheduled_at: scheduledAt?.toISOString() ?? new Date().toISOString(),
        sent_at: new Date().toISOString(),
      }).then(({ error }) => { if (error) console.error("reminders insert error:", error); });
    }
    return icsAttachment
      ? `Email sent to ${userEmail} with a calendar invite attached. They can open the .ics file to add the session to Google Calendar, Apple Calendar, or Outlook.`
      : `Email sent to ${userEmail}.`;
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
        exercise_name: exercise_name ?? (injuryState?.exercises as Array<{name:string}>)?.[0]?.name,
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
          exercise_name: exercise_name ?? (injuryState?.exercises as Array<{name:string}>)?.[0]?.name,
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
    const exerciseName = String(input.exercise_name ?? (injuryState?.exercises as Array<{name:string}>)?.[0]?.name ?? "");
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
