"""Sinhala TTS annotation tool - local web server (Python standard library only).

Usage:
    python server.py [--data DATA_DIR] [--port 8000]

Any folder under DATA_DIR that contains a `metadata.csv` and a `clips/` folder
is treated as a dataset. Annotations are written back into that metadata.csv.
"""

import argparse
import csv
import json
import mimetypes
import os
import shutil
import threading
import urllib.parse
import wave
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"

METADATA_NAME = "metadata.csv"
BACKUP_NAME = "metadata.backup.csv"
CLIPS_DIR = "clips"
RAW_DIR = "raw_audio"

# Columns the tool appends to metadata.csv (only added when the first annotation is saved).
STATUS_COL = "annotation_status"
NOTES_COL = "annotation_notes"
TIME_COL = "annotated_at"
ANNOTATION_COLS = [STATUS_COL, NOTES_COL, TIME_COL]
STATUSES = {"pending", "approved", "rejected", "needs_review"}

# Only these columns may be edited from the UI.
EDITABLE_COLS = {"transcript_sinhala", "transcript_romanized", NOTES_COL}

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}

write_lock = threading.Lock()
DATA_ROOT: Path = APP_DIR / "data"


# --------------------------------------------------------------------------- datasets

def find_datasets():
    """Return dataset folders (relative posix ids) under DATA_ROOT."""
    found = []
    for csv_path in sorted(DATA_ROOT.rglob(METADATA_NAME)):
        folder = csv_path.parent
        if (folder / CLIPS_DIR).is_dir():
            found.append(folder.relative_to(DATA_ROOT).as_posix())
    return found


def dataset_dir(ds_id):
    """Resolve a dataset id to a folder, refusing anything outside DATA_ROOT."""
    folder = (DATA_ROOT / ds_id).resolve()
    if DATA_ROOT not in folder.parents and folder != DATA_ROOT:
        raise ValueError("invalid dataset")
    if not (folder / METADATA_NAME).is_file():
        raise ValueError("dataset not found")
    return folder


def read_csv(folder):
    with open(folder / METADATA_NAME, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), list(reader)


def write_csv(folder, columns, rows):
    """Atomically rewrite metadata.csv, keeping a one-time backup of the original."""
    target = folder / METADATA_NAME
    backup = folder / BACKUP_NAME
    if not backup.exists():
        shutil.copy2(target, backup)
    tmp = target.with_suffix(".csv.tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, lineterminator="\n", extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(tmp, target)


def ensure_annotation_cols(columns, rows):
    for col in ANNOTATION_COLS:
        if col not in columns:
            columns.append(col)
    for row in rows:
        for col in ANNOTATION_COLS:
            row.setdefault(col, "")
        if not row[STATUS_COL]:
            row[STATUS_COL] = "pending"


def wav_duration(path):
    try:
        with wave.open(str(path)) as w:
            return round(w.getnframes() / float(w.getframerate()), 2)
    except (wave.Error, OSError, EOFError):
        return ""


def first_audio(folder):
    if not folder.is_dir():
        return None
    for p in sorted(folder.iterdir()):
        if p.suffix.lower() in AUDIO_EXTS:
            return p.name
    return None


def dataset_summary(ds_id):
    folder = dataset_dir(ds_id)
    columns, rows = read_csv(folder)
    clips = {p.name for p in (folder / CLIPS_DIR).iterdir() if p.suffix.lower() in AUDIO_EXTS}
    counts = {s: 0 for s in STATUSES}
    for r in rows:
        counts[r.get(STATUS_COL) or "pending"] = counts.get(r.get(STATUS_COL) or "pending", 0) + 1
    listed = {r["clip_filename"] for r in rows}
    return {
        "id": ds_id,
        "rows": len(rows),
        "clips": len(clips),
        "unlisted": len(clips - listed),
        "missing_audio": len(listed - clips),
        "counts": counts,
    }


def dataset_detail(ds_id):
    folder = dataset_dir(ds_id)
    columns, rows = read_csv(folder)
    clip_files = sorted(p.name for p in (folder / CLIPS_DIR).iterdir() if p.suffix.lower() in AUDIO_EXTS)
    clip_set = set(clip_files)
    listed = {r["clip_filename"] for r in rows}
    for r in rows:
        r.setdefault(STATUS_COL, "")
        r["_has_audio"] = r["clip_filename"] in clip_set
    return {
        "id": ds_id,
        "columns": columns,
        "editable": sorted(EDITABLE_COLS),
        "rows": rows,
        "unlisted": [c for c in clip_files if c not in listed],
        "raw_audio": first_audio(folder / RAW_DIR),
    }


def update_row(ds_id, payload):
    clip = payload.get("clip_filename")
    fields = payload.get("fields") or {}
    status = payload.get("status")
    if status is not None and status not in STATUSES:
        raise ValueError(f"unknown status: {status}")
    bad = set(fields) - EDITABLE_COLS
    if bad:
        raise ValueError(f"columns not editable: {', '.join(sorted(bad))}")

    folder = dataset_dir(ds_id)
    with write_lock:
        columns, rows = read_csv(folder)
        ensure_annotation_cols(columns, rows)
        row = next((r for r in rows if r["clip_filename"] == clip), None)
        if row is None:
            raise ValueError(f"clip not in metadata: {clip}")
        for col, value in fields.items():
            row[col] = value.strip() if isinstance(value, str) else value
        if status is not None:
            row[STATUS_COL] = status
        row[TIME_COL] = datetime.now().isoformat(timespec="seconds")
        write_csv(folder, columns, rows)
    return row


def add_row(ds_id, payload):
    """Add a metadata row for a clip that exists on disk but is missing from the CSV."""
    clip = payload.get("clip_filename", "")
    folder = dataset_dir(ds_id)
    clip_path = folder / CLIPS_DIR / clip
    if Path(clip).name != clip or not clip_path.is_file():
        raise ValueError(f"clip file not found: {clip}")
    with write_lock:
        columns, rows = read_csv(folder)
        if any(r["clip_filename"] == clip for r in rows):
            raise ValueError(f"clip already in metadata: {clip}")
        ensure_annotation_cols(columns, rows)
        new = {c: "" for c in columns}
        new["clip_filename"] = clip
        if rows and "source_file" in columns:
            new["source_file"] = rows[0].get("source_file", "")
        if "duration_sec" in columns:
            new["duration_sec"] = wav_duration(clip_path)
        new[STATUS_COL] = "needs_review"
        new[TIME_COL] = datetime.now().isoformat(timespec="seconds")
        rows.append(new)
        rows.sort(key=lambda r: r["clip_filename"])
        write_csv(folder, columns, rows)
    return new


# --------------------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        # Audio range requests are noisy; only log API calls and errors.
        if "/api/" in self.path or (args and str(args[1]).startswith(("4", "5"))):
            super().log_message(fmt, *args)

    def send_json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        try:
            if url.path == "/api/datasets":
                return self.send_json([dataset_summary(d) for d in find_datasets()])
            if url.path == "/api/dataset":
                return self.send_json(dataset_detail(query["id"][0]))
            if url.path == "/audio":
                return self.serve_audio(query["id"][0], query["kind"][0], query["file"][0])
        except (KeyError, ValueError) as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        try:
            ds_id = query["id"][0]
            payload = self.read_json()
            if url.path == "/api/row":
                return self.send_json(update_row(ds_id, payload))
            if url.path == "/api/add_row":
                return self.send_json(add_row(ds_id, payload))
        except (KeyError, ValueError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def serve_audio(self, ds_id, kind, name):
        """Serve an audio file with HTTP Range support so the browser can seek."""
        if kind not in (CLIPS_DIR, RAW_DIR) or Path(name).name != name:
            raise ValueError("invalid audio path")
        path = dataset_dir(ds_id) / kind / name
        if not path.is_file():
            return self.send_json({"error": "audio not found"}, HTTPStatus.NOT_FOUND)

        size = path.stat().st_size
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].partition("-")
            if a:
                start = int(a)
                end = int(b) if b else end
            else:  # suffix range: last N bytes
                start = max(0, size - int(b))
            end = min(end, size - 1)
            if start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(HTTPStatus.OK)

        self.send_header("Content-Type", mimetypes.guess_type(name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # browser cancelled the request (normal when seeking)


def main():
    global DATA_ROOT
    parser = argparse.ArgumentParser(description="Sinhala TTS clip annotation tool")
    parser.add_argument("--data", default=str(APP_DIR / "data"), help="root folder containing datasets")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = parser.parse_args()

    DATA_ROOT = Path(args.data).resolve()
    datasets = find_datasets()
    print(f"Data root: {DATA_ROOT}")
    print(f"Found {len(datasets)} dataset(s):")
    for d in datasets:
        print(f"  - {d}")

    url = f"http://127.0.0.1:{args.port}/"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"\nAnnotation tool running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
