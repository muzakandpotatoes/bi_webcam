// Sizes video boxes so each matches its feed's shape: side-by-side shares a
// height, stacked shares a width (same rule as the combined recording).

export interface Placement {
  stacked: boolean;
  sizes: { w: number; h: number }[];
}

/** Narrowest video box that still fits the pane's header controls. */
const MIN_W = 360;

export function layoutPanes(stage: HTMLElement, aspects: number[], stacked: boolean): Placement {
  const css = getComputedStyle(stage);
  const px = (v: string) => parseFloat(css.getPropertyValue(v)) || 0;
  const gap = px('--gap');
  const chromeH = px('--head-h') + px('--foot-h') + 2; // header + footer + pane border
  const chromeW = 2;
  const W = stage.clientWidth - 2 * gap;
  const H = stage.clientHeight - 2 * gap;
  const n = aspects.length;

  // Side by side: one shared video height h. Panes narrower than MIN_W (portrait
  // feeds) are widened to fit their controls; the picture is pillarboxed inside.
  const avail = W - gap * (n - 1) - n * chromeW;
  let sideH = Math.max(0, H - chromeH);
  for (let pass = 0; pass < n; pass++) {
    const narrow = aspects.filter((a) => a * sideH < MIN_W);
    const wide = aspects.filter((a) => a * sideH >= MIN_W);
    const room = avail - narrow.length * MIN_W;
    const sumWide = wide.reduce((a, b) => a + b, 0);
    const h = sumWide ? Math.min(H - chromeH, room / sumWide) : H - chromeH;
    if (Math.abs(h - sideH) < 0.5) break;
    sideH = Math.max(0, h);
  }
  const side = aspects.map((a) => ({ w: Math.max(MIN_W, a * sideH), h: sideH }));

  // Stacked: one shared video width w.
  const sumInv = aspects.reduce((a, b) => a + 1 / b, 0);
  const stackW = Math.max(MIN_W, Math.min(W - chromeW, (H - gap * (n - 1) - n * chromeH) / sumInv));
  const stack = aspects.map((a) => ({ w: stackW, h: stackW / a }));

  const sizes = (stacked ? stack : side).map((r) => ({ w: Math.floor(r.w), h: Math.floor(r.h) }));
  return { stacked, sizes };
}
