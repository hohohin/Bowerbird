# Audio library study

Isolated interaction and performance preview. Nothing imports this directory from the application entry.

From any working directory, run the server with Node:

```powershell
node D:/H/Project/Bowerbird/apps/desktop/scripts/fixtures/audio-library-preview/server.mjs
```

The default page is `http://127.0.0.1:17879/scripts/fixtures/audio-library-preview/preview.html`. Add `?count=1200` for a virtual list repeating the same six source fixtures. The server binds localhost only. Refresh after source edits; this is a direct static server without a transformation cache or HMR.

`AUDIO_FIXTURES_DIR` overrides the default `D:/H/Project/Bowerbird/.tmp/audio-preview-fixtures` (resolved relative to this repository, not hardcoded). The server maps that directory to `/audio-fixtures/`, supports byte ranges, and checks physical paths to prevent directory or symlink escapes. Only the preview directory, two named production CSS files and the synthetic media directory are served. `createPreviewServer({port:0, fixturesDir})` returns `{server,httpServer,url,close}` for tests; zero uses a genuine ephemeral port. Native ESM and plain CSS need no Vite/PostCSS configuration and are independent of caller cwd.

Manifest shape:

```json
[{"id":"chime","name":"晨间提示.wav","url":"/audio-fixtures/chime.wav","peaksUrl":"/audio-fixtures/chime.peaks.json","duration":12}]
```

Waveform shape: `{duration,peaks:[[min,max],...],framesPerPeak,totalFrames}`. The Rust spike supplies additional metadata; the renderer uses real frame ranges and retains extrema and the last partial bucket. It never decodes the audio in the browser to generate a waveform.

Waveforms are normalized per file to 80% of their available vertical space. This shows relative amplitude within a file, not comparable loudness between files. Silence remains a center line. Display normalization does not alter playback gain.

One native audio element serves all cards. Entering a waveform starts at the entry position after 90 ms; leaving, scrolling, window blur, a hidden document, removal, or Escape stops it and clears the source. Only the active cursor animates. Space/Enter/click starts or stops playback; arrows move the start position. A real autoplay rejection reveals the small play affordance.

For isolated Tauri verification only, the harness may inject `__BOWERBIRD_AUDIO_NATIVE_SOURCES__` as an ID → synthetic original path map. The preview calls Tauri's own `convertFileSrc()` for those entries. This seam is absent from the application entry and never reads the user's library.

Validation from `apps/desktop`:

```powershell
node scripts/audio-preview-ui.test.mjs
node scripts/fixtures/audio-library-preview/capture.mjs
```

The UI test creates actual low-amplitude/silent WAV fixtures, uses native playback, checks autoplay denial without synthetic user activation, and delays a real media response to exercise stale requests. It also checks byte ranges/path containment, 100 pointer switches, source cleanup, one player, no frontend decode, and the 1200-card mount limit. The 2.5-second rAF/long-task sample describes a Chrome browser run reusing six sources; it is not native FPS, indexing throughput, or a benchmark of 1200 distinct audio files.

`capture.mjs` starts its own temporary server against the real Rust-generated fixture manifest, saves six-file dark/light images, and checks hour formatting. Set `AUDIO_PREVIEW_URL` only to capture an already running fresh service. Artifacts are under `apps/desktop/.tmp/audio-preview-ui/`; see `AGENT-LOG.md` for red/green history.
