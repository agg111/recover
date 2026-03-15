from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import os
import asyncio
import concurrent.futures
import subprocess
import json
import uuid
import time
from dotenv import load_dotenv
from nomadicml import NomadicML
from nomadicml.video import AnalysisType

load_dotenv()

HLS_DIR = "/tmp/recover-hls"
os.makedirs(HLS_DIR, exist_ok=True)

# PUBLIC_VIDEO_SERVICE_URL must be an internet-accessible URL (e.g. ngrok in dev, prod URL in prod)
# NomadicML servers need to pull the HLS stream from this URL
PUBLIC_VIDEO_SERVICE_URL = os.environ.get("PUBLIC_VIDEO_SERVICE_URL", os.environ.get("VIDEO_SERVICE_URL", "http://localhost:8000"))

active_streams: Dict[str, dict] = {}

app = FastAPI(title="Recover Video Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = NomadicML(api_key=os.environ["NOMADICML_API_KEY"])


class AnalyzeRequest(BaseModel):
    video_url: str
    injury_type: Optional[str] = None
    exercise_name: Optional[str] = None
    session_id: Optional[str] = None


class AnalyzeResponse(BaseModel):
    video_id: str
    status: str
    phases: List[Dict[str, Any]]
    form_events: List[Dict[str, Any]]
    rom_events: List[Dict[str, Any]]
    pain_events: List[Dict[str, Any]]
    all_events: List[Dict[str, Any]]


def categorize_events(raw_events: list) -> dict:
    """Split NomadicML events into form/rom/pain buckets by keyword."""
    form_events, rom_events, pain_events = [], [], []
    for event in raw_events:
        text = (event.get("summary", "") + event.get("description", "")).lower()
        norm = {
            "timestamp": event.get("timestamp", event.get("start_time", "")),
            "summary": event.get("summary", event.get("description", "")),
            "confidence": event.get("confidence", ""),
            "thumbnail_url": event.get("annotated_thumbnail_url") or event.get("thumbnail_url", ""),
        }
        if any(w in text for w in ["range", "rom", "depth", "incomplete", "mobility", "extension", "flexion"]):
            rom_events.append({**norm, "category": "rom"})
        elif any(w in text for w in ["compensat", "guard", "asymmetr", "pain", "protect", "hesitat", "shift"]):
            pain_events.append({**norm, "category": "pain"})
        else:
            form_events.append({**norm, "category": "form"})
    return {"form_events": form_events, "rom_events": rom_events, "pain_events": pain_events}


def normalize_events(events: list, category: str) -> list:
    result = []
    for event in events:
        result.append({
            "timestamp": event.get("timestamp", event.get("start_time", "")),
            "summary": event.get("summary", event.get("description", "")),
            "category": category,
            "confidence": event.get("confidence", ""),
            "thumbnail_url": event.get("annotated_thumbnail_url") or event.get("thumbnail_url", ""),
        })
    return result


def run_analysis_safe(video_ids, analysis_type: AnalysisType, label: str, **kwargs) -> dict:
    """Works for a single video_id (str) or a list of video_ids."""
    try:
        print(f"[NomadicML] Starting {label} analysis...")
        result = client.analyze(
            video_ids,
            analysis_type=analysis_type,
            is_thumbnail=True,
            wait_for_completion=True,
            timeout=90,          # 90s per analysis type — 4 run in parallel so overall ~90s max
            **kwargs,
        )
        # Batch returns {"results": [...], "batch_metadata": {...}}
        # Single returns {"events": [...], ...}
        if isinstance(video_ids, list):
            count = len(result.get("results", []))
        else:
            count = len(result.get("events", []))
        print(f"[NomadicML] {label} complete — {count} result(s)")
        return result
    except Exception as e:
        print(f"[NomadicML] {label} failed: {e}")
        return {"events": [], "results": [], "summary": "", "error": str(e)}


@app.get("/health")
def health():
    return {"status": "ok"}


ANALYZE_TIMEOUT = 100  # seconds — hard cap for the whole analysis step

@app.post("/analyze")
def analyze_video(req: AnalyzeRequest):
    """Returns JSON result after full analysis completes, capped at ANALYZE_TIMEOUT seconds."""
    exercise = req.exercise_name or "rehabilitation exercise"

    upload_result = client.upload(req.video_url)
    video_id = upload_result["video_id"]
    print(f"[NomadicML] Uploaded — video_id: {video_id}")

    results: dict = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        future_map = {
            executor.submit(run_analysis_safe, video_id, AnalysisType.ACTION_SEGMENTATION, "segmentation"): "segmentation",
            executor.submit(run_analysis_safe, video_id, AnalysisType.ASK, "form",
                custom_event=f"incorrect form or poor posture during {exercise}",
                use_enhanced_motion_analysis=True): "form",
            executor.submit(run_analysis_safe, video_id, AnalysisType.ASK, "rom",
                custom_event=f"limited range of motion or incomplete movement during {exercise}",
                use_enhanced_motion_analysis=True): "rom",
            executor.submit(run_analysis_safe, video_id, AnalysisType.ASK, "compensation",
                custom_event=f"compensation pattern or asymmetric movement during {exercise}",
                use_enhanced_motion_analysis=True): "compensation",
        }
        done, not_done = concurrent.futures.wait(list(future_map.keys()), timeout=ANALYZE_TIMEOUT)
        if not_done:
            print(f"[NomadicML] {len(not_done)} analysis/analyses timed out after {ANALYZE_TIMEOUT}s — returning partial results")
        for fut in done:
            key = future_map[fut]
            try:
                results[key] = fut.result()
            except Exception as e:
                print(f"[NomadicML] {key} raised: {e}")
                results[key] = {"events": [], "results": []}
        for fut in not_done:
            key = future_map[fut]
            results[key] = {"events": [], "results": []}

    phases      = normalize_events(results["segmentation"].get("events", []), "phase")
    form_events = normalize_events(results["form"].get("events",         []), "form")
    rom_events  = normalize_events(results["rom"].get("events",          []), "rom")
    pain_events = normalize_events(results["compensation"].get("events", []), "pain")
    all_events  = sorted(form_events + rom_events + pain_events, key=lambda e: str(e.get("timestamp", "")))

    return {"type": "result", "video_id": video_id, "status": "completed",
            "phases": phases, "form_events": form_events, "rom_events": rom_events,
            "pain_events": pain_events, "all_events": all_events}


class BatchAnalyzeRequest(BaseModel):
    video_urls: List[str]
    injury_type: Optional[str] = None
    exercise_name: Optional[str] = None


@app.post("/analyze-batch")
def analyze_batch(req: BatchAnalyzeRequest):
    try:
        if len(req.video_urls) < 2:
            raise HTTPException(status_code=400, detail="Provide at least 2 video URLs for batch analysis")

        injury = req.injury_type or "general injury"
        exercise = req.exercise_name or "rehabilitation exercise"

        # Upload all videos in one call
        print(f"[NomadicML] Batch uploading {len(req.video_urls)} videos...")
        upload_results = client.upload(req.video_urls)
        if isinstance(upload_results, dict):
            upload_results = [upload_results]
        video_ids = [r["video_id"] for r in upload_results]
        print(f"[NomadicML] Uploaded {len(video_ids)} videos: {video_ids}")

        comprehensive_prompt = (
            f"Analyze this {exercise} exercise for a patient recovering from {injury}. "
            f"For each issue assign a category: 'form' (posture/alignment/mechanics), "
            f"'rom' (range of motion/depth/completeness), or 'pain' (compensation/guarding/asymmetry). "
            f"Report every issue with its timestamp, description, and category."
        )

        # One batch call per analysis type — NomadicML processes all videos together
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            fut_seg = executor.submit(
                run_analysis_safe,
                video_ids, AnalysisType.ACTION_SEGMENTATION, "batch-segmentation",
            )
            fut_ask = executor.submit(
                run_analysis_safe,
                video_ids, AnalysisType.ASK, "batch-comprehensive",
                custom_event=comprehensive_prompt,
                use_enhanced_motion_analysis=True,
                confidence="low",
            )
            seg_result = fut_seg.result()
            ask_result = fut_ask.result()

        seg_results = seg_result.get("results", [])
        ask_results = ask_result.get("results", [])

        per_video = []
        for i, video_id in enumerate(video_ids):
            seg_r = seg_results[i] if i < len(seg_results) else {}
            ask_r = ask_results[i] if i < len(ask_results) else {}

            phases  = normalize_events(seg_r.get("events", []), "phase")
            buckets = categorize_events(ask_r.get("events", []))
            all_events = sorted(
                buckets["form_events"] + buckets["rom_events"] + buckets["pain_events"],
                key=lambda e: str(e.get("timestamp", "")),
            )

            per_video.append({
                "video_id": video_id,
                "video_url": req.video_urls[i],
                "phases": phases,
                "form_events": buckets["form_events"],
                "rom_events": buckets["rom_events"],
                "pain_events": buckets["pain_events"],
                "all_events": all_events,
            })

        return {
            "status": "completed",
            "video_count": len(video_ids),
            "batch_metadata": ask_result.get("batch_metadata", {}),
            "videos": per_video,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class MultiviewRequest(BaseModel):
    views: List[Dict[str, str]]   # [{"view_key": "FRONT", "video_url": "..."}, ...]
    injury_type: Optional[str] = None
    exercise_name: Optional[str] = None


@app.post("/analyze-multiview")
def analyze_multiview(req: MultiviewRequest):
    """Upload each view's video once, then run analyze_multiview for fused form feedback."""
    if len(req.views) < 2:
        raise HTTPException(status_code=400, detail="Provide at least 2 views for multi-view analysis")

    injury  = req.injury_type   or "general injury"
    exercise = req.exercise_name or "rehabilitation exercise"

    # Upload each video once, build view_dict {VIEW_KEY: [video_id]}
    view_dict: Dict[str, List[str]] = {}
    view_urls:  Dict[str, str]      = {}

    for v in req.views:
        key = v["view_key"].upper()
        url = v["video_url"]
        print(f"[Multiview] Uploading {key} view: {url}")
        upload = client.upload(url)
        video_id = upload["video_id"]
        view_dict[key] = [video_id]
        view_urls[key]  = url
        print(f"[Multiview] {key} → video_id={video_id}")

    # Run segmentation on first view for phases
    first_video_id = list(view_dict.values())[0][0]

    def run_multiview_ask(event_desc: str, label: str) -> dict:
        try:
            return client.analyze_multiview(
                view_dict,
                analysis_type=AnalysisType.ASK,
                custom_event=event_desc,
                is_thumbnail=True,
                use_enhanced_motion_analysis=True,
                wait_for_completion=True,
                timeout=600,
            )
        except Exception as e:
            print(f"[Multiview] {label} fusion failed: {e}, running per-view fallback...")
            # Fallback: per-view individual analyses
            batch_results = []
            for vk, vids in view_dict.items():
                r = run_analysis_safe(vids[0], AnalysisType.ASK, f"{vk}-{label}",
                    custom_event=event_desc, use_enhanced_motion_analysis=True)
                batch_results.append({"view_key": vk, "results": [r]})
            return {"batch_results": batch_results, "fusion_method": "unfused"}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        fut_seg  = executor.submit(run_analysis_safe, first_video_id, AnalysisType.ACTION_SEGMENTATION, "multiview-segmentation")
        fut_form = executor.submit(run_multiview_ask, f"incorrect form or poor posture during {exercise}", "form")
        fut_rom  = executor.submit(run_multiview_ask, f"limited range of motion or incomplete movement during {exercise}", "rom")
        fut_comp = executor.submit(run_multiview_ask, f"compensation pattern or asymmetric movement during {exercise}", "compensation")

        seg_result  = fut_seg.result()
        form_ask    = fut_form.result()
        rom_ask     = fut_rom.result()
        comp_ask    = fut_comp.result()

    phases = normalize_events(seg_result.get("events", []), "phase")

    def extract_events_from_result(ask_result: dict, category: str) -> tuple:
        """Extract events from either fused or unfused multiview result."""
        all_raw: List[Dict] = []
        per_view: Dict[str, List[Dict]] = {}
        fusion = ask_result.get("fusion_method", "unfused")

        if "results" in ask_result:
            fusion = "fused"
            for r in ask_result.get("results", []):
                all_raw.extend(r.get("events", []))
        elif "batch_results" in ask_result:
            for batch in ask_result.get("batch_results", []):
                vk = batch.get("view_key", "UNKNOWN")
                for r in batch.get("results", []):
                    evs = r.get("events", [])
                    per_view.setdefault(vk, []).extend(evs)
                    all_raw.extend(evs)

        events = normalize_events(all_raw, category)
        # Attach view_key
        for vk, evs in per_view.items():
            for src_ev in evs:
                ts = src_ev.get("timestamp", src_ev.get("start_time", ""))
                for ev in events:
                    if ev["timestamp"] == ts and "view_key" not in ev:
                        ev["view_key"] = vk
        return events, per_view, fusion

    form_events,  per_view_form,  form_fusion  = extract_events_from_result(form_ask,  "form")
    rom_events,   per_view_rom,   _            = extract_events_from_result(rom_ask,   "rom")
    pain_events,  per_view_comp,  _            = extract_events_from_result(comp_ask,  "pain")

    # Determine overall fusion method
    fusion_method = form_fusion

    all_events_raw = [e for e in form_events + rom_events + pain_events]
    per_view_events: Dict[str, List[Dict]] = {}
    for src in [per_view_form, per_view_rom, per_view_comp]:
        for vk, evs in src.items():
            per_view_events.setdefault(vk, []).extend(evs)

    all_events = sorted(
        form_events + rom_events + pain_events,
        key=lambda e: str(e.get("timestamp", "")),
    )

    return {
        "status":      "completed",
        "view_count":  len(req.views),
        "views":       [v["view_key"] for v in req.views],
        "fusion_method": fusion_method,
        "phases":      phases,
        "form_events": form_events,
        "rom_events":  rom_events,
        "pain_events": pain_events,
        "all_events":  all_events,
        "per_view_events": per_view_events,
    }


@app.get("/videos")
def list_videos():
    try:
        videos = client.my_videos()
        return {"videos": videos}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Live Stream Analysis ──────────────────────────────────────────────────────

class LiveStreamStartRequest(BaseModel):
    stream_url: str                  # Cloudflared / public HLS URL, e.g. https://xxx.trycloudflare.com/stream.m3u8
    injury_type: Optional[str] = None
    exercise_name: Optional[str] = None


@app.post("/livestream/start")
def start_livestream(req: LiveStreamStartRequest):
    """Register a user-provided HLS URL and start a NomadicML livestream session.

    The caller (user) is responsible for running FFmpeg + HTTP server + cloudflared
    locally to produce the public stream_url. We just forward it to NomadicML.
    """
    stream_id = str(uuid.uuid4())[:8]
    exercise  = req.exercise_name or "rehabilitation exercise"
    injury    = req.injury_type   or "injury"
    # Short event descriptions work best with NomadicML — mirrors the ASK approach
    queries = [
        f"incorrect form or poor posture during {exercise}",
        f"limited range of motion or incomplete movement during {exercise}",
        f"compensation pattern or asymmetric movement during {exercise}",
    ]

    state = {
        "hls_url":        req.stream_url,
        "queries":        queries,
        "exercise":       exercise,
        "nom_stream_id":  None,
        "nom_session_id": None,
        "active":         True,
        "session_started": False,
    }
    active_streams[stream_id] = state

    # Start NomadicML session in background (5s delay lets the first HLS segments arrive)
    t = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    t.submit(_start_nom_session, state, stream_id, delay=3)

    print(f"[Livestream] registered stream_id={stream_id}  hls={req.stream_url}")
    return {
        "stream_id":      stream_id,
        "hls_url":        req.stream_url,
        "nom_stream_id":  "",
        "nom_session_id": "",
        "viewer_url":     "",
    }


def _start_nom_session(state: dict, stream_id: str, delay: int = 0):
    """Start NomadicML session in a background thread, optionally after a delay."""
    if delay:
        time.sleep(delay)
    try:
        print(f"[Livestream] Starting NomadicML session for {stream_id} — url={state['hls_url']}")
        nom = client.livestream.start_session(
            source_url=state["hls_url"],
            name=f"Live: {state['exercise']}",
            rapid_review_query=state["queries"][0],
        )
        print(f"[Livestream] start_session response: {nom}")
        session_id = nom["session_id"]
        # stream_id may or may not be in the response — fall back to session_id
        stream_id  = nom.get("stream_id") or session_id
        state["nom_stream_id"]  = stream_id
        state["nom_session_id"] = session_id
        state["session_started"] = True
        print(f"[Livestream] NomadicML session started — stream={stream_id} session={session_id}")
    except Exception as e:
        print(f"[Livestream] NomadicML start_session failed: {e}")
        state["session_started"] = True  # prevent SSE from waiting forever


@app.get("/livestream/{stream_id}/events")
async def livestream_events(stream_id: str):
    """SSE: poll NomadicML every 10s and forward new events to the browser."""
    state = active_streams.get(stream_id)
    if not state:
        raise HTTPException(status_code=404, detail="Stream not found")

    async def generate():
        # Wait for NomadicML session to be started (triggered after 5th chunk)
        for _ in range(30):
            if state.get("nom_stream_id"):
                break
            await asyncio.sleep(1)
        else:
            yield f"data: {json.dumps({'type': 'error', 'message': 'NomadicML session did not start'})}\n\n"
            return

        nom_stream_id  = state["nom_stream_id"]
        nom_session_id = state["nom_session_id"]
        seen: set = set()

        # Tell the frontend NomadicML is connected
        yield f"data: {json.dumps({'type': 'connected', 'message': 'Analysis ready — start your exercises!'})}\n\n"

        while state.get("active"):
            try:
                session = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: client.livestream.get_session(nom_stream_id, nom_session_id),
                )
                status = session.get("status")
                chunks = session.get("chunk_count", 0)
                events = session.get("events") or []
                print(f"[Livestream] poll — status={status} chunks={chunks} events={len(events)}")
                for ev in events:
                    key = f"{ev.get('type')}_{ev.get('stream_time')}_{ev.get('description','')[:20]}"
                    if key not in seen:
                        seen.add(key)
                        print(f"[Livestream] new event: {ev}")
                        yield f"data: {json.dumps(ev)}\n\n"
            except Exception as exc:
                print(f"[Livestream] poll error: {exc}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            await asyncio.sleep(10)
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/livestream/{stream_id}/stop")
def stop_livestream(stream_id: str):
    """End the ffmpeg process and the NomadicML session; return final events."""
    state = active_streams.pop(stream_id, None)
    if not state:
        raise HTTPException(status_code=404, detail="Stream not found")

    state["active"] = False
    nom_stream_id  = state.get("nom_stream_id")
    nom_session_id = state.get("nom_session_id")

    if not nom_stream_id:
        return {"status": "stopped", "events": [], "message": "Session ended before NomadicML analysis started"}

    try:
        client.livestream.end_session(stream_id=nom_stream_id, session_id=nom_session_id)
        # Wait for NomadicML to finish processing the last chunks
        time.sleep(5)
        final = client.livestream.get_session(nom_stream_id, nom_session_id)
    except Exception as e:
        return {"status": "stopped", "error": str(e), "events": []}

    events = final.get("events", [])
    print(f"[Livestream] stop — {len(events)} total events")
    return {
        "status": final.get("status", "completed"),
        "chunk_count": final.get("chunk_count", 0),
        "events": events,
    }


# Serve HLS segments (must come after all routes)
app.mount("/hls", StaticFiles(directory=HLS_DIR), name="hls")

# Also serve the user's local FFmpeg HLS output at /stream/*
# so NomadicML can reach it via the existing ngrok → Next.js → /stream* rewrite
os.makedirs("/tmp/stream", exist_ok=True)
app.mount("/stream", StaticFiles(directory="/tmp/stream"), name="stream-local")
