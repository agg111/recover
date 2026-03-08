import { NextRequest, NextResponse } from "next/server";
import { anthropic } from "@/lib/anthropic";

export async function OPTIONS() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, injuryContext } = body;

    // Build system prompt with injury context if available
    const systemPrompt = injuryContext
      ? `You are a compassionate physical therapy assistant helping a patient recover from ${injuryContext.injury_type || "an injury"} affecting their ${injuryContext.affected_area || "body"}.

Their current plan includes: ${JSON.stringify(injuryContext.exercise_plan || [])}
Severity: ${injuryContext.severity || "unknown"}

Guide them through recovery with encouragement and practical advice. Keep responses concise and friendly.
If they describe worsening symptoms, always recommend seeing a healthcare professional.
Do not diagnose — you are a recovery guide, not a doctor.`
      : `You are a compassionate physical therapy assistant helping users with injury recovery.
Guide users to describe their injury, then provide practical recovery advice including RICE method, exercises, and when to see a doctor.
Keep responses concise, warm, and actionable. Do not diagnose — recommend professional care for serious injuries.`;

    // Convert frontend message format to Anthropic format
    const anthropicMessages = messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: systemPrompt,
      messages: anthropicMessages,
    });

    const content = response.content[0];
    if (content.type !== "text") throw new Error("Unexpected response type");

    return NextResponse.json({ success: true, message: content.text });
  } catch (error) {
    console.error("chat error:", error);
    return NextResponse.json(
      { error: "Failed to get response", details: String(error) },
      { status: 500 }
    );
  }
}
