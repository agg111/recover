import { NextRequest, NextResponse } from "next/server";
import { anthropic } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM_EMAIL = "Recover <hello@optimalemails.xyz>";

export async function OPTIONS() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  let event: Record<string, unknown>;
  try {
    event = await req.json();
  } catch {
    return NextResponse.json({ status: "error", message: "Invalid JSON" }, { status: 400 });
  }

  console.log("[Webhook] Inbound email event type:", event.type);

  if (event.type !== "email.received") {
    return NextResponse.json({ status: "ignored", reason: "not email.received" });
  }

  try {
    const result = await handleInboundEmail(event);
    console.log("[Webhook] Result:", result);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[Webhook] Error:", error);
    return NextResponse.json({ status: "error", message: String(error) }, { status: 500 });
  }
}

async function handleInboundEmail(event: Record<string, unknown>) {
  const data = event.data as Record<string, unknown>;
  const emailId = data?.email_id as string;
  const fromRaw = (data?.from as string) || "";
  // Parse bare email from "Name <email@domain.com>" format
  const fromEmail = fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw;
  const subject = (data?.subject as string) || "";
  const messageId = (data?.message_id as string) || "";

  console.log("[Inbound] From raw:", fromRaw, "→ parsed:", fromEmail, "Subject:", subject);
  console.log("[Inbound] Full data keys:", Object.keys(data || {}));

  if (!fromEmail) return { status: "error", reason: "no from email" };

  // Try to get body from webhook payload first (Resend includes it directly)
  let fullBody = ((data?.text as string) || (data?.html as string) || "").trim();
  console.log("[Inbound] Body from webhook payload — text:", (data?.text as string)?.length ?? 0, "html:", (data?.html as string)?.length ?? 0);

  // Fall back to fetching from Resend API if not in payload
  if (!fullBody && emailId) {
    const emailContent = await fetchEmailContent(emailId);
    console.log("[Inbound] Fetched email content keys:", emailContent ? Object.keys(emailContent) : "null");
    fullBody = ((emailContent?.text || emailContent?.html || "") as string).trim();
  }

  if (!fullBody) {
    console.error("[Inbound] Empty body — sending fallback reply");
    await sendReply(fromEmail, subject, "Thanks for your message! I received your email but had trouble reading the content. Please reply again or reach out through the app.", messageId);
    return { status: "fallback_reply_sent", reason: "empty body" };
  }

  const userMessage = extractUserMessage(fullBody);
  console.log("[Inbound] User message:", userMessage.slice(0, 100));

  // Look up most recent injury profile (hardcoded to known user)
  const injuryContext = await getInjuryContext();
  console.log("[Inbound] Injury context found:", injuryContext ? "yes" : "no");

  // Generate response with Claude
  const response = await generateResponse(userMessage, injuryContext, fromEmail);
  console.log("[Inbound] Response:", response.slice(0, 100));

  // Send reply maintaining thread
  await sendReply(fromEmail, subject, response, messageId);
  console.log("[Inbound] Reply sent to:", fromEmail);

  return { status: "processed", email_id: emailId, response_sent: true };
}

async function fetchEmailContent(emailId: string) {
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    });
    if (!res.ok) {
      console.error("[Inbound] Fetch email failed:", res.status, await res.text());
      return null;
    }
    return res.json();
  } catch (e) {
    console.error("[Inbound] Fetch email error:", e);
    return null;
  }
}

function extractUserMessage(body: string): string {
  const lines = body.split("\n");
  const userLines: string[] = [];

  for (const line of lines) {
    if (
      /^(on |wrote:|-----original|> |from:|sent:|to:|subject:|---|___)/i.test(line.trim()) ||
      line.includes("This is a response from Recover")
    ) break;
    userLines.push(line);
  }

  const message = userLines.join("\n").trim();
  return message || lines.slice(0, 5).join("\n").trim();
}

async function getInjuryContext() {
  try {
    // Fetch the most recent injury profile
    const { data: profile } = await supabase
      .from("injury_profiles")
      .select("*, exercise_sessions(*)")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    return profile;
  } catch {
    return null;
  }
}

async function generateResponse(
  userMessage: string,
  injuryContext: Record<string, unknown> | null,
  fromEmail: string
) {
  const contextStr = injuryContext
    ? `PATIENT INJURY PROFILE:
- Injury: ${injuryContext.injury_type} (${injuryContext.severity} severity)
- Affected area: ${injuryContext.affected_area}
- Recovery timeline: ${(injuryContext.analysis as Record<string, unknown>)?.recovery_timeline || "unknown"}
- Prescribed exercises: ${JSON.stringify(injuryContext.exercise_plan || [])}
- Exercise sessions completed: ${(injuryContext.exercise_sessions as unknown[])?.length || 0}`
    : "No injury profile found for this patient.";

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: `You are a compassionate physical therapy assistant responding to a patient email.

${contextStr}

PATIENT'S EMAIL:
${userMessage}

Write a helpful, warm reply in plain text (no markdown — this goes in an email). Be concise and specific to their injury if context is available. Remind them to see a doctor for serious concerns.`,
      },
    ],
  });

  const content = message.content[0];
  return content.type === "text" ? content.text : "Thank you for your message! Keep following your exercise plan and don't hesitate to reach out with any questions.";
}

async function sendReply(
  toEmail: string,
  subject: string,
  body: string,
  inReplyTo?: string
) {
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <p style="white-space: pre-line; line-height: 1.6;">${body}</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
      <p style="color: #6b7280; font-size: 12px;">
        This is a response from Recover's recovery assistant.<br>
        Reply to this email if you have more questions.
      </p>
    </div>`;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: replySubject,
    html,
    ...(inReplyTo && { headers: { "In-Reply-To": inReplyTo, References: inReplyTo } }),
  });

  console.log("[Inbound] Reply sent to", toEmail);
}
