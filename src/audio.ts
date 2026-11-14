// Mic -> DelayNode -> a MediaStreamTrack the recorders can use, plus a level meter.

const MAX_DELAY_S = 2;

export class AudioChain {
  private ctx = new AudioContext({ latencyHint: 'interactive' });
  private delay = this.ctx.createDelay(MAX_DELAY_S);
  private analyser = this.ctx.createAnalyser();
  private dest = this.ctx.createMediaStreamDestination();
  private source: MediaStreamAudioSourceNode | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private buf: Float32Array<ArrayBuffer>;

  /** Delayed mic audio. Stable for the app's lifetime (silent when no mic). */
  readonly track: MediaStreamTrack;

  constructor() {
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.delay.connect(this.dest);
    this.track = this.dest.stream.getAudioTracks()[0];
  }

  get hasMic() {
    return this.micTrack !== null && this.micTrack.readyState === 'live';
  }

  /** AudioContexts start suspended until a user gesture. */
  resume() {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setMic(track: MediaStreamTrack | null) {
    this.source?.disconnect();
    this.source = null;
    this.micTrack?.stop();
    this.micTrack = track;
    if (track) {
      this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      this.source.connect(this.delay);
      this.source.connect(this.analyser); // meter shows the live (undelayed) level
    }
  }

  setDelay(ms: number) {
    this.delay.delayTime.setValueAtTime(Math.min(ms, MAX_DELAY_S * 1000) / 1000, this.ctx.currentTime);
  }

  /** Peak level 0..1 of the live mic. */
  level(): number {
    if (!this.source) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }
}
