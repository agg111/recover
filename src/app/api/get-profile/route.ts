import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function OPTIONS() {
  return new NextResponse(null, { status: 200 });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    const profileId = searchParams.get("profileId");

    if (!userId && !profileId) {
      return NextResponse.json({ error: "userId or profileId required" }, { status: 400 });
    }

    if (profileId) {
      const { data, error } = await supabase
        .from("injury_profiles")
        .select("*, exercise_sessions(*)")
        .eq("id", profileId)
        .single();

      if (error) throw error;
      return NextResponse.json({ success: true, profile: data });
    }

    // Get all profiles for a user
    const { data, error } = await supabase
      .from("injury_profiles")
      .select("*, exercise_sessions(id, exercise_name, analysis_status, overall_score, created_at)")
      .eq("user_id", userId!)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ success: true, profiles: data });
  } catch (error) {
    console.error("get-profile error:", error);
    return NextResponse.json(
      { error: "Failed to fetch profile", details: String(error) },
      { status: 500 }
    );
  }
}
