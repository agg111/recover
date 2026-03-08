import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  const ext = file.name.split(".").pop();
  const folder = file.type.startsWith("image/") ? "injuries" : "exercises";
  const fileName = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  const { data, error } = await supabase.storage
    .from("media")
    .upload(fileName, Buffer.from(arrayBuffer), { contentType: file.type });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/media/${data.path}`;
  return NextResponse.json({ url, type: file.type.startsWith("image/") ? "image" : "video" });
}
