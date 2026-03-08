import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

export async function OPTIONS() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, injuryProfileId, conversation, injuryData, exerciseSessions } = body;

    // Optionally fetch full data from Supabase if IDs provided
    let profile = injuryData;
    let sessions = exerciseSessions || [];

    if (injuryProfileId && !injuryData) {
      const { data } = await supabase
        .from("injury_profiles")
        .select("*, exercise_sessions(*)")
        .eq("id", injuryProfileId)
        .single();
      if (data) {
        profile = data;
        sessions = data.exercise_sessions || [];
      }
    }

    // Use Claude to generate a structured clinical summary
    const summaryPrompt = buildSummaryPrompt(profile, sessions, conversation);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: summaryPrompt }],
    });

    const content = response.content[0];
    if (content.type !== "text") throw new Error("Unexpected response");

    const clinicalSummary = content.text;

    // Build full HTML export document
    const html = buildExportHTML(profile, sessions, conversation, clinicalSummary);

    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html",
        "Content-Disposition": `attachment; filename="recover-session-${Date.now()}.html"`,
      },
    });
  } catch (error) {
    console.error("export-session error:", error);
    return NextResponse.json(
      { error: "Failed to export session", details: String(error) },
      { status: 500 }
    );
  }
}

function buildSummaryPrompt(
  profile: Record<string, unknown> | null,
  sessions: Array<Record<string, unknown>>,
  conversation: Array<{ role: string; content: string }>
) {
  const injurySection = profile
    ? `INJURY: ${profile.injury_type} (${profile.severity} severity), affecting ${profile.affected_area}
Recovery timeline: ${profile.recovery_timeline || "not specified"}
Prescribed exercises: ${JSON.stringify(profile.exercise_plan || [])}`
    : "No injury analysis on file.";

  const sessionSection =
    sessions.length > 0
      ? sessions
          .map(
            (s) =>
              `- ${s.exercise_name || "Exercise"}: Score ${s.overall_score || "N/A"}/100. ${s.feedback_summary || ""}`
          )
          .join("\n")
      : "No exercise sessions recorded.";

  const conversationSection = conversation
    ? conversation
        .slice(-20)
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n")
    : "No conversation on file.";

  return `You are a clinical documentation assistant. Generate a structured clinical note for a provider based on this patient's self-reported recovery session data.

${injurySection}

EXERCISE SESSIONS:
${sessionSection}

PATIENT CONVERSATION:
${conversationSection}

Generate a clinical note with these sections:
1. Chief Complaint
2. History of Present Illness
3. Functional Assessment (based on exercise scores and conversation)
4. Current Treatment Plan (exercises prescribed)
5. Progress Notes
6. Recommendations

Use professional clinical language. Note that this is AI-assisted patient self-reporting and should be verified by the provider.`;
}

function buildExportHTML(
  profile: Record<string, unknown> | null,
  sessions: Array<Record<string, unknown>>,
  conversation: Array<{ role: string; content: string }>,
  clinicalSummary: string
) {
  const date = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const exerciseRows =
    sessions.length > 0
      ? sessions
          .map(
            (s) => `
          <tr>
            <td>${s.exercise_name || "—"}</td>
            <td>${new Date(s.created_at as string).toLocaleDateString()}</td>
            <td>${s.overall_score || "—"}/100</td>
            <td>${s.feedback_summary || "—"}</td>
          </tr>`
          )
          .join("")
      : '<tr><td colspan="4" style="color:#999;text-align:center">No sessions recorded</td></tr>';

  const conversationHtml =
    conversation && conversation.length > 0
      ? conversation
          .map(
            (m) => `
          <div class="message ${m.role}">
            <strong>${m.role === "assistant" ? "Recover AI" : "Patient"}:</strong>
            <span>${m.content}</span>
          </div>`
          )
          .join("")
      : "<p style='color:#999'>No conversation transcript available.</p>";

  const dosHtml = profile?.dos
    ? (profile.dos as string[]).map((d) => `<li>${d}</li>`).join("")
    : "";
  const dontsHtml = profile?.donts
    ? (profile.donts as string[]).map((d) => `<li>${d}</li>`).join("")
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Recover — Clinical Session Export</title>
<style>
  body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; color: #1a1a1a; line-height: 1.6; }
  h1 { color: #4f46e5; border-bottom: 2px solid #4f46e5; padding-bottom: 8px; }
  h2 { color: #374151; margin-top: 32px; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; }
  h3 { color: #4f46e5; margin-top: 24px; }
  .meta { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .meta p { margin: 4px 0; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: bold; }
  .mild { background: #d1fae5; color: #065f46; }
  .moderate { background: #fef3c7; color: #92400e; }
  .severe { background: #fee2e2; color: #991b1b; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #f3f4f6; text-align: left; padding: 8px 12px; font-size: 13px; }
  td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .dos { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px; }
  .donts { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; }
  .dos ul, .donts ul { margin: 8px 0; padding-left: 20px; font-size: 13px; }
  .clinical-note { background: #f8faff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 20px; white-space: pre-wrap; font-family: monospace; font-size: 13px; }
  .message { margin: 8px 0; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
  .message.assistant { background: #f3f4f6; }
  .message.user { background: #eef2ff; }
  .disclaimer { margin-top: 40px; padding: 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; font-size: 12px; color: #92400e; }
  @media print { body { margin: 20px; } }
</style>
</head>
<body>

<h1>Recover — Patient Session Export</h1>
<p style="color:#6b7280; font-size:14px;">Generated: ${date} · For provider review via Knowtex</p>

<h2>Injury Profile</h2>
${
  profile
    ? `<div class="meta">
    <p><strong>Injury:</strong> ${profile.injury_type || "Unknown"}</p>
    <p><strong>Severity:</strong> <span class="badge ${(profile.severity as string)?.toLowerCase() || ""}">${profile.severity || "—"}</span></p>
    <p><strong>Affected Area:</strong> ${profile.affected_area || "—"}</p>
    <p><strong>Recovery Timeline:</strong> ${profile.recovery_timeline || "—"}</p>
    <p><strong>⚠️ See Doctor If:</strong> ${(profile.analysis as Record<string, unknown>)?.when_to_see_doctor || "—"}</p>
  </div>

  <div class="two-col">
    <div class="dos"><strong>✅ Do's</strong><ul>${dosHtml}</ul></div>
    <div class="donts"><strong>❌ Don'ts</strong><ul>${dontsHtml}</ul></div>
  </div>`
    : "<p style='color:#999'>No injury profile recorded.</p>"
}

<h2>Exercise Sessions</h2>
<table>
  <thead>
    <tr><th>Exercise</th><th>Date</th><th>Form Score</th><th>Feedback Summary</th></tr>
  </thead>
  <tbody>${exerciseRows}</tbody>
</table>

<h2>AI-Generated Clinical Note</h2>
<div class="clinical-note">${clinicalSummary}</div>

<h2>Conversation Transcript</h2>
${conversationHtml}

<div class="disclaimer">
  <strong>Important:</strong> This document was generated by an AI-assisted patient self-reporting tool (Recover).
  All information should be verified by a licensed healthcare provider. This is not a substitute for clinical examination.
  Intended for use with Knowtex clinical documentation workflow.
</div>

</body>
</html>`;
}
