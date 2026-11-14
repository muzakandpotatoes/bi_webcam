# bi_webcam

Two-camera capture with adjustable sync delay and a combined side-by-side recording.
Runs locally in Chrome (or Edge/Arc/Brave — any Chromium browser).

```sh
npm install
npm run dev        # then open the printed localhost URL in Chrome
```

## Using it

1. Allow camera/mic access. Pick a camera for **A** and **B** (choices are remembered).
2. Rotate (⟳) a feed if the phone shows up sideways — rotation is baked into the recording.
   Mirror (⇋) only affects the preview.
3. Clap in view of both cameras, press **F** to freeze, and compare. Adjust **Video sync**
   until the hands meet in the same frame on both sides. **Audio** offset works the same way
   (positive delays the audio, negative delays both videos).
4. Press **Space** (or ● Record). The first time, pick a folder for takes.

Each take produces:

- `take_<date>_<time>.mp4` — A and B combined (the main export), side by side or stacked to
  match the preview. Side by side shares a height; stacked shares a width. The quality setting
  (720p/1080p/1440p) sets that shared size as if each feed were 16:9, and the longest side is
  capped at 3840 px.
- `take_…_A.mp4`, `take_…_B.mp4` — only with "also save each camera separately"
- `take_….json` — devices, resolutions, offsets, durations

## Shortcuts

| Key | Action |
|---|---|
| Space | Record / stop |
| ← / → | Video offset ±1 frame |
| Shift + ← / → | Video offset ±10 ms |
| F | Freeze preview (recording continues) |
| L | Toggle side by side / stacked |
| V | Toggle Cameras / Output view |

## How it works

- `src/pipeline.worker.ts` — receives raw camera frames, rotates/copies them, holds them in a
  per-camera delay queue, and composites the latest frame of each camera into the combined
  output at a fixed frame rate. It runs in a worker so it keeps full speed when the tab is
  hidden or the window is covered.
- `src/pipeline.ts` — moves frames between camera tracks, the worker, and output tracks
  (Chrome's `MediaStreamTrackProcessor` / `MediaStreamTrackGenerator`).
- `src/recorder.ts` — `MediaRecorder` per output, all started in the same tick, streamed to
  disk once a second through the File System Access API.
- `src/audio.ts` — mic → `DelayNode` → recorded audio track, plus the level meter.
- `src/main.ts` — UI, device handling, settings.
