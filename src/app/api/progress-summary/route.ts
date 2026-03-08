import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const injuryProfileId = searchParams.get("injuryProfileId");
  const exerciseName = searchParams.get("exerciseName");
  const userId = searchParams.get("userId");

  if (!injuryProfileId && !userId) {
    return NextResponse.json({ error: "injuryProfileId or userId required" }, { status: 400 });
  }

  // Fetch all completed sessions for this injury profile + exercise, ordered by time
  let query = supabase
    .from("exercise_sessions")
    .select("id, created_at, exercise_name, overall_score, feedback_summary, corrections, raw_events, nomadicml_video_id")
    .eq("analysis_status", "completed")
    .order("created_at", { ascending: true });

  if (injuryProfileId) query = query.eq("injury_profile_id", injuryProfileId);
  else if (userId) query = query.eq("user_id", userId);
  if (exerciseName) query = query.eq("exercise_name", exerciseName);

  const { data: sessions, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!sessions || sessions.length < 2) {
    return NextResponse.json({
      sessionCount: sessions?.length ?? 0,
      hasProgress: false,
      message: sessions?.length === 1
        ? "Complete one more session to see your progress trend."
        : "No completed sessions found.",
    });
  }

  // Build a compact summary of each session for Claude
  const sessionSummaries = sessions.map((s, i) => {
    const date = new Date(s.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const corrections = (s.corrections as Array<{ category?: string; priority?: string; issue?: string }>) ?? [];
    const highCount = corrections.filter(c => c.priority === "high").length;
    const issues = corrections.slice(0, 3).map(c => c.issue).filter(Boolean).join("; ");
    return `Session ${i + 1} (${date}): score ${s.overall_score ?? "?"}/100, ${corrections.length} issue(s)${highCount > 0 ? `, ${highCount} high-priority` : ""}${issues ? `. Key issues: ${issues}` : ""}. Summary: ${s.feedback_summary ?? "N/A"}`;
  }).join("\n");

  const latestScore = sessions[sessions.length - 1].overall_score ?? 0;
  const firstScore = sessions[0].overall_score ?? 0;
  const scoreDelta = latestScore - firstScore;

  const prompt = `You are a physical therapist reviewing a patient's exercise history for "${exerciseName || "rehabilitation exercises"}".

Here are their sessions in order:
${sessionSummaries}

Write a concise progress report (3-5 sentences) that:
1. Celebrates measurable improvement (score went from ${firstScore} to ${latestScore}, ${scoreDelta >= 0 ? "+" : ""}${scoreDelta} points)
2. Names 1-2 specific issues that have improved or resolved
3. Names 1-2 issues that still need attention
4. Ends with one motivational sentence

Keep language warm, specific, and non-clinical. Do not use bullet points — write in flowing prose.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const narrative = response.content[0].type === "text" ? response.content[0].text : "";

  // Build score trend array
  const scoreTrend = sessions.map(s => ({
    date: s.created_at,
    score: s.overall_score ?? null,
    exercise: s.exercise_name ?? exerciseName ?? "exercise",
    sessionId: s.id,
    videoId: s.nomadicml_video_id,
  }));

  return NextResponse.json({
    hasProgress: true,
    sessionCount: sessions.length,
    firstScore,
    latestScore,
    scoreDelta,
    scoreTrend,
    narrative,
    exerciseName: exerciseName ?? sessions[0]?.exercise_name ?? null,
  });
}
