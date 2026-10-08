# SinhalaTTSAnnotationTool

This is an annotation tool to annotate and validate data: listen to each audio clip of a Sinhala TTS dataset, check that its row in `metadata.csv` matches what is heard, fix the transcripts, and mark the clip as approved, rejected or needing review.

It runs locally in the browser and needs only Python 3 (no packages to install).

## Running

```powershell
python server.py
```

The browser opens at <http://127.0.0.1:8000>. Press `Ctrl+C` in the terminal to stop.

| Option | Default | Purpose |
|---|---|---|
| `--data DIR` | `data/` | Folder containing the datasets (read-only) |
| `--out DIR` | `annotations/` | Where annotated CSVs are saved |
| `--port N` | `8000` | Port to serve on |
| `--no-browser` | | Don't open a browser tab |

## Data layout

Any folder under `data/` that contains a `metadata.csv` and a `clips/` folder is picked up as a dataset:

```
data/<anything>/<dataset>/
├── metadata.csv      one row per clip
├── clips/            segmented .wav clips (what is being validated)
├── raw_audio/        full-length .wav the clips were cut from (used for "Play in context")
└── uploaded_audio/   the original upload (not used by the tool)
```

Expected `metadata.csv` columns:

`clip_filename, source_file, start_sec, end_sec, duration_sec, transcript_sinhala, transcript_romanized`

## Where annotations are saved

The `data/` folder is **never modified**. Annotations go to a mirror path under `annotations/`:

```
data/<anything>/<dataset>/metadata.csv         original, read only
annotations/<anything>/<dataset>/metadata.csv  annotated copy
```

The annotated copy is created on the first save and is loaded on later runs, so work continues where it left off. To start over, delete it. Neither `data/` nor `annotations/` is committed to git.

The annotated CSV keeps every original column and adds:

| Column | Values |
|---|---|
| `annotation_status` | `pending`, `approved`, `rejected`, `needs_review` |
| `annotation_notes` | free text from the annotator |
| `annotated_at` | timestamp of the last save for that row |

Only `transcript_sinhala`, `transcript_romanized` and `annotation_notes` can be edited in the tool; timing columns are read-only because the clip files themselves aren't changed.

## Annotating

1. Pick a clip from the list (filter by status or search by text).
2. Listen. Click the waveform to seek, change the speed, or use **Play in context** to hear the segment inside the raw audio with 2 s either side.
3. Correct the transcripts if needed.
4. Approve, flag as needs review, or reject. The tool saves and moves to the next clip.

The tool also warns when:

- the real clip length differs from `duration_sec`,
- `end_sec − start_sec` differs from `duration_sec`,
- a transcript is empty,
- the row's audio file is missing.

Clips that exist in `clips/` but have no CSV row appear under **Not in CSV**. Use **Add row to metadata.csv** to add them (status `needs_review`, duration read from the file) and then transcribe them.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Alt+P`, or `Space` outside text boxes | Play / pause |
| `Alt+C` | Play in context |
| `Alt+A`, `Ctrl+Enter` | Approve and go to next |
| `Alt+F` | Needs review and go to next |
| `Alt+R` | Reject and go to next |
| `Alt+S` | Save edits |
| `Alt+N` / `Alt+B` | Next / previous clip (edits auto-save) |
