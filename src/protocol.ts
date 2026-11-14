// Messages between the main thread and the frame pipeline worker.

export type Slot = 'A' | 'B';
export const SLOTS: readonly Slot[] = ['A', 'B'];
export type Rotation = 0 | 90 | 180 | 270;
export type Arrangement = 'side' | 'stacked';

export interface CompositeConfig {
  /** Quality as a 16:9 'Np' figure: side-by-side shares height N, stacked shares width N·16/9. */
  size: number;
  fps: number;
  arrangement: Arrangement;
  /** Freeze the layout (during recording). */
  locked: boolean;
}

export type ToWorker =
  /** A raw camera frame (transferred). */
  | { type: 'frame'; slot: Slot; frame: VideoFrame }
  /** Per-slot processing settings. */
  | { type: 'slotConfig'; slot: Slot; delayMs: number; rotation: Rotation }
  /** Camera removed/switched: drop everything held for this slot. */
  | { type: 'detach'; slot: Slot }
  /** Combined output settings. */
  | ({ type: 'composite' } & CompositeConfig);

export interface SlotStats {
  /** Frames per second arriving from the camera. */
  fps: number;
  /** Frame size after rotation. 0 when no frames yet. */
  width: number;
  height: number;
  /** Frames currently held in the delay queue. */
  queued: number;
}

export type FromWorker =
  /** A processed frame ready to display/record (transferred). `out` C = combined. */
  | { type: 'out'; out: Slot | 'C'; frame: VideoFrame }
  | {
      type: 'stats';
      slots: Record<Slot, SlotStats>;
      composite: { width: number; height: number; fps: number };
    };
