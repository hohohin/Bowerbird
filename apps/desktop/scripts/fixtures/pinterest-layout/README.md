# Pinterest Lens layout fixture

This is a synthetic behavioral model of the publicly observable Lens structure,
not a copy of account data or a claim that Pinterest has been tested live.

Evidence fetched on 2026-11-03 (local frozen originals in `.tmp/pinterest-layout`):

- `22146-e26142f5b001fd15.mjs`, modules LensPageContent/LensImage: row Flex with a fixed `visual-search-image-container`, its `visual-search-image-container-placeholder`, and a growing result sibling; source width 536. Source children retain the relative Box → 520px Mask → relative Image Box with 400% padding-bottom → absolute `img.img_F` stack. The cropper is the Image Box's sibling inside Mask; fixed 2080px image height represents the synthetic 1:4 long source.
- `69208-d87dc341fc41fc29.mjs`, module 567380 LensFeed: basic Masonry, `minCols:1`, `loadItems:fetchMore`, window scroll container, virtualized non-story items.
- Structure: `masonry-container` → dynamic wrapper → `max-width-container` → native grid → absolute `[data-grid-item][role=listitem]` → `[data-grid-item-idx]`.
- Gestalt Masonry module 128568 uses grid-wrapper ResizeObserver and window resize. Shared module 91714 calculates `max(floor(width/(221+16)),1)` columns; flexible positioning module 223999 uses `width/columns-16` cell width. The fixture models those measured dimensions and ownership; only its own layout function writes item positions/widths. It does not implement Pinterest's complete virtualization, 150ms debounce or fetching algorithm.
- The page response allows inline styles as the observed Pinterest CSP does, but blocks all unspecified network destinations. No fixture assets leave local route interception.

All pictures and Pin IDs are synthesized. Links preserve their original handlers
and use SPA history; scrolling near the end appends a second page. Real browser
geometry, real image loading, and the production drag/candidate scripts are used.
The small source preview is read-only: shrinking the fixed 520px cropper would
invalidate its JavaScript pointer coordinates. Cropper usability is not claimed.

Run from `apps/desktop`: `node scripts/pinterest-layout.test.mjs`.
Use `BOWERBIRD_PINTEREST_LAYOUT_PATH` for an isolated source snapshot or mutant;
`BOWERBIRD_PINTEREST_LAYOUT_BASELINE=1` deliberately omits the adapter for red tests.
`BOWERBIRD_PINTEREST_LAYOUT_COVERAGE_PATH` optionally writes browser V8 coverage;
`BOWERBIRD_PINTEREST_LAYOUT_OUTPUT` isolates screenshots/results for mutation runs.

The regression additionally covers a 72px sidebar (300px viewport, 228px content
area), React replacing source wrappers while retaining the original image, a
landscape replacement, pure History navigation without DOM changes, and exact
Pinterest-origin child frames remaining untouched.
