import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyInput = any;
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { Resend } from "resend";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const resend = new Resend(process.env.RESEND_API_KEY!);

export async function OPTIONS() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, injuryContext, userId } = body;

    // --- Tool definitions ---

    const sendReminderTool = betaZodTool({
      name: "send_reminder",
      description:
        "Send an exercise reminder or follow-up email to the patient. Call this when the user asks to be reminded, wants their plan emailed, or after completing a session.",
      inputSchema: z.object({
        reminderType: z
          .enum(["exercise", "followup", "checkup"])
          .describe("Type of reminder to send"),
        message: z.string().describe("A short personal note to include in the email"),
      }),
      run: async ({ reminderType, message }: AnyInput) => {
        if (!injuryContext) return "No injury profile found — ask the user to upload a photo first.";

        const exercisePlan = injuryContext.exercises || [];
        const emailContent = buildEmail(reminderType, injuryContext.injury_type, exercisePlan, message);

        const { error } = await resend.emails.send({
          from: "Recover <hello@optimalemails.xyz>",
          replyTo: "recover@optimalemails.xyz",
          to: "aishwaryagune@gmail.com",
          subject: emailContent.subject,
          html: emailContent.html,
        });

        if (error) throw new Error(error.message);

        // Log in Supabase
        await supabase.from("reminders").insert({
          user_id: userId,
          injury_profile_id: injuryContext.profileId,
          email: "aishwaryagune@gmail.com",
          reminder_type: reminderType,
          sent_at: new Date().toISOString(),
        });

        return `Reminder sent to aishwaryagune@gmail.com.`;
      },
    });

    const scheduleFollowupTool = betaZodTool({
      name: "schedule_followup",
      description:
        "Schedule a follow-up check-in. Call this when the user asks to be reminded in X days, or wants a weekly check-in.",
      inputSchema: z.object({
        daysFromNow: z.number().int().min(1).max(90).describe("Number of days until follow-up"),
        note: z.string().describe("What the follow-up should remind the user to do"),
      }),
      run: async ({ daysFromNow, note }: AnyInput) => {
        const scheduledAt = new Date();
        scheduledAt.setDate(scheduledAt.getDate() + daysFromNow);

        await supabase.from("reminders").insert({
          user_id: userId,
          injury_profile_id: injuryContext?.profileId,
          email: "aishwaryagune@gmail.com",
          reminder_type: "checkup",
          scheduled_at: scheduledAt.toISOString(),
        });

        return `Follow-up scheduled for ${scheduledAt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}. Note: ${note}`;
      },
    });

    const exportNotesTool = betaZodTool({
      name: "export_clinical_notes",
      description:
        "Generate a clinical summary document for the patient to share with their doctor or physiotherapist. Call this when the user wants to share progress with a provider.",
      inputSchema: z.object({
        additionalNotes: z.string().optional().describe("Any extra notes to include"),
      }),
      run: async ({ additionalNotes }: AnyInput) => {
        if (!injuryContext) return "No injury profile to export.";

        // Fetch exercise sessions
        const { data: sessions } = await supabase
          .from("exercise_sessions")
          .select("exercise_name, overall_score, feedback_summary, created_at")
          .eq("user_id", userId || "")
          .order("created_at", { ascending: false })
          .limit(10);

        // Store export request — the frontend will trigger the download
        return JSON.stringify({
          action: "export",
          injuryData: injuryContext,
          exerciseSessions: sessions || [],
          additionalNotes,
        });
      },
    });

    const getExerciseDetailsTool = betaZodTool({
      name: "get_exercise_details",
      description:
        "Get detailed instructions for a specific exercise. Call this when the user asks how to do an exercise or wants more detail on their plan.",
      inputSchema: z.object({
        exerciseName: z.string().describe("Name of the exercise"),
        injuryType: z.string().optional().describe("The patient's injury type for context"),
      }),
      run: async ({ exerciseName, injuryType }: AnyInput) => {
        // Claude answers from its own knowledge — just return the context
        return `Provide detailed step-by-step instructions for "${exerciseName}" suitable for someone recovering from ${injuryType || "an injury"}. Include: starting position, movement cues, breathing, common mistakes to avoid, and progressions.`;
      },
    });

    // Build system prompt with injury context
    const systemPrompt = injuryContext
      ? `You are a compassionate physical therapy assistant helping a patient recover from ${injuryContext.injury_type} (${injuryContext.severity} severity) affecting their ${injuryContext.affected_area}.

Recovery timeline: ${injuryContext.recovery_timeline || "ongoing"}
Prescribed exercises: ${injuryContext.exercises?.map((e: { name: string }) => e.name).join(", ") || "none yet"}

You have tools to send reminders, schedule follow-ups, export clinical notes, and explain exercises in detail. Use them naturally when helpful — don't ask permission, just do it when appropriate.

Keep responses warm, concise, and actionable. Always remind the user to see a doctor for serious concerns.`
      : `You are a compassionate physical therapy assistant. Ask the user to describe their injury or upload a photo so you can build their recovery plan. You have tools available once a plan is established.`;

    // Run tool runner — handles the agentic loop automatically
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalMessage = await (client.beta.messages as any).toolRunner({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      tools: [sendReminderTool, scheduleFollowupTool, exportNotesTool, getExerciseDetailsTool],
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    // Extract text response
    let responseText = "";
    let exportData = null;

    for (const block of finalMessage.content) {
      if (block.type === "text") {
        responseText += block.text;
      }
    }

    // Check if export was triggered (tool returned export action)
    // We surface this to the frontend to trigger the download
    if (responseText.includes('"action":"export"')) {
      try {
        const match = responseText.match(/\{[^}]*"action":"export"[^}]*\}/);
        if (match) {
          exportData = JSON.parse(match[0]);
          responseText = "I've prepared your clinical notes. Downloading now...";
        }
      } catch {
        // ignore parse error
      }
    }

    return NextResponse.json({
      success: true,
      message: responseText || "Done!",
      exportData,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolsUsed: finalMessage.content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => b.name),
    });
  } catch (error) {
    console.error("chat-with-tools error:", error);
    return NextResponse.json(
      { error: "Failed to process message", details: String(error) },
      { status: 500 }
    );
  }
}

function buildEmail(
  type: string,
  injuryType: string,
  exercises: Array<{ name: string; description: string; reps: string }>,
  personalNote: string
) {
  const exerciseHtml =
    exercises.length > 0
      ? `<ul>${exercises.map((e) => `<li><strong>${e.name}</strong> — ${e.reps}<br/><span style="color:#6b7280">${e.description}</span></li>`).join("")}</ul>`
      : "<p>Check the app for your exercise plan.</p>";

  return {
    subject: type === "exercise" ? "Your recovery exercises for today 💪" : "Recovery check-in",
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#6366f1">Recover Assistant</h2>
        <p>${personalNote}</p>
        ${type === "exercise" ? `<h3>Today's exercises for <em>${injuryType}</em>:</h3>${exerciseHtml}` : ""}
        <p style="color:#6b7280;font-size:13px;margin-top:24px">Reply to this email if you have questions about your recovery.</p>
      </div>`,
  };
}
