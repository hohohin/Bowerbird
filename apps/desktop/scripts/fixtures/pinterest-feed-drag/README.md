# Pinterest feed drag fixture

The page uses synthetic images and Pin IDs in the publicly confirmed PinRep shape:

`[data-test-id=pin][data-test-pin-id]` → grouping wrapper → `pinWrapper` → Pin anchor → `.PinCard__imageWrapper` → `pincard-*` → image branch and hover-overlay siblings.

Evidence: Pinterest public `85140-3ec862a5960f5ddf.mjs` (PinRep, around byte 480195), frozen under `.tmp/pinterest-feed-drag`. The official `pin-card-hover-overlay` is absolute inset 0. Its `pin-card-hover-overlay-top-wash` is 48px high with `rgba(17,17,17,.40)`; `pin-card-hover-overlay-gradient-full` occupies the remaining height and fades that color to transparent. Pin tools are a sibling of the main anchor. The actual code and acquisition notes are owned by the research record; this fixture does not contain an authenticated response or user image.

The tests load production candidate/drag scripts and dispatch real Chromium mouse and drag events. They verify high-resolution srcset selection and the original Pin URL. Lens results reuse the existing layout fixture and production layout script. Buttons, visible text, modal content/backgrounds, unrelated opaque/translucent overlays, another host, and different nearest Pin wrappers must not acquire capture payloads.

The nested/neighbor Pin cases are deliberate boundary probes. They are not claimed to be current Pinterest markup. An earlier deep-ancestor hypothesis was discarded after official markup showed the image/hover common parent only two levels away; no arbitrary-depth behavior is required.

Run from `apps/desktop`: `node scripts/pinterest-feed-drag.test.mjs`.
`BOWERBIRD_EXPLORER_DRAG_PATH` selects a frozen script without replacing production;
`BOWERBIRD_PINTEREST_FEED_OUTPUT` isolates results/screenshots;
`BOWERBIRD_PINTEREST_FEED_CASES` narrows cases for diagnosis.
`BOWERBIRD_PINTEREST_FEED_COVERAGE_PATH` enables optional V8 coverage output.

This verifies a synthetic structural contract. It does not establish live account/feature-flag variants, native OS physical dragging, or macOS behavior.
