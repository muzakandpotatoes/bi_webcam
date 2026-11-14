// Records one or more MediaStreams at once, streaming each straight to a file.

const CANDIDATES = [
  // [container, video codec, audio codec]
  ['video/mp4', 'avc1.640033', 'mp4a.40.2'],
  ['video/mp4', 'avc1', 'mp4a.40.2'],
  ['video/mp4', 'avc1', 'opus'],
  ['video/webm', 'vp9', 'opus'],
  ['video/webm', 'vp8', 'opus'],
] as const;

export function pickMime(withAudio: boolean): string {
  for (const [c, v, a] of CANDIDATES) {
    const mime = `${c};codecs=${withAudio ? `${v},${a}` : v}`;
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

export const extFor = (mime: string) => (mime.startsWith('video/mp4') ? 'mp4' : 'webm');

interface Sink {
  write(b: Blob): Promise<void>;
  close(): Promise<void>;
}

async function fileSink(dir: FileSystemDirectoryHandle, name: string): Promise<Sink> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  return { write: (b) => w.write(b), close: () => w.close() };
}

function downloadSink(name: string): Sink {
  const parts: Blob[] = [];
  return {
    async write(b) {
      parts.push(b);
    },
    async close() {
      downloadBlob(new Blob(parts, { type: parts[0]?.type }), name);
    },
  };
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function writeTextFile(dir: FileSystemDirectoryHandle | null, name: string, text: string) {
  const sink = dir ? await fileSink(dir, name) : downloadSink(name);
  await sink.write(new Blob([text], { type: 'application/json' }));
  await sink.close();
}

export interface OutputSpec {
  name: string; // file name incl. extension
  stream: MediaStream;
  mime: string;
  videoBitsPerSecond: number;
}

class Output {
  private rec: MediaRecorder;
  private chain: Promise<void> = Promise.resolve();
  private done: Promise<void>;
  error: string | null = null;

  constructor(spec: OutputSpec, private sink: Sink) {
    this.rec = new MediaRecorder(spec.stream, {
      mimeType: spec.mime || undefined,
      videoBitsPerSecond: spec.videoBitsPerSecond,
      audioBitsPerSecond: 192_000,
    });
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chain = this.chain.then(() => sink.write(e.data));
      this.chain.catch((err) => (this.error ??= String(err)));
    };
    this.done = new Promise((resolve) => {
      this.rec.onstop = () => resolve();
    });
    this.rec.onerror = (e) => (this.error ??= String((e as ErrorEvent).error ?? 'recorder error'));
  }

  start() {
    this.rec.start(1000);
  }

  async stop() {
    if (this.rec.state !== 'inactive') this.rec.stop();
    await this.done;
    await this.chain.catch(() => {});
    await this.sink.close();
  }
}

export class Take {
  private constructor(
    private outputs: Output[],
    readonly startedAt: Date,
  ) {}

  /** Opens every file first, then starts all recorders in the same tick so they line up. */
  static async start(dir: FileSystemDirectoryHandle | null, specs: OutputSpec[]): Promise<Take> {
    const sinks = await Promise.all(specs.map((s) => (dir ? fileSink(dir, s.name) : downloadSink(s.name))));
    const outputs = specs.map((s, i) => new Output(s, sinks[i]));
    const startedAt = new Date();
    for (const o of outputs) o.start();
    return new Take(outputs, startedAt);
  }

  get errors() {
    return this.outputs.map((o) => o.error).filter(Boolean) as string[];
  }

  async stop() {
    await Promise.all(this.outputs.map((o) => o.stop()));
  }
}

export function takeName(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `take_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
