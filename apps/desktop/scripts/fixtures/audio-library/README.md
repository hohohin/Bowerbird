# Formal audio library fixture

This fixture mounts the production `Toolbar`, `LibraryHome`, `AssetDetail`, `AssetContextMenu`, and `FileDropImport`. It does not mount the application bootstrap or read a user library. Unknown IPC commands fail, and outgoing non-loopback requests are blocked by the test.

Run from `apps/desktop`:

```powershell
node scripts/audio-library-ui.test.mjs
```

`--guards-only` checks the real context menu and shared canvas delivery boundaries. `--ui-only` checks the library integration. `--mutations-only` and `--selection-only` isolate the corresponding regressions. Synthetic media and precomputed peak JSON are read from the existing repository `.tmp/audio-preview-fixtures` directory; the test never copies original files. Output is written to `apps/desktop/.tmp/audio-library`.

Media playback uses the real browser `HTMLAudioElement`; neither `play()` nor `currentTime` is mocked. Event timing is software timing and does not establish acoustic latency, Windows native behavior, or macOS validation.
