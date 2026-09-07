# README artwork and recording

`notebook-logo.png` is a 256 × 256 RGBA export for light and dark README pages. It was edited with the built-in image generation tool using `src/assets/notebook.png` as the reference, then resized with macOS `sips`, preserving alpha. The terminal keeps its original matte artwork because iTerm2 composites transparent inline images against the terminal profile background, which can differ from the application's ANSI background.

Edit prompt: remove only the dark exterior background from the reference notebook; return a transparent RGBA PNG; preserve the notebook, pages, bookmarks, strap, silhouette, orientation, colors, pixel style and square framing; no backdrop, checkerboard, text or extra object.

`agent-note-preview.gif` records the installed v0.4.0 in iTerm2 on 2026-09-07 at 112 columns × 30 rows. `NO_COLOR` was removed for that invocation. The session and stored model outputs are synthetic fixtures; playback uses `--read-only` and disables update checks. Only the terminal content is included. No product image or UI was composited onto the recording.
