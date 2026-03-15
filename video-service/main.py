from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import os
import json
import time
import base64
import tempfile
import subprocess
import httpx
import anthropic
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Recover Video Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

claude = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


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

def extract_frames(video_url: str, max_frames: int = 8) -> List[str]:
    """Download video and extract evenly-spaced frames as base64 JPEGs."""
    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = os.path.join(tmpdir, "video.mp4")

        # Download video
        with httpx.Client(timeout=60, follow_redirects=True) as http:
            r = http.get(video_url)
            r.raise_for_status()
            with open(video_path, "wb") as f:
                f.write(r.content)

        # Get duration
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True
        )
        try:
            duration = float(probe.stdout.strip())
        except ValueError:
            duration = 30.0  # fallback

        # Extract frames at even intervals, scaled to max width 768px
        fps = max_frames / max(duration, 1)
        frames_pattern = os.path.join(tmpdir, "frame_%03d.jpg")
        subprocess.run(
            ["ffmpeg", "-i", video_path, "-vf",
             f"fps={fps:.4f},scale='min(768,iw)':-2", "-q:v", "3",
             "-frames:v", str(max_frames), frames_pattern],
            capture_output=True
        )

        # Read frames sorted
        frame_files = sorted(f for f in os.listdir(tmpdir) if f.startswith("frame_"))
        frames_b64 = []
        interval = duration / max(len(frame_files), 1)
        for i, fname in enumerate(frame_files):
            with open(os.path.join(tmpdir, fname), "rb") as fh:
                b64 = base64.standard_b64encode(fh.read()).decode()
                ts = _fmt_ts(i * interval)
                frames_b64.append((ts, b64))

        return frames_b64  # list of (timestamp_str, base64_jpeg)


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

    msg = claude.messages.create(
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
    return {"status": "ok"}


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
