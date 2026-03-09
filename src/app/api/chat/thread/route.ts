import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  const { userId } = await req.json();
  const { data, error } = await supabase
    .from("chat_threads")
    .insert({ user_id: userId })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ threadId: data.id });
}
