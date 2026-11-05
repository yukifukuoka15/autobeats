"""AutoBeats 用の単曲取り込み。標準出力の最終行は JSON。"""
import json
import sys
from pathlib import Path
from downloader import DownloadManager, Job, extract_url

def main():
    url = extract_url(sys.argv[1])
    if not url:
        raise ValueError("YouTube の URL を入力してください。")
    manager = DownloadManager(Path(sys.argv[2]), max_workers=1)
    job = Job(id="import", url=url, quality="192", playlist=False)
    # サムネイルの変換・埋め込みは譜面解析に不要。
    original = manager._ydl_opts
    def options(job):
        opts = original(job)
        opts["writethumbnail"] = False
        opts["postprocessors"] = opts["postprocessors"][:2]
        opts["socket_timeout"] = 30
        return opts
    manager._ydl_opts = options
    try:
        manager._run(job)
        if job.status != "done" or len(job.files) != 1:
            raise RuntimeError(job.message or "音声を取得できませんでした。")
        print(json.dumps({"file": job.files[0]}, ensure_ascii=True))
    finally:
        manager.pool.shutdown(wait=False, cancel_futures=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
