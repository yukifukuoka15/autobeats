"""Build the standalone YouTube helper on the target operating system."""
from pathlib import Path
import subprocess
import sys
import platform

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "apps/chart-editor/resources"
subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(RES / "youtube/requirements.txt"), "pyinstaller>=6.16"], check=True)
import imageio_ffmpeg
import deno

# Include native tools explicitly; they must match the build host architecture.
args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--console",
        "--name", "import_audio", "--distpath", str(RES / "youtube-runtime-build"),
        "--workpath", str(ROOT / "tmp/youtube-pyinstaller"), "--specpath", str(ROOT / "tmp"),
        "--collect-all", "yt_dlp", "--collect-all", "yt_dlp_ejs",
        "--add-binary", str(imageio_ffmpeg.get_ffmpeg_exe()) + ":bin",
        "--add-binary", str(deno.find_deno_bin()) + ":bin",
        str(RES / "youtube/import_audio.py")]
subprocess.run(args, check=True)
# The downloader expects stable executable names.
folder = RES / "youtube-runtime-build/import_audio/_internal/bin"
ffmpeg = next(folder.glob("ffmpeg*"))
name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
if ffmpeg.name != name:
    ffmpeg.rename(folder / name)
print("YouTube runtime built for", sys.platform, platform.machine())
