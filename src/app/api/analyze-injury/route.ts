import { NextRequest, NextResponse } from "next/server";
import { anthropic } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";

export async function OPTIONS() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const image = formData.get("image") as File | null;
    const userId = formData.get("userId") as string | null;

    if (!image) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    // Convert image to base64
    const arrayBuffer = await image.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mediaType = image.type as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

    // Upload image to Supabase Storage
    const fileName = `injuries/${Date.now()}-${image.name}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("media")
      .upload(fileName, Buffer.from(arrayBuffer), { contentType: image.type });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
    }

    const imageUrl = uploadData
      ? `${process.env.SUPABASE_URL}/storage/v1/object/public/media/${uploadData.path}`
      : null;

    // Analyze with Claude Vision
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            {
              type: "text",
              text: `You are a physical therapy and sports medicine expert. Analyze this image and provide:

1. INJURY_TYPE: What type of injury or physical condition is visible (be specific, e.g. "ankle sprain", "knee swelling", "shoulder impingement", "lower back strain")
2. SEVERITY: Estimated severity (mild/moderate/severe) based on visible signs
3. AFFECTED_AREA: Body part(s) affected
4. DOS: List of 5-7 things the person SHOULD do (exercises, rest, ice/heat, positions)
5. DONTS: List of 5-7 things the person should AVOID
6. EXERCISES: List of 4-6 recommended rehabilitation exercises with brief descriptions
7. WHEN_TO_SEE_DOCTOR: Signs that warrant immediate medical attention
8. RECOVERY_TIMELINE: Estimated recovery timeline

Respond in valid JSON format with these exact keys: injury_type, severity, affected_area, dos (array), donts (array), exercises (array of {name, description, reps}), when_to_see_doctor, recovery_timeline.

If the image does not show an injury or body part, set injury_type to "unclear" and provide general wellness advice.`,
            },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type from Claude");
    }

    // Parse Claude's JSON response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not parse JSON from Claude response");
    }
    const analysis = JSON.parse(jsonMatch[0]);

    // Save to Supabase
    let profileId: string | null = null;
    if (userId) {
      const { data: profile, error: dbError } = await supabase
        .from("injury_profiles")
        .insert({
          user_id: userId,
          image_url: imageUrl,
          injury_type: analysis.injury_type,
          severity: analysis.severity,
          affected_area: analysis.affected_area,
          analysis: analysis,
          dos: analysis.dos,
          donts: analysis.donts,
          exercise_plan: analysis.exercises,
        })
        .select("id")
        .single();

      if (dbError) {
        console.error("DB insert error:", dbError);
      } else {
        profileId = profile?.id ?? null;
      }
    }

    return NextResponse.json({
      success: true,
      profileId,
      imageUrl,
      ...analysis,
    });
  } catch (error) {
    console.error("analyze-injury error:", error);
    return NextResponse.json(
      { error: "Failed to analyze injury", details: String(error) },
      { status: 500 }
    );
  }
}
