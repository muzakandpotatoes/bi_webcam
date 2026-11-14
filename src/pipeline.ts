// Main-thread side of the frame pipeline: feeds camera frames to the worker and
// turns the worker's output frames back into MediaStreamTracks.

import type { CompositeConfig, FromWorker, Rotation, Slot, ToWorker } from './protocol';

type Out = Slot | 'C';

export class Pipeline {
  private worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
  private generators = {} as Record<Out, MediaStreamTrackGenerator<VideoFrame>>;
  private writers = {} as Record<Out, WritableStreamDefaultWriter<VideoFrame>>;
  private readers: Partial<Record<Slot, ReadableStreamDefaultReader<VideoFrame>>> = {};

  /** Delayed + rotated per-camera tracks (A, B) and the combined track (C). Stable for the app's lifetime. */
  readonly tracks = {} as Record<Out, MediaStreamTrack>;

  onStats: (s: Extract<FromWorker, { type: 'stats' }>) => void = () => {};

  constructor() {
    for (const out of ['A', 'B', 'C'] as const) {
      const gen = new MediaStreamTrackGenerator<VideoFrame>({ kind: 'video' });
      this.generators[out] = gen;
      this.writers[out] = gen.writable.getWriter();
      this.tracks[out] = gen;
    }
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'out') {
        // The generator takes ownership of the frame and closes it.
        this.writers[m.out].write(m.frame).catch(() => m.frame.close());
      } else {
        this.onStats(m);
      }
    };
  }

  private send(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  attach(slot: Slot, track: MediaStreamTrack) {
    this.detach(slot);
    const reader = new MediaStreamTrackProcessor<VideoFrame>({ track }).readable.getReader();
    this.readers[slot] = reader;
    (async () => {
      for (;;) {
        let r: ReadableStreamReadResult<VideoFrame>;
        try {
          r = await reader.read();
        } catch {
          return;
        }
        if (r.done) return;
        if (this.readers[slot] !== reader) {
          r.value.close();
          return;
        }
        this.send({ type: 'frame', slot, frame: r.value }, [r.value]);
      }
    })();
  }

  detach(slot: Slot) {
    const reader = this.readers[slot];
    if (reader) {
      delete this.readers[slot];
      reader.cancel().catch(() => {});
    }
    this.send({ type: 'detach', slot });
  }

  configureSlot(slot: Slot, delayMs: number, rotation: Rotation) {
    this.send({ type: 'slotConfig', slot, delayMs, rotation });
  }

  configureComposite(config: CompositeConfig) {
    this.send({ type: 'composite', ...config });
  }
}
