from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import os
import io
import json
import time
import base64
import tempfile
import httpx
import av
import anthropic
from PIL import Image
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Recover Video Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_claude():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY environment variable is not set")
    return anthropic.Anthropic(api_key=key)


# ── Models ────────────────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    video_url: str
    injury_type: Optional[str] = None
    exercise_name: Optional[str] = None
    session_id: Optional[str] = None


class MultiviewRequest(BaseModel):
    views: List[Dict[str, str]]   # [{"view_key": "FRONT", "video_url": "..."}, ...]
    injury_type: Optional[str] = None
    exercise_name: Optional[str] = None


# ── Frame extraction ──────────────────────────────────────────────────────────

def extract_frames(video_url: str, max_frames: int = 8) -> List[tuple]:
    """Download video and extract evenly-spaced frames using PyAV (no system ffmpeg needed)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = os.path.join(tmpdir, "video.mp4")

        with httpx.Client(timeout=60, follow_redirects=True) as http:
            r = http.get(video_url)
            r.raise_for_status()
            with open(video_path, "wb") as f:
                f.write(r.content)

        frames_b64: List[tuple] = []
        with av.open(video_path) as container:
            stream = container.streams.video[0]
            stream.codec_context.skip_frame = "NONKEY"  # faster seek

            total = stream.frames or 0
            time_base = float(stream.time_base) if stream.time_base else 1/30
            duration = float(stream.duration * time_base) if stream.duration else 30.0

            # Collect frames by decoding and sampling every N-th frame
            collected = []
            for frame in container.decode(video=0):
                collected.append(frame)

            if not collected:
                raise ValueError("No frames decoded from video")

            step = max(1, len(collected) // max_frames)
            sampled = collected[::step][:max_frames]

            for frame in sampled:
                img = frame.to_image()  # PIL Image
                # Resize to max width 768
                w, h = img.size
                if w > 768:
                    img = img.resize((768, int(h * 768 / w)), Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=85)
                b64 = base64.standard_b64encode(buf.getvalue()).decode()
                ts = _fmt_ts(float(frame.pts or 0) * time_base)
                frames_b64.append((ts, b64))

        return frames_b64


def _fmt_ts(seconds: float) -> str:
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m}:{s:02d}"


# ── Claude analysis ───────────────────────────────────────────────────────────

ANALYSIS_PROMPT = """You are an expert physical therapist analyzing exercise video frames.

Exercise: {exercise}
Injury / condition: {injury}

I'm showing you {n} frames sampled evenly through the video.
Each frame is labeled with its approximate timestamp.

Analyze the patient's movement quality and return ONLY valid JSON with this structure:
{{
  "overall_score": <integer 0-100>,
  "phases": [
    {{"timestamp": "0:00", "summary": "brief description of this movement phase"}}
  ],
  "form_events": [
    {{"timestamp": "0:05", "summary": "specific form issue", "category": "form"}}
  ],
  "rom_events": [
    {{"timestamp": "0:10", "summary": "range of motion observation", "category": "rom"}}
  ],
  "pain_events": [
    {{"timestamp": "0:15", "summary": "compensation or guarding pattern", "category": "pain"}}
  ]
}}

Rules:
- overall_score: 100 = perfect form, 70 = good with minor issues, 50 = multiple corrections needed
- phases: 2-4 entries describing the movement arc (e.g. setup, active phase, return)
- form_events: posture, alignment, joint position errors (0 if none seen)
- rom_events: incomplete range, excessive depth, restricted mobility (0 if none seen)
- pain_events: compensatory patterns, asymmetry, guarding (0 if none seen)
- Use the frame timestamps for timing
- Be specific and clinical — this guides real patient rehab
- Return ONLY the JSON object, no markdown, no explanation"""


def analyze_frames_with_claude(
    frames: List[tuple],   # [(timestamp, base64_jpeg), ...]
    exercise: str,
    injury: str,
) -> dict:
    content: List[dict] = []
    for ts, b64 in frames:
        content.append({"type": "text", "text": f"[{ts}]"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
        })

    content.append({
        "type": "text",
        "text": ANALYSIS_PROMPT.format(exercise=exercise, injury=injury, n=len(frames)),
    })

    msg = get_claude().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1500,
        messages=[{"role": "user", "content": content}],
    )

    raw = msg.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


def _normalize(events: List[dict], category: str) -> List[dict]:
    return [
        {
            "timestamp": e.get("timestamp", ""),
            "summary": e.get("summary", ""),
            "category": category,
            "confidence": "",
            "thumbnail_url": "",
        }
        for e in events
    ]


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    issues = []
    if not os.environ.get("ANTHROPIC_API_KEY"):
        issues.append("ANTHROPIC_API_KEY not set")
    return {"status": "ok" if not issues else "degraded", "issues": issues}


@app.post("/analyze")
def analyze_video(req: AnalyzeRequest):
    exercise = req.exercise_name or "rehabilitation exercise"
    injury   = req.injury_type   or "injury"

    print(f"[Claude] Extracting frames from video…")
    try:
        frames = extract_frames(req.video_url, max_frames=8)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Frame extraction failed: {e}")

    print(f"[Claude] Analyzing {len(frames)} frames with claude-opus-4-6…")
    try:
        result = analyze_frames_with_claude(frames, exercise, injury)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Claude analysis failed: {e}")

    phases      = _normalize(result.get("phases",      []), "phase")
    form_events = _normalize(result.get("form_events", []), "form")
    rom_events  = _normalize(result.get("rom_events",  []), "rom")
    pain_events = _normalize(result.get("pain_events", []), "pain")
    all_events  = sorted(form_events + rom_events + pain_events,
                         key=lambda e: str(e.get("timestamp", "")))

    print(f"[Claude] Done — score={result.get('overall_score')} events={len(all_events)}")
    return {
        "type":         "result",
        "video_id":     f"claude-{int(time.time())}",
        "status":       "completed",
        "overall_score": result.get("overall_score", 70),
        "phases":       phases,
        "form_events":  form_events,
        "rom_events":   rom_events,
        "pain_events":  pain_events,
        "all_events":   all_events,
    }


@app.post("/analyze-multiview")
def analyze_multiview(req: MultiviewRequest):
    """Analyze multiple camera angles and combine the findings."""
    if len(req.views) < 2:
        raise HTTPException(status_code=400, detail="Provide at least 2 views")

    exercise = req.exercise_name or "rehabilitation exercise"
    injury   = req.injury_type   or "injury"

    all_form, all_rom, all_pain, all_phases = [], [], [], []
    scores = []

    for view in req.views:
        key = view["view_key"]
        url = view["video_url"]
        print(f"[Claude] Extracting frames for {key} view…")
        try:
            frames = extract_frames(url, max_frames=6)
            result = analyze_frames_with_claude(frames, exercise, injury)
        except Exception as e:
            print(f"[Claude] {key} view failed: {e}")
            continue

        scores.append(result.get("overall_score", 70))
        for ev in _normalize(result.get("form_events", []), "form"):
            ev["view_key"] = key
            all_form.append(ev)
        for ev in _normalize(result.get("rom_events", []), "rom"):
            ev["view_key"] = key
            all_rom.append(ev)
        for ev in _normalize(result.get("pain_events", []), "pain"):
            ev["view_key"] = key
            all_pain.append(ev)
        all_phases.extend(_normalize(result.get("phases", []), "phase"))

    all_events = sorted(all_form + all_rom + all_pain,
                        key=lambda e: str(e.get("timestamp", "")))

    return {
        "status":       "completed",
        "view_count":   len(req.views),
        "views":        [v["view_key"] for v in req.views],
        "fusion_method": "claude-multiview",
        "overall_score": int(sum(scores) / len(scores)) if scores else 70,
        "phases":       all_phases,
        "form_events":  all_form,
        "rom_events":   all_rom,
        "pain_events":  all_pain,
        "all_events":   all_events,
    }
