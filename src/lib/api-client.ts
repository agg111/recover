const API_URL = "";

async function normalizeImage(file: File): Promise<File> {
  const isHeic = file.type === "image/heic" || file.type === "image/heif"
    || file.name.toLowerCase().endsWith(".heic") || file.name.toLowerCase().endsWith(".heif");
  if (!isHeic) return file;
  const heic2any = (await import("heic2any")).default;
  const blob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 }) as Blob;
  return new File([blob], file.name.replace(/\.heic$/i, ".jpg").replace(/\.heif$/i, ".jpg"), { type: "image/jpeg" });
}

export async function uploadFile(file: File): Promise<{ url: string; type: "image" | "video" }> {
  // Upload directly to Supabase Storage from the browser to avoid Vercel's 4.5 MB payload limit
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const isImage = file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);

  // Convert HEIC/HEIF → JPEG before uploading
  if (isImage) file = await normalizeImage(file);

  const folder = isImage ? "injuries" : "exercises";
  const ext = file.name.split(".").pop();
  const fileName = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { data, error } = await supabase.storage
    .from("media")
    .upload(fileName, file, { contentType: file.type });

  if (error) throw new Error(error.message);

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/${data.path}`;
  return { url, type: isImage ? "image" : "video" };
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "progress"; message: string }
  | { type: "tool_start"; tool: string }
  | { type: "tool_done" }
  | { type: "injury_card"; card: InjuryAnalysis }
  | { type: "video_card"; card: VideoFeedback["feedback"] & { phases?: VideoFeedback["phases"]; sessionId?: string } }
  | { type: "progress_card"; card: ProgressSummary }
  | { type: "done"; injuryContext?: InjuryAnalysis }
  | { type: "error"; message: string };

export async function* streamAgent(
  messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }>,
  opts: { userId?: string; injuryContext?: InjuryAnalysis | null; threadId?: string | null }
): AsyncGenerator<AgentEvent> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await fetch(`${API_URL}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, userId: opts.userId, injuryContext: opts.injuryContext, threadId: opts.threadId, timezone }),
  });
  if (!res.ok) throw new Error("Agent request failed");

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try { yield JSON.parse(line.slice(6)) as AgentEvent; } catch { /* skip */ }
    }
  }
}

export interface InjuryAnalysis {
  success: boolean;
  profileId: string | null;
  imageUrl: string | null;
  injury_type: string;
  severity: string;
  affected_area: string;
  dos: string[];
  donts: string[];
  exercises: Array<{ name: string; description: string; reps: string }>;
  when_to_see_doctor: string;
  recovery_timeline: string;
}

export interface VideoFeedback {
  success: boolean;
  sessionId: string | null;
  phases?: Array<{ timestamp: string; summary: string }>;
  feedback: {
    summary: string;
    overall_score: number;
    corrections: Array<{
      timestamp: string;
      category: "form" | "rom" | "pain";
      issue: string;
      correction: string;
      priority: "high" | "medium" | "low";
      thumbnail_url?: string | null;
    }>;
    encouragement: string;
    phase_notes?: string | null;
  };
}

export async function analyzeInjury(
  imageFile: File,
  userId?: string
): Promise<InjuryAnalysis> {
  const formData = new FormData();
  formData.append("image", imageFile);
  if (userId) formData.append("userId", userId);

  const res = await fetch(`${API_URL}/api/analyze-injury`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to analyze injury");
  }

  return res.json();
}

export async function analyzeVideo(
  videoFile: File,
  opts: {
    userId?: string;
    injuryProfileId?: string;
    injuryType?: string;
    exerciseName?: string;
  } = {},
  onProgress?: (message: string) => void
): Promise<VideoFeedback> {
  const formData = new FormData();
  formData.append("video", videoFile);
  if (opts.userId) formData.append("userId", opts.userId);
  if (opts.injuryProfileId) formData.append("injuryProfileId", opts.injuryProfileId);
  if (opts.injuryType) formData.append("injuryType", opts.injuryType);
  if (opts.exerciseName) formData.append("exerciseName", opts.exerciseName);

  const res = await fetch(`${API_URL}/api/analyze-video`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to analyze video");
  }

  // Read SSE stream — route sends progress events then a final result event
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: VideoFeedback | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep any incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "progress" && onProgress) {
          onProgress(event.message);
        } else if (event.type === "result") {
          result = {
            success: true,
            sessionId: event.sessionId ?? null,
            phases: event.phases,
            feedback: event.feedback,
          };
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      } catch {
        // ignore malformed SSE lines
      }
    }
  }

  if (!result) throw new Error("No result received from video analysis");
  return result;
}

export interface BatchVideoFeedback {
  comparison_summary: string;
  videos: Array<VideoFeedback["feedback"] & { corrections: VideoFeedback["feedback"]["corrections"] }>;
}

export async function analyzeVideosBatch(
  videoFiles: File[],
  opts: {
    userId?: string;
    injuryProfileId?: string;
    injuryType?: string;
    exerciseName?: string;
  } = {},
  onProgress?: (message: string) => void
): Promise<{ feedback: BatchVideoFeedback; videoUrls: string[]; batchViewerUrl?: string }> {
  const formData = new FormData();
  for (const f of videoFiles) formData.append("videos", f);
  if (opts.userId) formData.append("userId", opts.userId);
  if (opts.injuryProfileId) formData.append("injuryProfileId", opts.injuryProfileId);
  if (opts.injuryType) formData.append("injuryType", opts.injuryType);
  if (opts.exerciseName) formData.append("exerciseName", opts.exerciseName);

  const res = await fetch(`${API_URL}/api/analyze-videos-batch`, { method: "POST", body: formData });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Batch analysis failed"); }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { feedback: BatchVideoFeedback; videoUrls: string[]; batchViewerUrl?: string } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "progress" && onProgress) onProgress(event.message);
        else if (event.type === "result") result = { feedback: event.feedback, videoUrls: event.videoUrls, batchViewerUrl: event.batchMetadata?.batch_viewer_url };
        else if (event.type === "error") throw new Error(event.message);
      } catch { /* ignore parse errors */ }
    }
  }

  if (!result) throw new Error("No result from batch analysis");
  return result;
}

export async function sendChatMessage(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  injuryContext?: InjuryAnalysis | null,
  userId?: string
): Promise<{ message: string; exportData?: unknown; toolsUsed?: string[] }> {
  const res = await fetch(`${API_URL}/api/chat-with-tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, injuryContext, userId }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to send message");
  }

  return res.json();
}

export async function exportSession(opts: {
  injuryData?: InjuryAnalysis | null;
  exerciseSessions?: Array<{
    exercise_name?: string;
    overall_score?: number;
    feedback_summary?: string;
    created_at?: string;
  }>;
  conversation?: Array<{ role: string; content: string }>;
  userId?: string;
  injuryProfileId?: string;
}): Promise<void> {
  const res = await fetch(`${API_URL}/api/export-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to export session");
  }

  // Trigger browser download
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `recover-session-${Date.now()}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Chat persistence ──────────────────────────────────────────────────────────

export interface SavedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata: {
    attachments?: Array<{ type: "image" | "video"; url: string; name: string }>;
    injuryCard?: InjuryAnalysis;
    videoScore?: number;
    videoCorrections?: unknown[];
    videoPhases?: unknown[];
    multiviewInsight?: string;
    multiviewViews?: string[];
    isError?: boolean;
  };
  created_at: string;
}

export async function createThread(userId: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/chat/thread`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error("Failed to create thread");
  const { threadId } = await res.json();
  return threadId;
}

export async function loadThreadMessages(threadId: string): Promise<SavedMessage[]> {
  const res = await fetch(`${API_URL}/api/chat/${threadId}/messages`);
  if (!res.ok) return [];
  const { messages } = await res.json();
  return messages ?? [];
}

export async function saveMessage(
  threadId: string,
  userId: string,
  msg: { role: "user" | "assistant"; content: string; metadata?: Record<string, unknown> }
): Promise<void> {
  await fetch(`${API_URL}/api/chat/${threadId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, ...msg }),
  });
}

export interface ProgressSummary {
  hasProgress: boolean;
  sessionCount: number;
  firstScore?: number;
  latestScore?: number;
  scoreDelta?: number;
  scoreTrend?: Array<{ date: string; score: number | null; exercise: string; sessionId: string; videoId?: string }>;
  narrative?: string;
  exerciseName?: string | null;
  message?: string;
}

export async function getProgressSummary(opts: {
  injuryProfileId?: string;
  exerciseName?: string;
  userId?: string;
}): Promise<ProgressSummary> {
  const params = new URLSearchParams();
  if (opts.injuryProfileId) params.set("injuryProfileId", opts.injuryProfileId);
  if (opts.exerciseName) params.set("exerciseName", opts.exerciseName);
  if (opts.userId) params.set("userId", opts.userId);

  const res = await fetch(`${API_URL}/api/progress-summary?${params}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to fetch progress");
  }
  return res.json();
}

export async function sendReminder(opts: {
  email: string;
  userId?: string;
  injuryProfileId?: string;
  injuryType?: string;
  exercisePlan?: Array<{ name: string; description: string; reps: string }>;
  reminderType?: string;
}): Promise<void> {
  const res = await fetch(`${API_URL}/api/send-reminder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to send reminder");
  }
}
