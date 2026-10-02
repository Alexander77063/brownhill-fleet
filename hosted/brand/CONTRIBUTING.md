# Brand assets

`icon.svg` is the single source of truth. To swap the mark:

1. Replace `icon.svg` with the new mark. Keep the viewBox at `0 0 32 32` for predictable downscale.
2. `pnpm build:icons` (Task 1 wires this script in Task 15; until then run the rasteriser manually via `npx sharp-cli`).
3. Commit the regenerated `hosted/static/*`.
