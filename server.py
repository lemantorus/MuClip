#!/usr/bin/env python3
"""
MuClip — music video scene cutter.
Pipeline: yt-dlp (download) -> ffmpeg (mp3) -> AssemblyAI (word timestamps)
        -> OpenRouter LLM (scenes, no reasoning) -> ffmpeg (hardware-accelerated cuts)
All state lives in store.json. Frontend is static/ (HTML+CSS+JS, no build step).
"""
from __future__ import annotations

import asyncio
import bisect
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# --------------------------------------------------------------------------
# Paths / constants
# --------------------------------------------------------------------------
BASE = Path(__file__).resolve().parent
MEDIA_DIR = BASE / "media"
VIDEOS_DIR = MEDIA_DIR / "videos"
CLIPS_DIR = MEDIA_DIR / "clips"
STATIC_DIR = BASE / "static"
STORE_FILE = BASE / "store.json"

ASSEMBLY_UPLOAD = "https://api.assemblyai.com/v2/upload"
ASSEMBLY_TRANSCRIPT = "https://api.assemblyai.com/v2/transcript"
OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions"

# API keys come from the environment (see .env.example) or from the Settings
# panel in the UI — never hardcode secrets in source.
DEFAULT_SETTINGS = {
    "assembly_key": os.environ.get("MUCLIP_ASSEMBLY_KEY", "").strip(),
    "openrouter_key": os.environ.get("MUCLIP_OPENROUTER_KEY", "").strip(),
    "model": os.environ.get("MUCLIP_MODEL", "deepseek/deepseek-v4-flash-0731"),
    "llm_auto_cut": True,
    "output_dir": "",
}

ENC_PRESETS = {
    "nvenc": ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq",
              "-rc", "vbr", "-cq", "23", "-b:v", "0"],
    "qsv": ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "25"],
    "cpu": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
}

app = FastAPI(title="MuClip")

# --------------------------------------------------------------------------
# Store (JSON)
# --------------------------------------------------------------------------
_lock = threading.Lock()


def _new_store():
    return {"settings": dict(DEFAULT_SETTINGS), "videos": [], "clips": []}


def load_store() -> dict:
    if STORE_FILE.exists():
        try:
            data = json.loads(STORE_FILE.read_text("utf-8"))
            if "settings" not in data:
                data["settings"] = dict(DEFAULT_SETTINGS)
            return data
        except Exception:
            pass
    return _new_store()


STORE = load_store()


def save_store():
    with _lock:
        tmp = STORE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(STORE, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(STORE_FILE)


def video_dir(vid: str) -> Path:
    return VIDEOS_DIR / vid


def get_video(vid: str) -> dict:
    for v in STORE["videos"]:
        if v["id"] == vid:
            return v
    raise HTTPException(404, "video not found")


def get_clip(cid: str) -> dict:
    for c in STORE["clips"]:
        if c["id"] == cid:
            return c
    raise HTTPException(404, "clip not found")


def video_with_extras(v: dict) -> dict:
    """Video record + its clips embedded, so the frontend needs one call."""
    out = {k: v for k, v in v.items()}
    out["clips"] = [c for c in STORE["clips"] if c.get("video_id") == v["id"]]
    return out


# --------------------------------------------------------------------------
# System probe: ffmpeg / yt-dlp / hardware encoders
# --------------------------------------------------------------------------
def _run_sync(cmd, timeout=30):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout + p.stderr
    except Exception as e:
        return -1, str(e)


def _probe_encoder(name: str) -> bool:
    if shutil.which("ffmpeg") is None:
        return False
    rc, _ = _run_sync([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=0.3:size=320x180:rate=30",
        "-frames:v", "5", "-c:v", name, "-pix_fmt", "yuv420p", "-f", "null", "-",
    ])
    return rc == 0


def detect_hardware() -> dict:
    rc, encoders = _run_sync(["ffmpeg", "-hide_banner", "-encoders"])
    fftool = shutil.which("ffmpeg") is not None
    ytdlp = shutil.which("yt-dlp") is not None
    nvenc = fftool and _probe_encoder("h264_nvenc")
    qsv = fftool and _probe_encoder("h264_qsv")
    encoder = "nvenc" if nvenc else ("qsv" if qsv else "cpu")
    ver = ""
    if fftool:
        _, out = _run_sync(["ffmpeg", "-version"])
        ver = out.splitlines()[0].replace("ffmpeg version ", "").split()[0] if out else ""
    return {
        "ffmpeg": fftool,
        "ffmpeg_version": ver,
        "ytdlp": ytdlp,
        "nvenc": nvenc,
        "qsv": qsv,
        "encoder": encoder,
    }


HW = detect_hardware()


# --------------------------------------------------------------------------
# Helpers: async subprocess
# --------------------------------------------------------------------------
async def _run(cmd, timeout=None):
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"timeout: {' '.join(cmd[:5])}...")
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


def _fmt_time(ms: float) -> str:
    s = ms / 1000.0
    return f"{int(s // 60)}:{s % 60:04.1f}"


# --------------------------------------------------------------------------
# Download pipeline
# --------------------------------------------------------------------------
async def yt_dl_info(url: str) -> dict:
    rc, out, err = await _run(["yt-dlp", "-J", "--no-playlist", url], timeout=120)
    if rc != 0:
        raise RuntimeError(f"yt-dlp metadata failed: {err[-400:]}")
    info = json.loads(out)
    return {
        "title": info.get("title") or url,
        "duration": info.get("duration") or 0,
        "thumbnail": info.get("thumbnail"),
    }


async def yt_dl_download(url: str, dest_dir: Path) -> Path:
    rc, _, err = await _run([
        "yt-dlp", "--no-playlist",
        "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format", "mp4",
        "-S", "res:1080",
        "-o", str(dest_dir / "source.%(ext)s"),
        url,
    ], timeout=1200)
    if rc != 0:
        raise RuntimeError(f"yt-dlp download failed: {err[-400:]}")
    files = list(dest_dir.glob("source.*"))
    if not files:
        raise RuntimeError("download produced no file")
    src = files[0]
    if src.suffix != ".mp4":
        # remux into mp4 container so <video> + mp4 muxer always work
        out = dest_dir / "source.mp4"
        rc, _, err = await _run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(src), "-c", "copy", "-movflags", "+faststart", str(out),
        ], timeout=600)
        if rc == 0 and out.exists() and out.stat().st_size > 0:
            src.unlink()
            src = out
    return src


async def extract_mp3(src: Path, dest_dir: Path) -> Path:
    out = dest_dir / "audio.mp3"
    rc, _, err = await _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src), "-vn", "-c:a", "libmp3lame", "-q:a", "2",
        "-ar", "44100", "-ac", "2", str(out),
    ], timeout=900)
    if rc != 0:
        raise RuntimeError(f"audio extraction failed: {err[-400:]}")
    return out


# --------------------------------------------------------------------------
# AssemblyAI transcription (blocking => run in thread)
# --------------------------------------------------------------------------
def _assembly_transcribe_sync(audio_path: Path, key: str) -> dict:
    with open(audio_path, "rb") as f:
        up = requests.post(ASSEMBLY_UPLOAD,
                           headers={"authorization": key,
                                    "content-type": "application/octet-stream"},
                           data=f, timeout=600)
    if up.status_code != 200:
        raise RuntimeError(f"AssemblyAI upload {up.status_code}: {up.text[:300]}")
    upload_url = up.json()["upload_url"]

    tr = requests.post(ASSEMBLY_TRANSCRIPT,
                       headers={"authorization": key, "content-type": "application/json"},
                       json={"audio_url": upload_url, "language_detection": True},
                       timeout=60)
    if tr.status_code != 200:
        raise RuntimeError(f"AssemblyAI submit {tr.status_code}: {tr.text[:300]}")
    tid = tr.json()["id"]

    deadline = time.time() + 30 * 60
    while time.time() < deadline:
        r = requests.get(f"{ASSEMBLY_TRANSCRIPT}/{tid}",
                         headers={"authorization": key}, timeout=60)
        d = r.json()
        status = d.get("status")
        if status == "completed":
            return d
        if status in ("error", "failed"):
            raise RuntimeError(f"AssemblyAI failed: {d.get('error')}")
        time.sleep(2)
    raise RuntimeError("AssemblyAI timeout")


# --------------------------------------------------------------------------
# LLM scene analysis (no reasoning / thinking tokens)
# --------------------------------------------------------------------------
def _llm_scenes_sync(api_key: str, model: str, text: str) -> list[dict]:
    system = (
        "You are a music video scene curator. You receive the full transcript of a "
        "music video (plain text, NO timestamps). Pick 3-8 short moments that sound "
        "best as standalone clips: catchy hooks, drops, iconic lyrics, strong vocals. "
        "Rules:\n"
        "- 'quote' MUST be an exact verbatim contiguous substring of the transcript. "
        "Copy words exactly as they appear, do not paraphrase, do not add or remove "
        "words, max 20 words per quote.\n"
        "- Return ONLY JSON: {\"scenes\":[{\"title\":\"short catchy name\","
        "\"quote\":\"verbatim quote\",\"why\":\"one short reason\"}]}\n"
        "- No thinking, no reasoning, no markdown, no commentary."
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
        "reasoning": {"effort": "none", "exclude": True},
        "temperature": 0.3,
        "max_tokens": 2000,
        "response_format": {"type": "json_object"},
    }
    r = requests.post(OPENROUTER_CHAT,
                      headers={"Authorization": f"Bearer {api_key}",
                               "Content-Type": "application/json"},
                      json=payload, timeout=180)
    if r.status_code != 200:
        raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:300]}")
    content = r.json()["choices"][0]["message"]["content"] or ""
    content = re.sub(r"^```(json)?|```$", "", content.strip(), flags=re.M).strip()
    data = json.loads(content)
    return data.get("scenes", []) or []


def _norm_chars(s: str) -> str:
    return re.sub(r"[^\w\u0400-\u04FF]+", "", s.lower())


# --------------------------------------------------------------------------
# Chat agent (DeepSeek via OpenRouter) — finds moments, suggests timings
# --------------------------------------------------------------------------
CHAT_SYSTEM = (
    "You are MuClip's assistant inside a music-video scene cutter. The user "
    "asks you to find moments in the transcript; you return what they can cut.\n"
    "You receive the full transcript as PLAIN TEXT (no timestamps). To point at a "
    "moment, return a verbatim contiguous substring of that text in 'quote'.\n"
    "Rules:\n"
    "- 'quote' MUST be copied exactly from the transcript (same words, same order, "
    "no paraphrasing, no added/removed words, max 24 words).\n"
    "- 'reply' is a short, friendly answer in the user's language.\n"
    "- 'timings' is a list of 0..8 suggested clips. Each item has a short 'title', "
    "a verbatim 'quote', and a one-line 'why'. You may instead give explicit "
    "'start_ms' and 'end_ms' (milliseconds, end>start, min 200ms) if the user gave "
    "exact times. Do not mix: per item use EITHER quote OR start_ms/end_ms.\n"
    "- Return ONLY JSON: {\"reply\": str, \"timings\": [{\"title\": str, \"quote\": str, "
    "\"start_ms\": int|null, \"end_ms\": int|null, \"why\": str}]}\n"
    "- No thinking, no reasoning, no markdown, no commentary."
)


def _chat_sync(api_key: str, model: str, text: str, message: str,
               history: list[dict]) -> dict:
    msgs = [{"role": "system", "content": CHAT_SYSTEM + "\n\nTRANSCRIPT:\n" + text}]
    for h in (history or [])[-12:]:
        role = h.get("role")
        content = h.get("content")
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": str(content)[:4000]})
    msgs.append({"role": "user", "content": message})
    payload = {
        "model": model,
        "messages": msgs,
        "reasoning": {"effort": "none", "exclude": True},
        "temperature": 0.4,
        "max_tokens": 1800,
        "response_format": {"type": "json_object"},
    }
    r = requests.post(OPENROUTER_CHAT,
                      headers={"Authorization": f"Bearer {api_key}",
                               "Content-Type": "application/json"},
                      json=payload, timeout=180)
    if r.status_code != 200:
        raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:300]}")
    content = r.json()["choices"][0]["message"]["content"] or ""
    content = re.sub(r"^```(json)?|```$", "", content.strip(), flags=re.M).strip()
    data = json.loads(content)
    if not isinstance(data, dict):
        raise RuntimeError("bad chat JSON")
    return data


def _resolve_timings(v: dict, raw: list) -> list[dict]:
    """Map agent quotes -> word ranges + ms; keep explicit ms as-is."""
    out = []
    words = v.get("words") or []
    for s in (raw or []):
        if not isinstance(s, dict):
            continue
        start_ms = s.get("start_ms")
        end_ms = s.get("end_ms")
        quote = (s.get("quote") or "").strip()
        if (start_ms is None or end_ms is None) and quote and words:
            rng = find_quote_range(words, quote)
            if not rng:
                continue
            sw, ew = rng
            start_ms = int(words[sw]["start"])
            end_ms = int(words[ew]["end"])
        elif start_ms is not None and end_ms is not None:
            sw, ew = _nearest_words(v, int(start_ms), int(end_ms))
        else:
            continue
        start_ms = int(start_ms)
        end_ms = int(end_ms)
        if end_ms - start_ms < 200:
            continue
        out.append({
            "title": (s.get("title") or "Clip").strip()[:80],
            "quote": quote[:300],
            "why": (s.get("why") or "").strip()[:300],
            "start_ms": start_ms,
            "end_ms": end_ms,
            "start_word": sw,
            "end_word": ew,
        })
    return out


def find_quote_range(words: list[dict], quote: str) -> Optional[tuple[int, int]]:
    """Find quote (punctuation/space-insensitive) as contiguous word range."""
    tokens = [_norm_chars(w["text"]) for w in words]
    flat = "".join(tokens)
    needle = _norm_chars(quote)
    if not needle or not flat:
        return None
    pos = flat.find(needle)
    if pos < 0:
        return None
    ends = []
    acc = 0
    for i, t in enumerate(tokens):
        acc += len(t)
        ends.append(acc)
    start_word = bisect.bisect_right(ends, pos)
    if start_word >= len(words):
        start_word = len(words) - 1
    end_word = bisect.bisect_left(ends, pos + len(needle))
    if end_word >= len(words):
        end_word = len(words) - 1
    if start_word > end_word:
        return None
    return (start_word, end_word)


# --------------------------------------------------------------------------
# FFmpeg cut (hardware first, CPU fallback)
# --------------------------------------------------------------------------
async def cut_clip_sync(video: dict, clip: dict):
    src = MEDIA_DIR / Path(video["source_path"])
    out = Path(clip["file"])
    out.parent.mkdir(parents=True, exist_ok=True)
    start = clip["start_ms"] / 1000.0
    dur = max((clip["end_ms"] - clip["start_ms"]) / 1000.0, 0.3)
    eff = HW.get("encoder", "cpu")

    def build(enc):
        return [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-i", str(src),
            "-t", f"{dur:.3f}",
            *ENC_PRESETS[enc],
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(out),
        ]

    rc, _, err = await _run(build(eff), timeout=1800)
    if rc != 0 and eff != "cpu":
        eff = "cpu"
        rc, _, err = await _run(build(eff), timeout=1800)
    if rc != 0:
        raise RuntimeError(f"ffmpeg cut failed: {err[-500:]}")
    clip["encoder"] = eff
    clip["status"] = "ready"


async def _cut_task(clip_id: str):
    clip = get_clip(clip_id)
    video = get_video(clip["video_id"])
    try:
        await cut_clip_sync(video, clip)
    except Exception as e:
        clip["status"] = "error"
        clip["error"] = str(e)
        clip["encoder"] = "cpu"
    save_store()


# --------------------------------------------------------------------------
# Default output folder
# --------------------------------------------------------------------------
def resolve_output_dir() -> Optional[Path]:
    """Return the configured default folder (expanded, absolute) or None."""
    raw = (STORE["settings"].get("output_dir") or "").strip()
    if not raw:
        return None
    p = Path(os.path.expanduser(raw))
    if not p.is_absolute():
        p = BASE / p
    return p


def enqueue_cut(clip: dict):
    STORE["clips"].append(clip)
    save_store()
    asyncio.get_running_loop().create_task(_cut_task(clip["id"]))


def _clip_start(v: dict, scene: dict) -> int:
    return int(v["words"][scene["start_word"]]["start"])


def _clip_end(v: dict, scene: dict) -> int:
    return int(v["words"][scene["end_word"]]["end"])


def _quote_text(v: dict, scene: dict) -> str:
    return " ".join(w["text"] for w in v["words"][scene["start_word"]:scene["end_word"] + 1])


# --------------------------------------------------------------------------
# Background pipelines
# --------------------------------------------------------------------------
async def process_video(vid: str):
    v = get_video(vid)
    try:
        v["status"] = "downloading"
        save_store()
        meta = await yt_dl_info(v["url"])
        v["title"] = meta["title"]
        v["duration"] = meta["duration"]
        save_store()
        dirp = video_dir(vid)
        dirp.mkdir(parents=True, exist_ok=True)
        try:
            if meta["thumbnail"]:
                th = requests.get(meta["thumbnail"], timeout=30)
                if th.status_code == 200 and th.content:
                    (dirp / "thumb.jpg").write_bytes(th.content)
                    v["thumbnail"] = str((dirp / "thumb.jpg").relative_to(MEDIA_DIR))
        except Exception:
            pass
        save_store()

        src = await yt_dl_download(v["url"], dirp)
        v["source_path"] = str(src.relative_to(MEDIA_DIR))
        v["relative_path"] = str(src.relative_to(BASE))
        save_store()

        v["status"] = "transcribing"
        save_store()
        audio = await extract_mp3(src, dirp)
        v["audio_path"] = str(audio.relative_to(MEDIA_DIR))

        key = STORE["settings"].get("assembly_key", "").strip()
        if not key:
            raise RuntimeError("AssemblyAI key is empty — set it in Settings")
        res = await asyncio.to_thread(_assembly_transcribe_sync, audio, key)
        words = [
            {"text": (w.get("text") or "").strip(), "start": w["start"], "end": w["end"]}
            for w in res.get("words", [])
        ]
        v["words"] = words
        v["text"] = " ".join(w["text"] for w in words)
        v["status"] = "ready"
        save_store()

        if not words:
            raise RuntimeError("No speech detected — nothing to cut.")

        if STORE["settings"].get("llm_auto_cut"):
            await analyze_video(vid)
    except Exception as e:
        v["status"] = "error"
        v["error"] = str(e)
        save_store()


async def analyze_video(vid: str):
    v = get_video(vid)
    if v.get("status") not in ("ready", "analyzing"):
        raise HTTPException(409, "video is not ready")
    key = STORE["settings"].get("openrouter_key", "").strip()
    if not key:
        v["llm_status"] = "error"
        v["llm_error"] = "OpenRouter key is empty — set it in Settings"
        save_store()
        return
    v["llm_status"] = "analyzing"
    save_store()
    try:
        scenes = await asyncio.to_thread(_llm_scenes_sync, key,
                                         STORE["settings"]["model"], v["text"])
    except Exception as e:
        v["llm_status"] = "error"
        v["llm_error"] = str(e)
        save_store()
        return
    accepted = []
    for s in scenes:
        quote = (s.get("quote") or "").strip()
        rng = find_quote_range(v["words"], quote)
        if not rng:
            continue
        sc = {
            "id": uuid.uuid4().hex[:12],
            "scene_id": None,
            "title": (s.get("title") or "Scene").strip()[:80],
            "why": (s.get("why") or "").strip()[:300],
            "quote": quote[:300],
            "start_word": rng[0],
            "end_word": rng[1],
            "start_ms": _clip_start(v, {"start_word": rng[0]}),
            "end_ms": _clip_end(v, {"end_word": rng[1]}),
        }
        accepted.append(sc)
    v["scenes"] = accepted
    v["llm_status"] = "done"
    save_store()

    if STORE["settings"].get("llm_auto_cut") and accepted:
        for sc in accepted:
            _cut_from_scene(vid, sc)


def _make_clip(v: dict, start_word: int, end_word: int, title: str, scene_id=None,
               start_ms: Optional[int] = None, end_ms: Optional[int] = None) -> dict:
    start_ms = int(v["words"][start_word]["start"]) if start_ms is None else int(start_ms)
    end_ms = int(v["words"][end_word]["end"]) if end_ms is None else int(end_ms)
    clip = {
        "id": uuid.uuid4().hex[:12],
        "video_id": v["id"],
        "title": title or f"Clip {_fmt_time(start_ms)}–{_fmt_time(end_ms)}",
        "start_word": start_word,
        "end_word": end_word,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "quote": _quote_text(v, {"start_word": start_word, "end_word": end_word}),
        "scene_id": scene_id,
        "file": str(CLIPS_DIR / f"{uuid.uuid4().hex[:12]}.mp4"),
        "status": "cutting",
        "encoder": None,
        "error": None,
        "created_at": time.time(),
    }
    enqueue_cut(clip)
    return clip


def _nearest_words(v: dict, start_ms: int, end_ms: int) -> tuple[int, int]:
    """Map an exact time range back to nearest word indices (for display/quote)."""
    n = len(v["words"])
    if n == 0:
        return 0, 0
    starts = [int(w["start"]) for w in v["words"]]
    sw = max(0, min(bisect.bisect_right(starts, start_ms) - 1, n - 1))
    ew = max(0, min(bisect.bisect_right(starts, end_ms) - 1, n - 1))
    if ew < sw:
        ew = sw
    return sw, ew


def _make_clip_ms(v: dict, start_ms: int, end_ms: int, title: str, scene_id=None) -> dict:
    sw, ew = _nearest_words(v, start_ms, end_ms)
    return _make_clip(v, sw, ew, title, scene_id, start_ms=start_ms, end_ms=end_ms)


def _cut_from_scene(vid: str, scene: dict) -> Optional[dict]:
    v = get_video(vid)
    rng = (scene["start_word"], scene["end_word"])
    if any(c.get("scene_id") == scene["id"]
           or (c.get("video_id") == vid
               and (c.get("start_word"), c.get("end_word")) == rng)
           for c in STORE["clips"]):
        return None
    return _make_clip(v, scene["start_word"], scene["end_word"], scene["title"], scene["id"])


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------
class VideoIn(BaseModel):
    url: str


class ClipIn(BaseModel):
    start_word: Optional[int] = None
    end_word: Optional[int] = None
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None
    title: Optional[str] = None


class SceneIn(BaseModel):
    scene_id: str


class ChatIn(BaseModel):
    message: str
    video_id: str
    history: list[dict] = []


class SettingsIn(BaseModel):
    assembly_key: Optional[str] = None
    openrouter_key: Optional[str] = None
    model: Optional[str] = None
    llm_auto_cut: Optional[bool] = None
    output_dir: Optional[str] = None


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/system")
async def system():
    return HW


@app.get("/api/settings")
async def get_settings():
    return STORE["settings"]


@app.put("/api/settings")
async def put_settings(body: SettingsIn):
    s = STORE["settings"]
    for f in ("assembly_key", "openrouter_key", "model", "llm_auto_cut", "output_dir"):
        val = getattr(body, f)
        if val is not None:
            s[f] = val
    save_store()
    return s


@app.post("/api/settings/open-folder")
async def open_folder():
    """Open the configured default folder in the OS file manager."""
    d = resolve_output_dir()
    if d is None:
        raise HTTPException(400, "Default folder is not set — set it in Settings first")
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        raise HTTPException(500, f"cannot create folder: {e}")
    if not d.is_dir():
        raise HTTPException(500, "configured path is not a folder")
    import platform

    sysname = platform.system()
    if sysname == "Windows":
        cmd = ["explorer", str(d)]
    elif sysname == "Darwin":
        cmd = ["open", str(d)]
    else:
        cmd = ["xdg-open", str(d)]
    rc, _ = _run_sync(cmd, timeout=15)
    if rc != 0:
        raise HTTPException(500, "could not open folder — no file manager available")
    return {"ok": True, "path": str(d)}


@app.post("/api/videos")
async def add_video(body: VideoIn):
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL must start with http(s)://")
    if not HW.get("ytdlp"):
        raise HTTPException(500, "yt-dlp is not installed / not in PATH")
    vid = uuid.uuid4().hex[:12]
    dirp = video_dir(vid)
    dirp.mkdir(parents=True, exist_ok=True)
    v = {
        "id": vid,
        "url": url,
        "title": "…",
        "status": "queued",
        "error": None,
        "duration": 0,
        "thumbnail": None,
        "words": [],
        "text": "",
        "scenes": [],
        "llm_status": "idle",
        "llm_error": None,
        "source_path": None,
        "audio_path": None,
        "created_at": time.time(),
    }
    STORE["videos"].insert(0, v)
    save_store()
    asyncio.get_running_loop().create_task(process_video(vid))
    return {"id": vid}


@app.get("/api/videos")
async def list_videos():
    return [video_with_extras(v) for v in STORE["videos"]]


@app.get("/api/videos/{vid}")
async def get_video_api(vid: str):
    return video_with_extras(get_video(vid))


@app.delete("/api/videos/{vid}")
async def delete_video(vid: str):
    v = get_video(vid)
    for c in [c for c in STORE["clips"] if c["video_id"] == vid]:
        _rm_clip_record(c)
    STORE["videos"].remove(v)
    save_store()
    dirp = video_dir(vid)
    if dirp.exists():
        shutil.rmtree(dirp, ignore_errors=True)
    return {"ok": True}


@app.post("/api/videos/{vid}/analyze")
async def analyze(vid: str):
    v = get_video(vid)
    if v["status"] != "ready":
        raise HTTPException(409, "video is not ready yet")
    asyncio.get_running_loop().create_task(analyze_video(vid))
    return {"ok": True}


@app.post("/api/chat")
async def chat(body: ChatIn):
    v = get_video(body.video_id)
    if v.get("status") != "ready" or not v.get("words"):
        raise HTTPException(409, "video is not ready yet — wait for transcription")
    key = STORE["settings"].get("openrouter_key", "").strip()
    if not key:
        raise HTTPException(400, "OpenRouter key is empty — set it in Settings")
    model = STORE["settings"].get("model") or DEFAULT_SETTINGS["model"]
    text = v.get("text") or " ".join(w["text"] for w in v["words"])
    try:
        data = await asyncio.to_thread(_chat_sync, key, model, text,
                                       body.message, body.history)
    except Exception as e:
        raise HTTPException(500, str(e))
    timings = _resolve_timings(v, data.get("timings") or [])
    return {"reply": str(data.get("reply") or "").strip(),
            "timings": timings}


@app.post("/api/videos/{vid}/clips")
async def add_clip(vid: str, body: ClipIn):
    v = get_video(vid)
    n = len(v["words"])
    if body.start_ms is not None or body.end_ms is not None:
        # exact real-time range (start_ms/end_ms required together)
        if body.start_ms is None or body.end_ms is None:
            raise HTTPException(400, "start_ms and end_ms must be provided together")
        s, e = int(body.start_ms), int(body.end_ms)
        if s < 0 or e - s < 200:
            raise HTTPException(400, "invalid ms range (min 200ms)")
        clip = _make_clip_ms(v, s, e, (body.title or "").strip())
        return clip
    if not (0 <= body.start_word < n and 0 <= body.end_word < n):
        raise HTTPException(400, "word index out of range")
    if body.start_word > body.end_word:
        body.start_word, body.end_word = body.end_word, body.start_word
    clip = _make_clip(v, body.start_word, body.end_word, (body.title or "").strip())
    return clip


@app.post("/api/videos/{vid}/scenes/{scene_id}/cut")
async def cut_scene(vid: str, scene_id: str):
    v = get_video(vid)
    scene = next((s for s in v.get("scenes", []) if s["id"] == scene_id), None)
    if not scene:
        raise HTTPException(404, "scene not found")
    clip = _cut_from_scene(vid, scene)
    return clip or {"skipped": True}


@app.delete("/api/videos/{vid}/scenes/{scene_id}")
async def delete_scene(vid: str, scene_id: str):
    v = get_video(vid)
    before = len(v.get("scenes", []))
    v["scenes"] = [s for s in v.get("scenes", []) if s["id"] != scene_id]
    if len(v["scenes"]) == before:
        raise HTTPException(404, "scene not found")
    save_store()
    return {"ok": True}


def _rm_clip_record(c: dict):
    f = Path(c["file"])
    if f.exists():
        try:
            f.unlink()
        except Exception:
            pass
    if c in STORE["clips"]:
        STORE["clips"].remove(c)


@app.get("/api/clips")
async def list_clips():
    return [c for c in STORE["clips"]]


@app.delete("/api/clips/{cid}")
async def delete_clip(cid: str):
    c = get_clip(cid)
    _rm_clip_record(c)
    save_store()
    return {"ok": True}


# --------------------------------------------------------------------------
# Media streaming with HTTP Range support
# --------------------------------------------------------------------------
def _media_file(path: Path, filepath: Path, request: Request, media_type: str,
                download=False, download_name=None):
    if not filepath.exists():
        raise HTTPException(404, "file not found")
    file_size = filepath.stat().st_size
    range_header = request.headers.get("range")
    start, end, status = 0, file_size - 1, 200
    if range_header:
        m = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if m:
            status = 206
            if m.group(1):
                start = int(m.group(1))
            if m.group(2):
                end = int(m.group(2))
            else:
                end = file_size - 1
            if start > end or start >= file_size:
                return JSONResponse({"error": "range not satisfiable"}, status_code=416,
                                    headers={"Content-Range": f"bytes */{file_size}"})
            end = min(end, file_size - 1)
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
        "Content-Type": media_type,
        "Cache-Control": "no-cache",
    }
    if download:
        fname = download_name or filepath.name
        headers["Content-Disposition"] = f'attachment; filename="{fname}"'
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

    def iterator():
        with open(filepath, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(iterator(), status_code=status, headers=headers)


@app.get("/api/videos/{vid}/stream")
async def stream_video(vid: str, request: Request):
    v = get_video(vid)
    _p = Path(v["source_path"])
    return _media_file(_p, MEDIA_DIR / _p, request, "video/mp4")


@app.get("/api/videos/{vid}/audio")
async def stream_audio(vid: str, request: Request):
    v = get_video(vid)
    _p = Path(v["audio_path"])
    return _media_file(_p, MEDIA_DIR / _p, request, "audio/mpeg")


@app.get("/api/clips/{cid}/stream")
async def stream_clip(cid: str, request: Request):
    c = get_clip(cid)
    _p = Path(c["file"])
    return _media_file(_p, _p, request, "video/mp4")


@app.get("/api/clips/{cid}/download")
async def download_clip(cid: str, request: Request, name: Optional[str] = None):
    c = get_clip(cid)
    _p = Path(c["file"])
    fname = Path(name or _p.name).name or _p.name
    if not fname.lower().endswith(".mp4"):
        fname += ".mp4"
    return _media_file(_p, _p, request, "video/mp4", download=True, download_name=fname)


@app.get("/api/videos/{vid}/download")
async def download_video(vid: str, request: Request, name: Optional[str] = None):
    v = get_video(vid)
    if not v.get("source_path"):
        raise HTTPException(404, "source file not found")
    _p = Path(v["source_path"])
    fname = Path(name or _p.name).name or _p.name
    if not fname.lower().endswith(".mp4"):
        fname += ".mp4"
    return _media_file(_p, MEDIA_DIR / _p, request, "video/mp4", download=True, download_name=fname)


class ClipRangeIn(BaseModel):
    start_word: Optional[int] = None
    end_word: Optional[int] = None
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None


class ClipTitleIn(BaseModel):
    title: str


@app.post("/api/clips/{cid}/title")
async def rename_clip(cid: str, body: ClipTitleIn):
    c = get_clip(cid)
    title = body.title.strip()[:120]
    if not title:
        raise HTTPException(400, "title is empty")
    c["title"] = title
    save_store()
    return c


@app.post("/api/clips/{cid}/range")
async def recut_clip(cid: str, body: ClipRangeIn):
    """Re-cut an existing clip with a new word range or an exact ms range."""
    c = get_clip(cid)
    v = get_video(c["video_id"])
    n = len(v["words"])

    if body.start_ms is not None or body.end_ms is not None:
        # exact real-time range — extend/trim by real seconds & milliseconds
        cur_s = int(c.get("start_ms") or 0)
        cur_e = int(c.get("end_ms") or cur_s)
        s = cur_s if body.start_ms is None else int(body.start_ms)
        e = cur_e if body.end_ms is None else int(body.end_ms)
        if s < 0 or e - s < 200:
            raise HTTPException(400, "invalid ms range (min 200ms)")
        c["start_ms"] = s
        c["end_ms"] = e
        sw, ew = _nearest_words(v, s, e)
        c["start_word"] = sw
        c["end_word"] = ew
        c["quote"] = _quote_text(v, {"start_word": sw, "end_word": ew})
    else:
        if not (0 <= body.start_word < n and 0 <= body.end_word < n):
            raise HTTPException(400, "word index out of range")
        if body.start_word > body.end_word:
            body.start_word, body.end_word = body.end_word, body.start_word
        c["start_word"] = body.start_word
        c["end_word"] = body.end_word
        c["start_ms"] = int(v["words"][body.start_word]["start"])
        c["end_ms"] = int(v["words"][body.end_word]["end"])
        c["quote"] = _quote_text(v, {"start_word": body.start_word, "end_word": body.end_word})

    c["status"] = "cutting"
    c["encoder"] = None
    c["error"] = None
    save_store()
    asyncio.get_running_loop().create_task(_cut_task(c["id"]))
    return c


# --------------------------------------------------------------------------
# Static frontend
# --------------------------------------------------------------------------
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
CLIPS_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# thumbnails etc. (registered before the catch-all "/" mount)
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def main():
    import uvicorn

    host = os.environ.get("MUCLIP_HOST", "127.0.0.1")
    port = int(os.environ.get("MUCLIP_PORT", "8010"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
