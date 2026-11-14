// Frame pipeline. Runs in a worker so timers keep firing at full rate when the
// tab is hidden or the window is covered (Chrome throttles main-thread timers then).
//
// Per camera:  raw frame -> rotate + copy into our own bitmap (releases the camera's
// buffer immediately) -> delay queue -> released as the slot's output frame.
// Combined:    fixed-rate ticker draws the latest released bitmap of each slot
// side by side into one canvas -> combined output frame.

import type { Arrangement, FromWorker, Rotation, Slot, SlotStats, ToWorker } from './protocol';

// Typed loosely: the DOM and WebWorker libs can't both be loaded in one project.
const ctx = self as unknown as {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

const MAX_QUEUE = 240; // hard cap (~4 s at 60fps) so a stuck consumer can't eat memory
const MAX_COMPOSITE_SIDE = 3840; // keeps H.264 encoders happy

interface Held {
  bmp: ImageBitmap;
  arrival: number;
}

class SlotState {
  delayMs = 0;
  rotation: Rotation = 0;
  queue: Held[] = [];
  latest: ImageBitmap | null = null;
  /** After the delay is reduced, skip straight to the newest due frame. */
  dropOverdue = false;
  canvas = new OffscreenCanvas(2, 2);
  g = this.canvas.getContext('2d', { alpha: false })!;
  framesThisSecond = 0;
  fps = 0;

  ingest(frame: VideoFrame) {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const swap = this.rotation === 90 || this.rotation === 270;
    const cw = swap ? h : w;
    const ch = swap ? w : h;
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (this.rotation !== 0) {
      g.translate(cw / 2, ch / 2);
      g.rotate((this.rotation * Math.PI) / 180);
      g.translate(-w / 2, -h / 2);
    }
    g.drawImage(frame, 0, 0, w, h);
    frame.close();
    this.queue.push({ bmp: this.canvas.transferToImageBitmap(), arrival: performance.now() });
    while (this.queue.length > MAX_QUEUE) this.queue.shift()!.bmp.close();
    this.framesThisSecond++;
  }

  clear() {
    for (const h of this.queue) h.bmp.close();
    this.queue = [];
    this.latest?.close();
    this.latest = null;
  }
}

const slots: Record<Slot, SlotState> = { A: new SlotState(), B: new SlotState() };

function post(msg: FromWorker, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function emit(out: Slot | 'C', source: ImageBitmap | OffscreenCanvas) {
  const frame = new VideoFrame(source, {
    timestamp: Math.round(performance.now() * 1000),
    alpha: 'discard',
  });
  post({ type: 'out', out, frame }, [frame]);
}

// ---------- delay release ----------

let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function release() {
  releaseTimer = undefined;
  const now = performance.now();
  let nextDue = Infinity;
  for (const slot of ['A', 'B'] as const) {
    const s = slots[slot];
    let due = 0;
    while (due < s.queue.length && s.queue[due].arrival + s.delayMs <= now + 0.5) due++;
    if (due > 0) {
      const start = s.dropOverdue ? due - 1 : 0;
      for (let i = 0; i < start; i++) s.queue[i].bmp.close();
      for (let i = start; i < due; i++) {
        const { bmp } = s.queue[i];
        emit(slot, bmp);
        s.latest?.close();
        s.latest = bmp;
      }
      s.queue.splice(0, due);
    }
    s.dropOverdue = false;
    if (s.queue.length) nextDue = Math.min(nextDue, s.queue[0].arrival + s.delayMs);
  }
  if (nextDue !== Infinity) {
    releaseTimer = setTimeout(release, Math.max(0, nextDue - performance.now()));
  }
}

function scheduleRelease() {
  if (releaseTimer !== undefined) clearTimeout(releaseTimer);
  release();
}

// ---------- combined output ----------

interface Rect {
  slot: Slot;
  x: number;
  y: number;
  w: number;
  h: number;
}
const comp = {
  size: 1080,
  arrangement: 'side' as Arrangement,
  fps: 30,
  locked: false,
  width: 0,
  height: 0,
  rects: [] as Rect[],
  canvas: new OffscreenCanvas(2, 2),
  g: null as OffscreenCanvasRenderingContext2D | null,
  framesThisSecond: 0,
  measuredFps: 0,
};
comp.g = comp.canvas.getContext('2d', { alpha: false })!;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

function computeLayout() {
  const present = (['A', 'B'] as const).filter((s) => slots[s].latest);
  if (!present.length) {
    comp.rects = [];
    comp.width = comp.height = 0;
    return;
  }
  const aspects = present.map((s) => slots[s].latest!.width / slots[s].latest!.height);
  if (comp.arrangement === 'side') {
    // Shared height; widths follow each feed's shape.
    const sum = aspects.reduce((a, b) => a + b, 0);
    let h = comp.size;
    if (h * sum > MAX_COMPOSITE_SIDE) h = MAX_COMPOSITE_SIDE / sum;
    h = even(h);
    let x = 0;
    comp.rects = present.map((slot, i) => {
      const r = { slot, x, y: 0, w: even(h * aspects[i]), h };
      x += r.w;
      return r;
    });
    comp.width = x;
    comp.height = h;
  } else {
    // Shared width (a 16:9 feed at this width is `size` tall); heights follow each feed's shape.
    const sumInv = aspects.reduce((a, b) => a + 1 / b, 0);
    let w = (comp.size * 16) / 9;
    if (w * sumInv > MAX_COMPOSITE_SIDE) w = MAX_COMPOSITE_SIDE / sumInv;
    w = even(w);
    let y = 0;
    comp.rects = present.map((slot, i) => {
      const r = { slot, x: 0, y, w, h: even(w / aspects[i]) };
      y += r.h;
      return r;
    });
    comp.width = w;
    comp.height = y;
  }
}

function drawComposite() {
  if (!comp.locked) computeLayout();
  if (!comp.width) return;
  const { canvas, g } = comp;
  if (canvas.width !== comp.width || canvas.height !== comp.height) {
    canvas.width = comp.width;
    canvas.height = comp.height;
  }
  g!.fillStyle = '#000';
  g!.fillRect(0, 0, comp.width, comp.height);
  for (const r of comp.rects) {
    const bmp = slots[r.slot].latest;
    if (!bmp) continue;
    // Contain-fit (only matters if a camera changes shape while locked).
    const scale = Math.min(r.w / bmp.width, r.h / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    g!.drawImage(bmp, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
  }
  emit('C', canvas);
  comp.framesThisSecond++;
}

let tickStart = performance.now();
let tickCount = 0;
function tick() {
  drawComposite();
  tickCount++;
  const interval = 1000 / comp.fps;
  let next = tickStart + tickCount * interval;
  const now = performance.now();
  if (next < now - interval) {
    // Fell far behind (e.g. machine stalled): resync instead of bursting.
    tickStart = now;
    tickCount = 0;
    next = now + interval;
  }
  setTimeout(tick, Math.max(0, next - now));
}
setTimeout(tick, 0);

function restartTicker() {
  tickStart = performance.now();
  tickCount = 0;
}

// ---------- stats ----------

setInterval(() => {
  const out = {} as Record<Slot, SlotStats>;
  for (const slot of ['A', 'B'] as const) {
    const s = slots[slot];
    s.fps = s.framesThisSecond;
    s.framesThisSecond = 0;
    out[slot] = {
      fps: s.fps,
      width: s.latest?.width ?? s.queue[0]?.bmp.width ?? 0,
      height: s.latest?.height ?? s.queue[0]?.bmp.height ?? 0,
      queued: s.queue.length,
    };
  }
  comp.measuredFps = comp.framesThisSecond;
  comp.framesThisSecond = 0;
  post({
    type: 'stats',
    slots: out,
    composite: { width: comp.width, height: comp.height, fps: comp.measuredFps },
  });
}, 1000);

// ---------- messages ----------

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'frame':
      slots[m.slot].ingest(m.frame);
      scheduleRelease();
      break;
    case 'slotConfig': {
      const s = slots[m.slot];
      if (m.delayMs < s.delayMs) s.dropOverdue = true;
      s.delayMs = m.delayMs;
      s.rotation = m.rotation;
      scheduleRelease();
      break;
    }
    case 'detach':
      slots[m.slot].clear();
      break;
    case 'composite':
      if (m.fps !== comp.fps) restartTicker();
      comp.size = m.size;
      comp.arrangement = m.arrangement;
      comp.fps = m.fps;
      comp.locked = m.locked;
      if (m.locked) computeLayout();
      break;
  }
};
