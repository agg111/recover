"use client";
import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { supabaseClient as supabase } from '@/lib/supabase-client';
import { ArrowLeft, Send, Paperclip, Image, Video, X, Bot, User, AlertCircle, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { uploadFile, streamAgent, exportSession, InjuryAnalysis, ProgressSummary, createThread, loadThreadMessages, saveMessage, SavedMessage } from '@/lib/api-client';

// Conversation stages
type Stage =
  | 'initial'           // waiting for photo or description
  | 'injury_analyzed'   // showed brief injury summary, waiting for video
  | 'video_analyzed'    // showed form feedback, asking about reminders
  | 'waiting_for_email' // user said yes to reminders, collecting email
  | 'complete';         // all done

interface Attachment {
  id: string;
  file: File;
  preview: string;
  type: 'image' | 'video' | 'file';
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  attachmentUrls?: Array<{ type: 'image' | 'video'; url: string; name: string }>;
  timestamp: Date;
  // Structured data cards
  injuryCard?: InjuryAnalysis;
  videoCorrections?: Array<{ timestamp: string; category?: string; view_key?: string; issue: string; correction: string; priority: string; thumbnail_url?: string | null }>;
  multiviewInsight?: string;
  multiviewViews?: string[];
  videoScore?: number;
  videoBlobUrl?: string;
  videoPhases?: Array<{ timestamp: string; summary: string }>;
  batchViewerUrl?: string;
  progressCard?: ProgressSummary;
  isError?: boolean;
}

function parseTimestamp(ts: string): number {
  if (!ts) return NaN;
  if (ts.includes(':')) {
    const parts = ts.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  return parseFloat(ts.replace('s', ''));
}

function PhaseTimeline({ phases }: { phases: Array<{ timestamp: string; summary: string }> }) {
  const colors = [
    'bg-violet-400', 'bg-blue-400', 'bg-cyan-400',
    'bg-teal-400', 'bg-green-400', 'bg-amber-400', 'bg-orange-400', 'bg-rose-400',
  ];
  return (
    <div className="mb-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
        Exercise phases ({phases.length})
      </p>
      <div className="flex rounded-full overflow-hidden h-3 gap-px">
        {phases.map((p, i) => (
          <div
            key={i}
            className={cn('flex-1 cursor-default', colors[i % colors.length])}
            title={`[${p.timestamp}] ${p.summary || `Phase ${i + 1}`}`}
          />
        ))}
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-[9px] text-muted-foreground">{phases[0]?.timestamp}</span>
        <span className="text-[9px] text-muted-foreground">{phases[phases.length - 1]?.timestamp}</span>
      </div>
    </div>
  );
}

function IssueSummary({ corrections }: { corrections: Array<{ category?: string; priority: string }> }) {
  const form  = corrections.filter(c => c.category === 'form').length;
  const rom   = corrections.filter(c => c.category === 'rom').length;
  const pain  = corrections.filter(c => c.category === 'pain').length;
  const high  = corrections.filter(c => c.priority === 'high').length;
  if (corrections.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {form  > 0 && <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium">Form ×{form}</span>}
      {rom   > 0 && <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-100 dark:bg-teal-900 text-teal-700 dark:text-teal-300 font-medium">Range of Motion ×{rom}</span>}
      {pain  > 0 && <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 font-medium">Compensation ×{pain}</span>}
      {high  > 0 && <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 font-medium">⚠ {high} high priority</span>}
    </div>
  );
}

function VideoFrame({ src, timestamp }: { src: string; timestamp: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const secs = parseTimestamp(timestamp);
    if (isNaN(secs)) return;

    const capture = () => {
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 180;
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      setReady(true);
    };

    video.currentTime = secs;
    video.addEventListener('seeked', capture, { once: true });
    return () => video.removeEventListener('seeked', capture);
  }, [src, timestamp]);

  return (
    <div className="rounded overflow-hidden mb-1.5 bg-muted">
      <video ref={videoRef} src={src} preload="auto" muted className="hidden" />
      {!ready && <div className="h-20 animate-pulse bg-muted-foreground/10" />}
      <canvas ref={canvasRef} className={cn('w-full', !ready && 'hidden')} />
      <p className="text-[10px] text-center opacity-50 py-0.5">{timestamp}</p>
    </div>
  );
}

function ProgressCard({ progress }: { progress: ProgressSummary }) {
  if (!progress.hasProgress || !progress.scoreTrend) return null;
  const delta = progress.scoreDelta ?? 0;
  const deltaColor = delta > 0 ? 'text-green-500' : delta < 0 ? 'text-red-400' : 'text-muted-foreground';
  const deltaSign = delta > 0 ? '+' : '';
  const max = Math.max(...progress.scoreTrend.map(s => s.score ?? 0), 100);

  return (
    <div className="mt-3 rounded-xl border border-border bg-muted/40 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Progress — {progress.exerciseName} ({progress.sessionCount} sessions)
      </p>

      {/* Score sparkline */}
      <div className="flex items-end gap-1 h-10 mb-2">
        {progress.scoreTrend.map((s, i) => {
          const pct = ((s.score ?? 0) / max) * 100;
          const isLast = i === progress.scoreTrend!.length - 1;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={`${new Date(s.date).toLocaleDateString()}: ${s.score ?? '?'}/100`}>
              <div
                className={cn('w-full rounded-sm', isLast ? 'bg-violet-500' : 'bg-violet-200 dark:bg-violet-800')}
                style={{ height: `${Math.max(pct, 8)}%` }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">
          {progress.firstScore} → {progress.latestScore}
          <span className={cn('ml-1 font-semibold', deltaColor)}>
            ({deltaSign}{delta} pts)
          </span>
        </span>
      </div>

      {progress.narrative && (
        <p className="text-xs text-foreground leading-relaxed">{progress.narrative}</p>
      )}
    </div>
  );
}

function savedToMessages(saved: SavedMessage[]): Message[] {
  return [
    WELCOME_MESSAGE,
    ...saved.map((s): Message => ({
      id: s.id,
      role: s.role as 'user' | 'assistant',
      content: s.content,
      timestamp: new Date(s.created_at),
      attachmentUrls: s.metadata?.attachments,
      injuryCard: s.metadata?.injuryCard,
      videoScore: s.metadata?.videoScore as number | undefined,
      videoCorrections: s.metadata?.videoCorrections as Message['videoCorrections'],
      videoPhases: s.metadata?.videoPhases as Message['videoPhases'],
      multiviewInsight: s.metadata?.multiviewInsight,
      multiviewViews: s.metadata?.multiviewViews,
      isError: s.metadata?.isError,
    })),
  ];
}

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content: "Hi! I'm here to help with your recovery. Share a photo of your injury or describe what happened and I'll guide you through healing. 💪",
  timestamp: new Date(0),
};


const MAX_MESSAGES = 20;
const MAX_IMAGES = 5;
const MAX_VIDEOS = 3;
const MAX_IMAGE_MB = 5;
const MAX_VIDEO_MB = 20;
const MAX_CHARS = 1000;

const Chat = () => {
  const [stage, setStage] = useState<Stage>('initial');
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [progressStatus, setProgressStatus] = useState<string | null>(null);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [injuryContext, setInjuryContext] = useState<InjuryAnalysis | null>(null);
  const [exerciseSessions, setExerciseSessions] = useState<Array<{ overall_score?: number; feedback_summary?: string; created_at?: string }>>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [userId, setUserId] = useState<string>('');
  const [threadId, setThreadId] = useState<string | null>(null);
  // Refs so async callbacks always see the latest values (avoids stale closure)
  const threadIdRef = useRef<string | null>(null);
  const userIdRef = useRef<string>('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Derived limits — computed from persisted messages
  const userMsgCount = messages.filter(m => m.role === 'user').length;
  const imageCount = messages.reduce((n, m) => n + (m.attachmentUrls?.filter(a => a.type === 'image').length ?? 0), 0);
  const videoCount = messages.reduce((n, m) => n + (m.attachmentUrls?.filter(a => a.type === 'video').length ?? 0), 0);
  const atMessageLimit = userMsgCount >= MAX_MESSAGES;
  const atImageLimit = imageCount >= MAX_IMAGES;
  const atVideoLimit = videoCount >= MAX_VIDEOS;

  // Init: get auth user, then load or create their thread
  useEffect(() => {
    async function initThread() {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const uid = user.id;
        setUserId(uid);
        userIdRef.current = uid;

        const params = new URLSearchParams(window.location.search);
        const isNew = params.get('new') === '1';
        const threadParam = params.get('thread');
        const storageKey = `recover_thread_${uid}`;

        let tid: string;
        if (isNew) {
          // Always create a fresh thread
          tid = await createThread(uid);
          localStorage.setItem(storageKey, tid);
          // Clean up URL param without reload
          window.history.replaceState({}, '', '/chat');
        } else if (threadParam) {
          // Load a specific past thread
          tid = threadParam;
          localStorage.setItem(storageKey, tid);
          window.history.replaceState({}, '', '/chat');
        } else {
          // Resume last thread or create one
          tid = localStorage.getItem(storageKey) ?? await createThread(uid);
          localStorage.setItem(storageKey, tid);
        }

        setThreadId(tid);
        threadIdRef.current = tid;

        const saved = await loadThreadMessages(tid);
        if (saved.length === 0) return;
        setMessages(savedToMessages(saved));
        // Restore injury context from last injury card
        const lastInjury = [...saved].reverse().find(m => m.metadata?.injuryCard);
        if (lastInjury) {
          setInjuryContext(lastInjury.metadata.injuryCard as InjuryAnalysis);
          setStage('injury_analyzed');
        }
        // Restore exercise sessions
        const sessions = saved
          .filter(m => m.metadata?.videoScore !== undefined)
          .map(m => ({ overall_score: m.metadata.videoScore as number, feedback_summary: m.content, created_at: m.created_at }));
        if (sessions.length > 0) setExerciseSessions(sessions);
      } catch (e) {
        console.error('initThread error:', e);
      }
    }
    initThread();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const autoResize = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  };

  const addBot = (content: string, extras: Partial<Message> = {}) => {
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
      timestamp: new Date(),
      ...extras,
    }]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setFileError(null);
    const newAttachments: Attachment[] = [];

    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      const limitMB = isImage ? MAX_IMAGE_MB : MAX_VIDEO_MB;
      if (file.size > limitMB * 1024 * 1024) {
        setFileError(`"${file.name}" exceeds the ${limitMB} MB limit.`);
        continue;
      }
      newAttachments.push({
        id: crypto.randomUUID(),
        file,
        preview: isImage || isVideo ? URL.createObjectURL(file) : '',
        type: isImage ? 'image' : isVideo ? 'video' : 'file',
      });
    }

    setAttachments((prev) => [...prev, ...newAttachments]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.preview) URL.revokeObjectURL(att.preview);
      return prev.filter((a) => a.id !== id);
    });
  };

  const sendMessage = async (overrideText?: string) => {
    const currentInput = overrideText ?? input.trim();
    if (!currentInput && attachments.length === 0) return;
    const currentAttachments = [...attachments];

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: currentInput,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    if (!overrideText) setInput('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setIsTyping(true);

    // Local blob URLs for video frame capture (not uploaded to server)
    const localBlobUrls: Record<string, string> = {};
    currentAttachments.filter(a => a.type === 'video').forEach(a => {
      localBlobUrls[a.file.name] = URL.createObjectURL(a.file);
    });

    try {
      // Upload files first, build user content with image/video URLs
      const uploadedFiles: Array<{ type: 'image' | 'video'; url: string; name: string }> = [];
      for (const att of currentAttachments) {
        const { url, type } = await uploadFile(att.file);
        uploadedFiles.push({ type, url, name: att.file.name });
      }

      // Build the message content for the agent
      // Images go as vision blocks; video URLs go as text
      const userContent: unknown[] = [];
      for (const f of uploadedFiles) {
        if (f.type === 'image') {
          userContent.push({ type: 'image', source: { type: 'url', url: f.url } });
        } else {
          userContent.push({ type: 'text', text: `Exercise video URL: ${f.url} (filename: ${f.name})` });
        }
      }
      if (currentInput) userContent.push({ type: 'text', text: currentInput });
      if (userContent.length === 0) return;

      // Save user message to Supabase (fire-and-forget)
      if (threadIdRef.current) {
        saveMessage(threadIdRef.current, userIdRef.current, {
          role: 'user',
          content: currentInput,
          metadata: { attachments: uploadedFiles },
        }).catch(console.error);
      }

      // Build history — keep last 10 turns; restore image/video URL blocks for prior messages
      const history: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = messages.slice(-10).map(m => {
        if (m.role === 'user' && m.attachmentUrls && m.attachmentUrls.length > 0) {
          const blocks: unknown[] = m.attachmentUrls.map(a =>
            a.type === 'image'
              ? { type: 'image', source: { type: 'url', url: a.url } }
              : { type: 'text', text: `Exercise video URL: ${a.url} (filename: ${a.name})` }
          );
          if (m.content) blocks.push({ type: 'text', text: m.content });
          return { role: m.role, content: blocks };
        }
        return { role: m.role, content: m.content };
      });
      history.push({ role: 'user', content: userContent.length === 1 && typeof userContent[0] === 'object' && (userContent[0] as { type: string }).type === 'text'
        ? (userContent[0] as { type: string; text: string }).text
        : userContent });

      // Stream agent events
      let currentBotId: string | null = null;
      let currentText = '';
      let toolActive = false; // suppress text while a tool is running
      // Collect bot messages to save after the loop
      const botsToSave: Array<{ content: string; metadata: Record<string, unknown> }> = [];

      for await (const event of streamAgent(history, { userId, injuryContext, threadId })) {
        if (event.type === 'text') {
          if (!event.text?.trim() || toolActive) continue;
          // Accumulate text into a single streaming message
          if (!currentBotId) {
            currentBotId = crypto.randomUUID();
            currentText = event.text;
            const snapId = currentBotId, snapText = currentText;
            setStreamingMsgId(snapId);
            setMessages(prev => [...prev, { id: snapId, role: 'assistant', content: snapText, timestamp: new Date() }]);
          } else {
            currentText += event.text;
            const snapId = currentBotId, snapText = currentText;
            setMessages(prev => prev.map(m => m.id === snapId ? { ...m, content: snapText } : m));
          }

        } else if (event.type === 'tool_start') {
          // Keep any pre-tool text visible; stop cursor and adding more text
          toolActive = true;
          setStreamingMsgId(null);

        } else if (event.type === 'tool_done') {
          // Tools finished — allow Claude's confirmation text to flow through
          toolActive = false;

        } else if (event.type === 'progress') {
          const p = event as unknown as { message?: string };
          if (p.message) setProgressStatus(p.message);

        } else if (event.type === 'injury_card') {
          toolActive = false;
          if (currentBotId && currentText) botsToSave.push({ content: currentText, metadata: {} });
          currentBotId = null; currentText = '';
          setInjuryContext(event.card as InjuryAnalysis);
          setStage('injury_analyzed');
          botsToSave.push({ content: '', metadata: { injuryCard: event.card } });

        } else if (event.type === 'video_card') {
          toolActive = false;
          if (currentBotId && currentText) botsToSave.push({ content: currentText, metadata: {} });
          currentBotId = null; currentText = '';
          const card = event.card as { overall_score: number; summary: string; encouragement: string; corrections: Message['videoCorrections']; phases?: Message['videoPhases']; sessionId?: string; multiview_insight?: string; views?: string[]; isMultiview?: boolean };
          const scoreEmoji = card.overall_score >= 80 ? '🌟' : card.overall_score >= 60 ? '👍' : '💪';
          const viewLabel = card.isMultiview && card.views ? ` (${card.views.join(' + ')})` : '';
          const blobUrl = Object.values(localBlobUrls)[0];
          const videoContent = `${scoreEmoji} **Form score: ${card.overall_score}/100${viewLabel}**\n\n${card.summary}\n\n${card.encouragement}`;
          addBot(videoContent, {
            videoScore: card.overall_score,
            videoCorrections: card.corrections,
            videoPhases: card.phases,
            videoBlobUrl: blobUrl,
            multiviewInsight: card.multiview_insight ?? undefined,
            multiviewViews: card.views,
          });
          botsToSave.push({
            content: videoContent,
            metadata: { videoScore: card.overall_score, videoCorrections: card.corrections, videoPhases: card.phases, multiviewInsight: card.multiview_insight, multiviewViews: card.views },
          });
          setExerciseSessions(prev => [...prev, { overall_score: card.overall_score, feedback_summary: card.summary, created_at: new Date().toISOString() }]);
          setStage('video_analyzed');

        } else if (event.type === 'progress_card') {
          const card = event.card as ProgressSummary;
          setMessages(prev => {
            const lastBot = [...prev].reverse().find(m => m.role === 'assistant');
            if (!lastBot) return prev;
            return prev.map(m => m.id === lastBot.id ? { ...m, progressCard: card } : m);
          });

        } else if (event.type === 'done') {
          toolActive = false;
          if (currentBotId && currentText) {
            botsToSave.push({ content: currentText, metadata: {} });
            currentBotId = null; currentText = '';
          }
          if (event.injuryContext && !injuryContext) setInjuryContext(event.injuryContext as InjuryAnalysis);

        } else if (event.type === 'error') {
          toolActive = false;
          addBot(event.message, { isError: true });
          botsToSave.push({ content: event.message, metadata: { isError: true } });
        }
      }

      // Save all bot messages fire-and-forget
      if (threadIdRef.current) {
        botsToSave.forEach(m =>
          saveMessage(threadIdRef.current!, userIdRef.current, { role: 'assistant', ...m }).catch(console.error)
        );
      }
    } catch {
      addBot("Something went wrong. Please try again.", { isError: true });
    } finally {
      setIsTyping(false);
      setProgressStatus(null);
      setStreamingMsgId(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await exportSession({
        injuryData: injuryContext,
        exerciseSessions,
        conversation: messages.map((m) => ({ role: m.role, content: m.content })),
        userId,
        injuryProfileId: injuryContext?.profileId || undefined,
      });
    } catch {
      // silent
    } finally {
      setIsExporting(false);
    }
  };

  const placeholder = injuryContext
    ? 'Ask a question or upload a video...'
    : 'Describe your injury or upload a photo...';

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="flex items-center gap-3 px-4 h-16">
          <Button variant="ghost" size="icon" onClick={() => window.history.back()} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3 flex-1">
            <div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center">
              <Bot className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-foreground">Recover Assistant</h1>
              <p className="text-xs text-muted-foreground">{isTyping ? 'Analyzing...' : 'Online'}</p>
            </div>
          </div>
          {injuryContext && (
            <Button variant="outline" size="sm" onClick={handleExport} disabled={isExporting} className="gap-1.5 text-xs">
              <Download className="h-3.5 w-3.5" />
              {isExporting ? 'Exporting...' : 'Export for Provider'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => supabase.auth.signOut()}
          >
            Sign out
          </Button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {messages.filter(msg => msg.role === 'user' || msg.content.trim() || msg.injuryCard || msg.videoCorrections || msg.progressCard).map((msg) => (
          <div key={msg.id} className={cn('flex gap-3 max-w-2xl', msg.role === 'user' ? 'ml-auto flex-row-reverse' : '')}>
            <div className={cn(
              'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
              msg.role === 'assistant'
                ? msg.isError ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground'
            )}>
              {msg.role === 'assistant'
                ? msg.isError ? <AlertCircle className="h-4 w-4" /> : <Bot className="h-4 w-4" />
                : <User className="h-4 w-4" />}
            </div>

            <div className="flex flex-col gap-2 max-w-[80%]">
              <div className={cn(
                'rounded-2xl px-4 py-3',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-br-md'
                  : 'bg-muted text-foreground rounded-bl-md'
              )}>
                {msg.attachments?.map((att) =>
                  att.type === 'image' ? (
                    <img key={att.id} src={att.preview} alt="Uploaded" className="rounded-lg max-h-48 max-w-full object-cover mb-2" />
                  ) : att.type === 'video' ? (
                    <video key={att.id} src={att.preview} controls className="rounded-lg max-h-48 max-w-full mb-2" />
                  ) : null
                )}
                {msg.content && (
                  <div className="text-sm leading-relaxed prose prose-sm max-w-none dark:prose-invert [&>p]:mb-2 [&>ul]:mb-2 [&>ul]:ml-4 [&>ul]:list-disc [&>ol]:mb-2 [&>ol]:ml-4 [&>ol]:list-decimal [&>strong]:font-semibold">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                    {msg.id === streamingMsgId && (
                      <span className="inline-block w-[2px] h-[1em] bg-current align-middle ml-0.5 animate-[blink_1s_step-end_infinite]" />
                    )}
                  </div>
                )}
                {msg.timestamp.getTime() !== 0 && (
                  <p suppressHydrationWarning className={cn('text-[10px] mt-1.5', msg.role === 'user' ? 'text-primary-foreground/60' : 'text-muted-foreground')}>
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                )}
              </div>

              {/* Injury detail card — dos/donts/exercises */}
              {msg.injuryCard && (
                <div className="bg-card border border-border rounded-2xl p-4 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-green-50 dark:bg-green-950 rounded-xl p-3">
                      <p className="text-xs font-semibold text-green-700 dark:text-green-300 mb-2">✅ Do&apos;s</p>
                      <ul className="space-y-1">
                        {msg.injuryCard.dos.slice(0, 4).map((item, i) => (
                          <li key={i} className="text-xs text-green-800 dark:text-green-200">• {item}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="bg-red-50 dark:bg-red-950 rounded-xl p-3">
                      <p className="text-xs font-semibold text-red-700 dark:text-red-300 mb-2">❌ Don&apos;ts</p>
                      <ul className="space-y-1">
                        {msg.injuryCard.donts.slice(0, 4).map((item, i) => (
                          <li key={i} className="text-xs text-red-800 dark:text-red-200">• {item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="bg-amber-50 dark:bg-amber-950 rounded-xl p-3">
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1">⚠️ See a doctor if:</p>
                    <p className="text-xs text-amber-800 dark:text-amber-200">{msg.injuryCard.when_to_see_doctor}</p>
                  </div>
                </div>
              )}

              {/* Video analysis card */}
              {msg.videoCorrections && (
                <div className="bg-card border border-border rounded-2xl p-4 space-y-2">
                  {/* Multi-view badge + insight */}
                  {msg.multiviewViews && (
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      {msg.multiviewViews.map(v => (
                        <span key={v} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900 text-violet-700 dark:text-violet-300 font-semibold">{v}</span>
                      ))}
                      <span className="text-[10px] text-muted-foreground">multi-view fused</span>
                    </div>
                  )}
                  {msg.multiviewInsight && (
                    <p className="text-[11px] text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-950 rounded-lg px-3 py-2 mb-1">
                      💡 {msg.multiviewInsight}
                    </p>
                  )}

                  {/* Phase timeline */}
                  {msg.videoPhases && msg.videoPhases.length > 0 && (
                    <PhaseTimeline phases={msg.videoPhases} />
                  )}

                  {/* Issue breakdown pills */}
                  {msg.videoCorrections.length > 0 && (
                    <IssueSummary corrections={msg.videoCorrections} />
                  )}

                  {msg.videoCorrections.length === 0 && (
                    <p className="text-xs text-muted-foreground">No form issues detected — great work!</p>
                  )}

                  {msg.videoCorrections.map((c, i) => (
                    <div key={i} className={cn(
                      'rounded-lg px-3 py-2 text-xs',
                      c.priority === 'high'   ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200' :
                      c.priority === 'medium' ? 'bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200' :
                                                'bg-blue-50 dark:bg-blue-950 text-blue-800 dark:text-blue-200'
                    )}>
                      <div className="flex items-center gap-1.5 mb-1">
                        {c.category && (
                          <span className="uppercase tracking-wide text-[9px] font-bold opacity-60">
                            {c.category === 'rom' ? 'Range of Motion' : c.category}
                          </span>
                        )}
                        {c.view_key && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900 text-violet-600 dark:text-violet-300 font-semibold">
                            {c.view_key}
                          </span>
                        )}
                      </div>
                      {/* Annotated thumbnail from NomadicML — has issue drawn on frame */}
                      {c.thumbnail_url ? (
                        <img src={c.thumbnail_url} alt="Annotated frame" className="rounded w-full max-h-36 object-cover mb-1.5" />
                      ) : msg.videoBlobUrl && c.timestamp && !isNaN(parseTimestamp(c.timestamp)) ? (
                        <VideoFrame src={msg.videoBlobUrl} timestamp={c.timestamp} />
                      ) : null}
                      <p className="font-medium">{c.issue}</p>
                      <p className="mt-0.5 opacity-80">→ {c.correction}</p>
                    </div>
                  ))}

                  {/* Batch viewer link */}
                  {msg.batchViewerUrl && (
                    <a
                      href={msg.batchViewerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-[11px] text-primary hover:underline mt-1"
                    >
                      View full analysis in NomadicML →
                    </a>
                  )}
                </div>
              )}

              {/* Progress trend card */}
              {msg.progressCard && <ProgressCard progress={msg.progressCard} />}
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="flex gap-3 max-w-2xl">
            <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
              <Bot className="h-4 w-4" />
            </div>
            <div className="bg-muted rounded-2xl rounded-bl-md px-4 py-3 flex items-center gap-2">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
              {progressStatus && (
                <span className="text-xs text-muted-foreground">{progressStatus}</span>
              )}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Limit warnings */}
      {atMessageLimit && (
        <div className="mx-4 mb-2 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive text-center">
          You've reached the {MAX_MESSAGES}-message limit for this conversation. Start a new chat to continue.
        </div>
      )}
      {!atMessageLimit && userMsgCount >= MAX_MESSAGES - 5 && (
        <div className="mx-4 mb-2 px-4 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700 text-center">
          {MAX_MESSAGES - userMsgCount} message{MAX_MESSAGES - userMsgCount === 1 ? '' : 's'} remaining in this conversation.
        </div>
      )}
      {fileError && (
        <div className="mx-4 mb-2 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-center justify-between">
          <span>{fileError}</span>
          <button onClick={() => setFileError(null)} className="ml-2 opacity-60 hover:opacity-100"><X className="h-3 w-3" /></button>
        </div>
      )}

      {/* Attachment preview strip */}
      {attachments.length > 0 && (
        <div className="border-t border-border px-4 py-2 flex gap-2 overflow-x-auto">
          {attachments.map((att) => (
            <div key={att.id} className="relative shrink-0">
              {att.type === 'image' ? (
                <img src={att.preview} alt="Preview" className="h-16 w-16 rounded-lg object-cover" />
              ) : (
                <div className="h-16 w-16 rounded-lg bg-muted flex items-center justify-center">
                  <Video className="h-6 w-6 text-muted-foreground" />
                </div>
              )}
              <button
                onClick={() => removeAttachment(att.id)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}


      {/* Input */}
      <div className="border-t border-border bg-background p-4">
        <div className="flex items-end gap-2 max-w-2xl mx-auto">
          <input ref={fileInputRef} type="file" multiple accept="image/*,.heic,.heif,video/*" onChange={handleFileSelect} className="hidden" />
          <Popover open={attachMenuOpen} onOpenChange={setAttachMenuOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0"><Paperclip className="h-5 w-5" /></Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-44 p-1">
              <button
                disabled={atImageLimit}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => { if (fileInputRef.current) { fileInputRef.current.accept = 'image/*'; fileInputRef.current.click(); } setAttachMenuOpen(false); }}
                title={atImageLimit ? `Limit of ${MAX_IMAGES} images per conversation reached` : undefined}
              >
                <Image className="h-4 w-4" /> Upload Image {atImageLimit && `(${MAX_IMAGES}/${MAX_IMAGES})`}
              </button>
              <button
                disabled={atVideoLimit}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => { if (fileInputRef.current) { fileInputRef.current.accept = 'video/*'; fileInputRef.current.click(); } setAttachMenuOpen(false); }}
                title={atVideoLimit ? `Limit of ${MAX_VIDEOS} videos per conversation reached` : undefined}
              >
                <Video className="h-4 w-4" /> Upload Video {atVideoLimit && `(${MAX_VIDEOS}/${MAX_VIDEOS})`}
              </button>
            </PopoverContent>
          </Popover>

          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => { if (e.target.value.length <= MAX_CHARS) { setInput(e.target.value); autoResize(); } }}
              onKeyDown={handleKeyDown}
              placeholder={isTyping ? 'Analysing…' : placeholder}
              disabled={isTyping || atMessageLimit}
              rows={1}
              maxLength={MAX_CHARS}
              className="w-full resize-none bg-muted rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {input.length > MAX_CHARS * 0.8 && (
              <span className="absolute bottom-2 right-3 text-xs text-muted-foreground">{input.length}/{MAX_CHARS}</span>
            )}
          </div>

          <Button
            size="icon"
            onClick={() => sendMessage()}
            disabled={(!input.trim() && attachments.length === 0) || isTyping || atMessageLimit}
            className="shrink-0 rounded-xl"
          >
            <Send className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Chat;
