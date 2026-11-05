"""yt-dlp を使って YouTube の音声を MP3 に変換するジョブ管理。"""
from __future__ import annotations

import re
import shutil
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp

YOUTUBE_HOSTS = (
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
)
URL_RE = re.compile(r"https?://[^\s<>\"']+")
QUALITIES = ("128", "192", "256", "320")
PLAYLIST_LIMIT = 50


def find_ffmpeg() -> str | None:
    """システムの ffmpeg を優先し、無ければ imageio-ffmpeg 同梱版を使う。"""
    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / "bin" / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
        if bundled.is_file():
            return str(bundled)
    sys_ffmpeg = shutil.which("ffmpeg")
    if sys_ffmpeg:
        return sys_ffmpeg
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def find_deno() -> str | None:
    """YouTube の署名解読に必要な JavaScript ランタイム (deno) を探す。"""
    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / "bin" / ("deno.exe" if sys.platform == "win32" else "deno")
        if bundled.is_file():
            return str(bundled)
    try:
        import deno

        path = deno.find_deno_bin()
        if path and Path(path).exists():
            return str(path)
    except Exception:
        pass
    return shutil.which("deno")


def extract_url(text: str, allow_any_site: bool = False) -> str | None:
    """共有テキスト（「タイトル https://youtu.be/xxx」など）から URL を取り出す。"""
    if not text:
        return None
    for m in URL_RE.finditer(text.strip()):
        url = m.group(0).rstrip(").,、。")
        host = (urlparse(url).hostname or "").lower()
        if allow_any_site or host in YOUTUBE_HOSTS:
            return url
    return None


@dataclass
class Job:
    id: str
    url: str
    quality: str
    playlist: bool
    status: str = "queued"  # queued / downloading / converting / done / error
    title: str = ""
    progress: float = 0.0  # 0-100（プレイリストは全体の進み具合）
    speed: str = ""
    eta: str = ""
    message: str = ""
    files: list[str] = field(default_factory=list)
    item_index: int = 0
    item_count: int = 1
    created: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "url": self.url,
            "quality": self.quality,
            "playlist": self.playlist,
            "status": self.status,
            "title": self.title,
            "progress": round(self.progress, 1),
            "speed": self.speed,
            "eta": self.eta,
            "message": self.message,
            "files": list(self.files),
            "item_index": self.item_index,
            "item_count": self.item_count,
            "created": self.created,
        }


class DownloadManager:
    def __init__(self, out_dir: Path, max_workers: int = 2):
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.ffmpeg = find_ffmpeg()
        self.deno = find_deno()
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=max_workers)

    # ---------- 公開 API ----------
    def submit(self, url: str, quality: str, playlist: bool) -> Job:
        if quality not in QUALITIES:
            quality = "192"
        job = Job(id=uuid.uuid4().hex[:12], url=url, quality=quality, playlist=playlist)
        with self.lock:
            self.jobs[job.id] = job
        self.pool.submit(self._run, job)
        return job

    def list_jobs(self) -> list[dict]:
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)
            return [j.to_dict() for j in jobs]

    def remove_job(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.get(job_id)
            if job and job.status in ("done", "error"):
                del self.jobs[job_id]
                return True
        return False

    def library(self) -> list[dict]:
        items = []
        for p in self.out_dir.glob("*.mp3"):
            try:
                st = p.stat()
            except OSError:
                continue
            items.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return items

    # ---------- 内部処理 ----------
    def _ydl_opts(self, job: Job) -> dict:
        def progress_hook(d: dict) -> None:
            info = d.get("info_dict") or {}
            idx = info.get("playlist_index") or 1
            count = info.get("n_entries") or info.get("playlist_count") or 1
            job.item_index, job.item_count = int(idx), max(int(count), 1)
            if info.get("title") and not job.playlist:
                job.title = info["title"]
            elif info.get("title"):
                job.message = f"{idx}/{job.item_count}：{info['title']}"
            if d["status"] == "downloading":
                job.status = "downloading"
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done = d.get("downloaded_bytes") or 0
                item = (done / total * 100) if total else 0
                job.progress = ((job.item_index - 1) * 100 + item * 0.9) / job.item_count
                job.speed = (d.get("_speed_str") or "").strip()
                job.eta = (d.get("_eta_str") or "").strip()
            elif d["status"] == "finished":
                job.status = "converting"
                job.progress = ((job.item_index - 1) * 100 + 90) / job.item_count
                job.speed = job.eta = ""

        def pp_hook(d: dict) -> None:
            if d["status"] == "started":
                job.status = "converting"

        def post_hook(filepath: str) -> None:
            name = Path(filepath).name
            if name.endswith(".mp3") and name not in job.files:
                job.files.append(name)
            job.progress = job.item_index * 100 / job.item_count

        opts: dict = {
            "format": "bestaudio/best",
            "outtmpl": str(self.out_dir / "%(title).150B [%(id)s].%(ext)s"),
            "windowsfilenames": True,
            "noplaylist": not job.playlist,
            "playlistend": PLAYLIST_LIMIT,
            "ignoreerrors": job.playlist,  # プレイリストは1曲失敗しても続行
            "writethumbnail": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [pp_hook],
            "post_hooks": [post_hook],
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": job.quality,
                },
                {"key": "FFmpegMetadata", "add_metadata": True},
                {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
                {"key": "EmbedThumbnail", "already_have_thumbnail": False},
            ],
        }
        if self.ffmpeg:
            opts["ffmpeg_location"] = self.ffmpeg
        if self.deno:
            opts["js_runtimes"] = {"deno": {"path": self.deno}}
        return opts

    def _run(self, job: Job) -> None:
        if not self.ffmpeg:
            job.status, job.message = "error", "ffmpeg が見つかりません。README の手順で導入してください。"
            return
        job.status = "downloading"
        try:
            with yt_dlp.YoutubeDL(self._ydl_opts(job)) as ydl:
                info = ydl.extract_info(job.url, download=True)
            if info and job.playlist and info.get("_type") == "playlist":
                job.title = info.get("title") or job.title
            elif info and not job.title:
                job.title = info.get("title") or ""
            if not job.files:
                raise RuntimeError("MP3 ファイルを作成できませんでした。")
            job.status, job.progress = "done", 100.0
            if job.playlist:
                job.message = f"{len(job.files)} 曲を保存しました"
            else:
                job.message = ""
        except Exception as e:  # yt-dlp の例外をそのまま利用者向けの文に整える
            job.status = "error"
            job.message = _friendly_error(str(e))


def _friendly_error(msg: str) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg).replace("ERROR: ", "")
    low = msg.lower()
    if "private video" in low:
        return "非公開動画のため取得できません。"
    if "sign in to confirm your age" in low or "age-restricted" in low:
        return "年齢制限付きの動画のため取得できません。"
    if "video unavailable" in low or "http error 404" in low:
        return "動画が見つからないか、削除されています。"
    if "sign in to confirm" in low and "bot" in low:
        return "YouTube にアクセスを一時的に制限されています。時間をおいて再試行してください。"
    if "unable to download" in low or "timed out" in low or "getaddrinfo" in low:
        return "通信エラーです。ネット接続を確認してください。"
    return msg[:300]
