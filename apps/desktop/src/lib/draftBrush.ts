export type BrushPoint = { x: number; y: number; pressure: number; time: number };
export type BrushBounds = { x: number; y: number; width: number; height: number };
export type BrushOptions = {
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  smoothing: number;
  /** Defaults to true; mouse callers still pass a contact pressure of 1. */
  pressure?: boolean;
  /** Distance stabilizer, separate from time smoothing: 0..1 maps to a 0..64px trailing rope. */
  inertia?: number;
  color: string;
  erase: boolean;
  selection?: DraftSelection | null;
};
export type PixelPatch = BrushBounds & { before: Uint8ClampedArray; after: Uint8ClampedArray };

const TILE_SIZE = 128;
const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
type Tile = BrushBounds & {
  before: Uint8ClampedArray;
  image: ImageData;
  coverage: Float32Array;
  dirty: BrushBounds | null;
};

function union(a: BrushBounds | null, b: BrushBounds): BrushBounds {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function point(p: BrushPoint, pressureEnabled = true): BrushPoint | null {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: p.x, y: p.y, pressure: pressureEnabled ? clamp01(p.pressure) : 1, time: Number.isFinite(p.time) ? p.time : 0 };
}

function between(a: BrushPoint, b: BrushPoint, t: number): BrushPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t, time: a.time + (b.time - a.time) * t };
}

let colorContext: CanvasRenderingContext2D | null = null;
function brushColor(color: string): Uint8ClampedArray {
  if (!colorContext) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    colorContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!colorContext) throw new Error("无法创建画笔，请重新打开草稿");
  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillStyle = "#000000";
  colorContext.fillStyle = color;
  colorContext.fillRect(0, 0, 1, 1);
  return colorContext.getImageData(0, 0, 1, 1).data;
}

/** Apply an already committed gesture's local patches. Coordinates are layer pixels. */
export function applyPixelPatches(canvas: HTMLCanvasElement, patches: PixelPatch[], side: "before" | "after"): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法恢复绘画，请重新打开草稿");
  for (const patch of patches) {
    const image = context.createImageData(patch.width, patch.height);
    image.data.set(patch[side]);
    context.putImageData(image, patch.x, patch.y);
  }
}

/**
 * A single fixed-tool gesture. Input and brush diameter use layer pixels, independent of zoom/DPR.
 * Dabs accumulate coverage; preview always composites against pixels captured before this stroke.
 * append() can receive a whole animation frame's samples: it uploads each dirty tile once per batch.
 */
export class DraftBrushStroke {
  private readonly context: CanvasRenderingContext2D;
  private readonly options: BrushOptions;
  private readonly color: Uint8ClampedArray;
  private readonly clip: BrushBounds;
  private readonly tiles = new Map<string, Tile>();
  private readonly masks = new Map<string, Uint8Array>();
  private readonly dirtyTiles = new Set<Tile>();
  private input: BrushPoint;
  private smoothed: BrushPoint;
  private filtered: BrushPoint;
  private lastDab: BrushPoint;
  private nextAt: number;
  private ended = false;
  private damage: BrushBounds | null = null;

  constructor(canvas: HTMLCanvasElement, options: BrushOptions, start: BrushPoint) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const first = point(start, options.pressure !== false);
    if (!context || !first) throw new Error("无法开始绘画，请重新打开草稿");
    this.context = context;
    this.options = { ...options, size: Math.max(0.5, Number.isFinite(options.size) ? options.size : 1),
      hardness: clamp01(options.hardness), opacity: clamp01(options.opacity), flow: clamp01(options.flow),
      smoothing: clamp01(options.smoothing), inertia: clamp01(options.inertia ?? 0),
      selection: options.selection ? { ...options.selection, ...(options.selection.points ? { points: options.selection.points.map(p => ({ ...p })) } : {}),
        ...(options.selection.region ? { region: { ...options.selection.region, rows: options.selection.region.rows.map(row => [...row]) } } : {}) } : null };
    this.color = brushColor(options.color);
    const selection = this.options.selection;
    // Selection bounds are only a coarse clip; polygon masks below perform the true shape clip.
    // All selections are tested at pixel centres. The stroke points themselves are
    // never clamped to the canvas: dragging outside must not paint a line along its edge.
    const x = selection ? Math.max(0, Math.ceil(selection.x - 0.5)) : 0;
    const y = selection ? Math.max(0, Math.ceil(selection.y - 0.5)) : 0;
    const right = selection ? Math.min(canvas.width, Math.ceil(selection.x + Math.max(0, selection.width) - 0.5)) : canvas.width;
    const bottom = selection ? Math.min(canvas.height, Math.ceil(selection.y + Math.max(0, selection.height) - 0.5)) : canvas.height;
    this.clip = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    this.input = this.smoothed = this.filtered = this.lastDab = first;
    this.nextAt = this.spacing(first);
    this.dab(first);
    this.flush();
  }

  append(points: BrushPoint[]): void {
    if (this.ended) return;
    for (const raw of points) {
      const p = point(raw, this.options.pressure !== false);
      if (!p) continue;
      const previous = this.input;
      this.input = p;
      let next = p;
      if (this.options.smoothing > 0) {
        const dt = p.time > previous.time ? p.time - previous.time : 1;
        const tau = 80 * this.options.smoothing * this.options.smoothing;
        const follow = 1 - Math.exp(-dt / tau);
        next = { ...p, x: this.filtered.x + (p.x - this.filtered.x) * follow,
          y: this.filtered.y + (p.y - this.filtered.y) * follow };
      }
      this.filtered = next;
      const lag = 64 * this.options.inertia! * this.options.inertia!;
      if (lag > 0) {
        const dx = next.x - this.smoothed.x, dy = next.y - this.smoothed.y;
        const distance = Math.hypot(dx, dy), follow = distance > lag ? (distance - lag) / distance : 0;
        next = { ...next, x: this.smoothed.x + dx * follow, y: this.smoothed.y + dy * follow };
      }
      this.segment(next);
    }
    this.flush();
  }

  /** Includes the terminal sample/tail, then transfers the before/after buffers to history. */
  finish(last?: BrushPoint): PixelPatch[] {
    if (this.ended) return [];
    // Pointerup reports zero even when its position is the final contact sample. Preserve
    // the last contact's width while catching up the stabilizer/smoothing tail.
    if (last) this.append([{ ...last, pressure: last.pressure === 0 && this.input.pressure > 0 ? this.input.pressure : last.pressure }]);
    this.segment(this.input);
    if (Math.hypot(this.lastDab.x - this.input.x, this.lastDab.y - this.input.y) > 0.001
      || this.lastDab.pressure !== this.input.pressure) this.dab(this.input);
    this.flush();
    this.ended = true;
    const patches: PixelPatch[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.before.some((value, i) => value !== tile.image.data[i])) {
        patches.push({ x: tile.x, y: tile.y, width: tile.width, height: tile.height,
          before: tile.before, after: tile.image.data });
      }
    }
    this.tiles.clear();
    this.masks.clear();
    return patches;
  }

  cancel(): void {
    if (this.ended) return;
    for (const tile of this.tiles.values()) {
      tile.image.data.set(tile.before);
      this.context.putImageData(tile.image, tile.x, tile.y);
      this.damage = union(this.damage, tile);
    }
    this.ended = true;
    this.tiles.clear();
    this.masks.clear();
    this.dirtyTiles.clear();
  }

  /** Drains the layer-pixel bounds changed since the previous call, including the initial dab. */
  takeDirtyBounds(): BrushBounds | null {
    const result = this.damage;
    this.damage = null;
    return result;
  }

  private spacing(p: BrushPoint): number {
    return Math.max(0.5, this.options.size * Math.max(0.05, p.pressure) * 0.12);
  }

  private segment(end: BrushPoint): void {
    const start = this.smoothed;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > 0.000001) {
      while (this.nextAt <= length + 0.000001) {
        const p = between(start, end, Math.min(1, this.nextAt / length));
        this.dab(p);
        this.nextAt += this.spacing(p);
      }
      this.nextAt -= length;
    } else if (end.pressure > start.pressure) {
      this.dab(end);
    }
    this.smoothed = end;
  }

  private tile(tx: number, ty: number): Tile {
    const key = `${tx},${ty}`;
    const existing = this.tiles.get(key);
    if (existing) return existing;
    const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
    const width = Math.min(TILE_SIZE, this.context.canvas.width - x);
    const height = Math.min(TILE_SIZE, this.context.canvas.height - y);
    const image = this.context.getImageData(x, y, width, height);
    const tile: Tile = { x, y, width, height, image, before: new Uint8ClampedArray(image.data),
      coverage: new Float32Array(width * height), dirty: null };
    this.tiles.set(key, tile);
    return tile;
  }

  private dab(p: BrushPoint): void {
    this.lastDab = p;
    if (p.pressure === 0 || this.options.opacity === 0 || this.options.flow === 0
      || this.clip.width === 0 || this.clip.height === 0) return;
    const radius = this.options.size * p.pressure / 2;
    const outer = radius + 0.5;
    const inner = Math.max(0, radius * this.options.hardness - 0.5);
    const left = Math.max(this.clip.x, Math.floor(p.x - outer));
    const top = Math.max(this.clip.y, Math.floor(p.y - outer));
    const right = Math.min(this.clip.x + this.clip.width, Math.ceil(p.x + outer));
    const bottom = Math.min(this.clip.y + this.clip.height, Math.ceil(p.y + outer));
    if (right <= left || bottom <= top) return;
    for (let ty = Math.floor(top / TILE_SIZE); ty <= Math.floor((bottom - 1) / TILE_SIZE); ty++) {
      for (let tx = Math.floor(left / TILE_SIZE); tx <= Math.floor((right - 1) / TILE_SIZE); tx++) {
        const x0 = Math.max(left, tx * TILE_SIZE), y0 = Math.max(top, ty * TILE_SIZE);
        const x1 = Math.min(right, (tx + 1) * TILE_SIZE), y1 = Math.min(bottom, (ty + 1) * TILE_SIZE);
        const maskWidth = Math.min(TILE_SIZE, this.context.canvas.width - tx * TILE_SIZE);
        let mask: Uint8Array | undefined;
        if (this.options.selection && (this.options.selection.points || this.options.selection.region)) {
          const key = `${tx},${ty}`;
          mask = this.masks.get(key);
          if (!mask) {
            mask = draftSelectionMask(this.options.selection, { x: tx * TILE_SIZE, y: ty * TILE_SIZE,
              width: maskWidth, height: Math.min(TILE_SIZE, this.context.canvas.height - ty * TILE_SIZE) });
            this.masks.set(key, mask);
          }
        }
        let tile: Tile | undefined;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (mask && !mask[(y - ty * TILE_SIZE) * maskWidth + x - tx * TILE_SIZE]) continue;
            const distance = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
            if (distance >= outer) continue;
            const t = Math.min(1, (outer - distance) / (outer - inner));
            // Subpixel tips cover a fraction of a pixel even at its centre, instead of
            // turning every diameter below 1px into the same fully opaque one-pixel dot.
            const coverage = t * t * (3 - 2 * t) * Math.min(1, radius * 2) * this.options.flow;
            tile ??= this.tile(tx, ty);
            const i = (y - tile.y) * tile.width + x - tile.x;
            tile.coverage[i] += (1 - tile.coverage[i]) * coverage;
          }
        }
        if (tile) {
          tile.dirty = union(tile.dirty, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
          this.dirtyTiles.add(tile);
        }
      }
    }
  }

  private flush(): void {
    const opacity = this.options.opacity * (this.options.erase ? 1 : this.color[3] / 255);
    for (const tile of this.dirtyTiles) {
      const area = tile.dirty!;
      for (let y = area.y; y < area.y + area.height; y++) {
        for (let x = area.x; x < area.x + area.width; x++) {
          const i = (y - tile.y) * tile.width + x - tile.x;
          const k = Math.min(1, tile.coverage[i] * opacity);
          if (k === 0) continue;
          const j = i * 4, before = tile.before, pixels = tile.image.data;
          const alpha = before[j + 3] / 255;
          if (this.options.erase) {
            pixels[j + 3] = Math.round(before[j + 3] * (1 - k));
            if (pixels[j + 3] === 0) pixels[j] = pixels[j + 1] = pixels[j + 2] = 0;
          } else {
            const outAlpha = k + alpha * (1 - k);
            for (let ch = 0; ch < 3; ch++) {
              pixels[j + ch] = Math.round((this.color[ch] * k + before[j + ch] * alpha * (1 - k)) / outAlpha);
            }
            pixels[j + 3] = Math.round(outAlpha * 255);
          }
        }
      }
      this.context.putImageData(tile.image, tile.x, tile.y, area.x - tile.x, area.y - tile.y, area.width, area.height);
      this.damage = union(this.damage, area);
      tile.dirty = null;
    }
    this.dirtyTiles.clear();
  }
}
import { draftSelectionMask, type DraftSelection } from "./draftSelection";
