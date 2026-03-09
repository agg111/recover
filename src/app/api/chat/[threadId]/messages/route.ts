import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await params;
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ messages: data ?? [] });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await params;
  const { userId, role, content, metadata } = await req.json();
  const { error } = await supabase
    .from("chat_messages")
    .insert({ thread_id: threadId, user_id: userId, role, content, metadata: metadata ?? {} });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await supabase
    .from("chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId);
  return NextResponse.json({ ok: true });
}
