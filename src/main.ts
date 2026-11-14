import { AudioChain } from './audio';
import { findDevice, listDevices, openCamera, openMic, unlockLabels, type DeviceLists } from './devices';
import { layoutPanes } from './layout';
import { Pipeline } from './pipeline';
import { SLOTS, type Arrangement, type Rotation, type Slot, type SlotStats } from './protocol';
import { extFor, pickMime, Take, takeName, writeTextFile, type OutputSpec } from './recorder';
import {
  AUDIO_OFFSET_LIMIT,
  cameraPrefs,
  delays,
  loadSettings,
  saveSettings,
  VIDEO_OFFSET_LIMIT,
  type Resolution,
} from './settings';
import { canPickFolder, ensureWritable, loadDir, pickDir } from './storage';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

if (!('MediaStreamTrackProcessor' in window) || !('MediaStreamTrackGenerator' in window)) {
  document.body.innerHTML =
    '<p style="padding:24px">This app needs Chrome (or another Chromium browser such as Edge or Arc).</p>';
  throw new Error('unsupported browser');
}

const settings = loadSettings();
const persist = () => saveSettings(settings);
const pipeline = new Pipeline();
const audio = new AudioChain();

let devices: DeviceLists = { cameras: [], mics: [] };
let dir: FileSystemDirectoryHandle | null = null;
let take: Take | null = null;
let takeMeta: Record<string, unknown> & { take: string } = { take: '' };
let takeT0 = 0;
let takeTimer: ReturnType<typeof setInterval> | undefined;
let frozen = false;
let busy = false; // record start/stop in progress
let lastStats: { slots: Record<Slot, SlotStats>; composite: { width: number; height: number; fps: number } } | null = null;

// ---------- toast ----------

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, error = false, ms = 6000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.textContent = ''), ms);
}

// ---------- panes ----------

interface Pane {
  root: HTMLElement;
  cam: HTMLSelectElement;
  res: HTMLSelectElement;
  fps: HTMLSelectElement;
  rot: HTMLButtonElement;
  mir: HTMLButtonElement;
  video: HTMLVideoElement;
  placeholder: HTMLElement;
  foot: HTMLElement;
  track: MediaStreamTrack | null; // the raw camera track
  label: string;
  openSeq: number;
}

const stage = $('#stage');
const tpl = $<HTMLTemplateElement>('#paneTpl');
const outputPane = $('#outputPane');
const outputVideo = $<HTMLVideoElement>('video', outputPane);

const panes = {} as Record<Slot, Pane>;
for (const slot of SLOTS) {
  const root = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  stage.insertBefore(root, outputPane);
  const p: Pane = {
    root,
    cam: $('.cam', root),
    res: $('.res', root),
    fps: $('.fps', root),
    rot: $('.rot', root),
    mir: $('.mir', root),
    video: $('video', root),
    placeholder: $('.placeholder', root),
    foot: $('.pane-foot', root),
    track: null,
    label: '',
    openSeq: 0,
  };
  $('.tag', root).textContent = slot;
  p.res.value = String(settings.slots[slot].resolution);
  p.fps.value = String(settings.slots[slot].fps);
  panes[slot] = p;

  p.cam.onchange = () => {
    const d = devices.cameras.find((c) => c.deviceId === p.cam.value);
    settings.slots[slot].deviceId = d?.deviceId ?? '';
    settings.slots[slot].label = d?.label ?? '';
    persist();
    openSlot(slot);
  };
  p.res.onchange = () => {
    settings.slots[slot].resolution = Number(p.res.value) as Resolution;
    persist();
    openSlot(slot);
  };
  p.fps.onchange = () => {
    settings.slots[slot].fps = Number(p.fps.value) as 30 | 60;
    persist();
    openSlot(slot);
  };
  p.rot.onclick = () => {
    if (!p.label) return;
    const prefs = cameraPrefs(settings, p.label);
    settings.cameras[p.label] = { ...prefs, rotation: (((prefs.rotation + 90) % 360) as Rotation) };
    persist();
    applyConfig();
  };
  p.mir.onclick = () => {
    if (!p.label) return;
    const prefs = cameraPrefs(settings, p.label);
    settings.cameras[p.label] = { ...prefs, mirror: !prefs.mirror };
    persist();
    applyConfig();
  };
  p.video.addEventListener('resize', relayout);
}
outputVideo.addEventListener('resize', relayout);

const cleanLabel = (l: string) => l.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');

function fillSelect(sel: HTMLSelectElement, list: MediaDeviceInfo[], value: string, noneLabel: string) {
  sel.replaceChildren(new Option(noneLabel, ''), ...list.map((d) => new Option(cleanLabel(d.label) || 'Unnamed device', d.deviceId)));
  sel.value = list.some((d) => d.deviceId === value) ? value : '';
}

function setPaneEmpty(slot: Slot, msg: string | null) {
  const p = panes[slot];
  p.root.classList.toggle('empty', msg !== null);
  p.placeholder.textContent = msg ?? '';
}

// ---------- cameras ----------

async function openSlot(slot: Slot) {
  const p = panes[slot];
  const seq = ++p.openSeq;
  const s = settings.slots[slot];
  closeSlot(slot);
  const dev = findDevice(devices.cameras, s.deviceId, s.label);
  if (!dev) {
    setPaneEmpty(slot, s.deviceId ? `${cleanLabel(s.label) || 'Camera'} is not connected` : 'No camera selected');
    p.cam.value = '';
    return;
  }
  s.deviceId = dev.deviceId; // id may have changed after a re-plug
  p.cam.value = dev.deviceId;
  setPaneEmpty(slot, 'Starting camera…');
  try {
    const track = await openCamera(dev.deviceId, s.resolution, s.fps);
    if (seq !== p.openSeq) {
      track.stop(); // superseded by a newer selection
      return;
    }
    p.track = track;
    p.label = dev.label;
    track.addEventListener('ended', () => {
      if (p.track !== track) return;
      closeSlot(slot);
      setPaneEmpty(slot, `${cleanLabel(dev.label)} disconnected — waiting for it to come back`);
      toast(`Camera ${slot} disconnected`, true);
    });
    pipeline.attach(slot, track);
    setPaneEmpty(slot, null);
    applyConfig();
  } catch (err) {
    if (seq !== p.openSeq) return;
    const e = err as DOMException;
    const why =
      e.name === 'NotReadableError'
        ? 'Camera is in use by another app, or failed to start'
        : e.name === 'NotAllowedError'
          ? 'Camera permission denied'
          : `${e.name}: ${e.message}`;
    setPaneEmpty(slot, why);
  }
}

function closeSlot(slot: Slot) {
  const p = panes[slot];
  pipeline.detach(slot);
  p.track?.stop();
  p.track = null;
  p.label = '';
}

// ---------- mic ----------

let micSeq = 0;
async function openAudio() {
  const seq = ++micSeq;
  const dev = findDevice(devices.mics, settings.audioDeviceId, settings.audioLabel);
  if (!dev) {
    audio.setMic(null);
    micSel.value = '';
    return;
  }
  settings.audioDeviceId = dev.deviceId;
  micSel.value = dev.deviceId;
  try {
    const track = await openMic(dev.deviceId);
    if (seq !== micSeq) return track.stop();
    audio.setMic(track);
    track.addEventListener('ended', () => toast('Microphone disconnected', true));
  } catch (err) {
    audio.setMic(null);
    toast(`Microphone failed: ${(err as Error).message}`, true);
  }
}

// ---------- sync controls ----------

const videoRange = $<HTMLInputElement>('#videoRange');
const videoNum = $<HTMLInputElement>('#videoNum');
const audioRange = $<HTMLInputElement>('#audioRange');
const audioNum = $<HTMLInputElement>('#audioNum');
const micSel = $<HTMLSelectElement>('#micSel');

const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, Math.round(v) || 0));

function frameMs() {
  return Math.round(1000 / Math.min(settings.slots.A.fps, settings.slots.B.fps));
}

function setVideoOffset(v: number) {
  settings.videoOffsetMs = clamp(v, VIDEO_OFFSET_LIMIT);
  persist();
  applyConfig();
}
function setAudioOffset(v: number) {
  settings.audioOffsetMs = Math.max(-500, clamp(v, AUDIO_OFFSET_LIMIT));
  persist();
  applyConfig();
}

videoRange.oninput = () => setVideoOffset(Number(videoRange.value));
videoNum.onchange = () => setVideoOffset(Number(videoNum.value));
audioRange.oninput = () => setAudioOffset(Number(audioRange.value));
audioNum.onchange = () => setAudioOffset(Number(audioNum.value));
for (const b of document.querySelectorAll<HTMLButtonElement>('.nudge')) {
  b.onclick = () => {
    const raw = b.dataset.step!;
    const step = raw === 'frame' ? frameMs() : raw === '-frame' ? -frameMs() : Number(raw);
    if (b.dataset.target === 'video') setVideoOffset(settings.videoOffsetMs + step);
    else setAudioOffset(settings.audioOffsetMs + step);
  };
}
micSel.onchange = () => {
  audio.resume();
  const d = devices.mics.find((m) => m.deviceId === micSel.value);
  settings.audioDeviceId = d?.deviceId ?? '';
  settings.audioLabel = d?.label ?? '';
  persist();
  openAudio();
};

/** Push current settings to the worker/audio chain and refresh every control. */
function applyConfig() {
  const d = delays(settings);
  for (const slot of SLOTS) {
    const p = panes[slot];
    const prefs = cameraPrefs(settings, p.label);
    pipeline.configureSlot(slot, d[slot], p.label ? prefs.rotation : 0);
    p.video.classList.toggle('mirror', !!p.label && prefs.mirror);
    p.mir.classList.toggle('on', !!p.label && prefs.mirror);
    p.rot.textContent = p.label && prefs.rotation ? `⟳${prefs.rotation}°` : '⟳';
  }
  audio.setDelay(d.audio);
  configureComposite(take !== null);

  const v = settings.videoOffsetMs;
  videoRange.value = String(v);
  videoNum.value = String(v);
  $('#videoDesc').textContent = v === 0 ? 'No offset' : v > 0 ? `Delaying B by ${v} ms` : `Delaying A by ${-v} ms`;
  const a = settings.audioOffsetMs;
  audioRange.value = String(a);
  audioNum.value = String(a);
  $('#audioDesc').textContent =
    a === 0 ? 'No offset' : a > 0 ? `Delaying audio by ${a} ms` : `Delaying both videos by ${-a} ms`;
  renderFoot();
}

// ---------- output settings, view, freeze ----------

function configureComposite(locked: boolean) {
  pipeline.configureComposite({
    size: settings.outSize,
    fps: settings.outFps,
    arrangement: settings.arrangement,
    locked,
  });
}

const outSize = $<HTMLSelectElement>('#outSize');
const outFps = $<HTMLSelectElement>('#outFps');
const saveIndividual = $<HTMLInputElement>('#saveIndividual');
outSize.value = String(settings.outSize);
outFps.value = String(settings.outFps);
saveIndividual.checked = settings.saveIndividual;
outSize.onchange = () => {
  settings.outSize = Number(outSize.value) as 720 | 1080 | 1440;
  persist();
  applyConfig();
};
outFps.onchange = () => {
  settings.outFps = Number(outFps.value) as 30 | 60;
  persist();
  applyConfig();
};
saveIndividual.onchange = () => {
  settings.saveIndividual = saveIndividual.checked;
  persist();
};

function setView(v: 'cameras' | 'output') {
  settings.view = v;
  persist();
  for (const slot of SLOTS) panes[slot].root.hidden = v !== 'cameras';
  outputPane.hidden = v !== 'output';
  $('#viewCams').classList.toggle('on', v === 'cameras');
  $('#viewOut').classList.toggle('on', v === 'output');
  relayout();
}
function setArrangement(a: Arrangement) {
  settings.arrangement = a;
  persist();
  $('#arrSide').classList.toggle('on', a === 'side');
  $('#arrStacked').classList.toggle('on', a === 'stacked');
  configureComposite(take !== null);
  relayout();
}
$('#arrSide').onclick = () => setArrangement('side');
$('#arrStacked').onclick = () => setArrangement('stacked');

$('#viewCams').onclick = () => setView('cameras');
$('#viewOut').onclick = () => setView('output');

function allVideos() {
  return [...SLOTS.map((s) => panes[s].video), outputVideo];
}
function setFrozen(f: boolean) {
  frozen = f;
  document.body.classList.toggle('frozen', f);
  $('#freezeBtn').classList.toggle('on', f);
  for (const v of allVideos()) {
    if (f) v.pause();
    else v.play().catch(() => {});
  }
}
$('#freezeBtn').onclick = () => setFrozen(!frozen);

// ---------- layout ----------

function aspectOf(v: HTMLVideoElement) {
  return v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
}

function relayout() {
  const visible = settings.view === 'output' ? [outputPane] : SLOTS.map((s) => panes[s].root);
  const videos = settings.view === 'output' ? [outputVideo] : SLOTS.map((s) => panes[s].video);
  const placed = layoutPanes(stage, videos.map(aspectOf), settings.arrangement === 'stacked');
  stage.classList.toggle('stacked', placed.stacked);
  visible.forEach((pane, i) => {
    const box = $('.pane-video', pane);
    pane.style.width = `${placed.sizes[i].w + 2}px`; // header must not widen the pane
    box.style.width = `${placed.sizes[i].w}px`;
    box.style.height = `${placed.sizes[i].h}px`;
  });
}
new ResizeObserver(relayout).observe(stage);

// ---------- stats ----------

function renderFoot() {
  const d = delays(settings);
  for (const slot of SLOTS) {
    const p = panes[slot];
    const st = lastStats?.slots[slot];
    if (!p.track || !st) {
      p.foot.textContent = '';
      continue;
    }
    p.foot.textContent = `${st.fps} fps · ${st.width}×${st.height} · delay ${d[slot]} ms`;
  }
  const c = lastStats?.composite;
  const out = c?.width ? `${c.width}×${c.height} @ ${settings.outFps}fps` : '—';
  $('#outputFoot').textContent = c?.width ? `${out} · rendering ${c.fps} fps` : 'No cameras';
  $('#outInfo').textContent = `Output ${out}`;
}

pipeline.onStats = (s) => {
  lastStats = s;
  renderFoot();
};

function meterLoop() {
  $('#meterBar').style.width = `${Math.round(audio.level() * 100)}%`;
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

// ---------- folder ----------

function renderFolder() {
  $('#folderName').textContent = dir ? dir.name : canPickFolder ? 'Choose folder…' : 'Downloads';
}
$('#folderBtn').onclick = async () => {
  if (!canPickFolder) return toast('Folder picking not supported here; takes go to Downloads.');
  try {
    dir = await pickDir();
    renderFolder();
  } catch {
    /* cancelled */
  }
};

// ---------- recording ----------

const recBtn = $<HTMLButtonElement>('#recBtn');

function setLocked(locked: boolean) {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    '.lockable, .pane select.cam, #folderBtn',
  )) {
    el.disabled = locked;
  }
}

function bitrate(w: number, h: number, fps: number) {
  return Math.round(Math.min(40e6, Math.max(4e6, w * h * fps * 0.15)));
}

async function startRecording() {
  audio.resume();
  const c = lastStats?.composite;
  if (!c?.width) return toast('No camera is running — nothing to record.', true);

  if (dir && !(await ensureWritable(dir).catch(() => false))) {
    return toast('No permission to write to the folder. Click 📁 to choose it again.', true);
  }
  if (!dir && canPickFolder) {
    try {
      dir = await pickDir();
      renderFolder();
    } catch {
      return toast('Choose a folder to save recordings in.', true);
    }
  }

  const withAudio = audio.hasMic;
  const mime = pickMime(withAudio);
  const ext = extFor(mime);
  const started = new Date();
  const name = takeName(started);
  const audioTracks = withAudio ? [audio.track] : [];
  const fps = settings.outFps;

  // Lock the combined layout before the recorders see any frames.
  configureComposite(true);
  const specs: OutputSpec[] = [
    {
      name: `${name}.${ext}`,
      stream: new MediaStream([pipeline.tracks.C, ...audioTracks]),
      mime,
      videoBitsPerSecond: bitrate(c.width, c.height, fps),
    },
  ];
  if (settings.saveIndividual) {
    for (const slot of SLOTS) {
      const st = lastStats?.slots[slot];
      if (!panes[slot].track || !st?.width) continue;
      specs.push({
        name: `${name}_${slot}.${ext}`,
        stream: new MediaStream([pipeline.tracks[slot], ...audioTracks]),
        mime,
        videoBitsPerSecond: bitrate(st.width, st.height, settings.slots[slot].fps),
      });
    }
  }

  try {
    take = await Take.start(dir, specs);
  } catch (err) {
    configureComposite(false);
    return toast(`Could not start recording: ${(err as Error).message}`, true);
  }

  const meta = {
    take: name,
    startedAt: take.startedAt.toISOString(),
    files: specs.map((s) => s.name),
    mimeType: mime,
    composite: { width: c.width, height: c.height, fps },
    videoOffsetMs: settings.videoOffsetMs,
    audioOffsetMs: settings.audioOffsetMs,
    appliedDelaysMs: delays(settings),
    cameras: Object.fromEntries(
      SLOTS.map((slot) => {
        const p = panes[slot];
        return [
          slot,
          p.track
            ? { label: p.label, rotation: cameraPrefs(settings, p.label).rotation, settings: p.track.getSettings() }
            : null,
        ];
      }),
    ),
    microphone: withAudio ? settings.audioLabel : null,
  };
  takeMeta = meta;
  const t0 = (takeT0 = performance.now());
  const recTime = $('#recTime');
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  recTime.textContent = '00:00';
  takeTimer = setInterval(() => (recTime.textContent = fmt((performance.now() - t0) / 1000)), 250);
  $('#recIndicator').hidden = false;
  recBtn.textContent = '■ Stop';
  recBtn.classList.add('recording');
  setLocked(true);
  toast(`Recording ${name}${withAudio ? '' : ' (no audio)'}`, false, 0);
}

async function stopRecording() {
  const t = take;
  if (!t) return;
  clearInterval(takeTimer);
  toast('Finishing files…', false, 0);
  await t.stop();
  const meta = takeMeta;
  take = null;
  configureComposite(false);
  $('#recIndicator').hidden = true;
  recBtn.textContent = '● Record';
  recBtn.classList.remove('recording');
  setLocked(false);

  const durationS = Math.round((performance.now() - takeT0) / 100) / 10;
  const errors = t.errors;
  await writeTextFile(dir, `${meta.take}.json`, JSON.stringify({ ...meta, durationS, errors }, null, 2)).catch(() => {});
  if (errors.length) toast(`Recording had errors: ${errors.join('; ')}`, true, 0);
  else toast(`Saved ${meta.take} (${durationS}s) to ${dir ? dir.name || 'folder' : 'Downloads'}`);
}

recBtn.onclick = async () => {
  if (busy) return;
  busy = true;
  try {
    if (take) await stopRecording();
    else await startRecording();
  } finally {
    busy = false;
  }
};

window.addEventListener('beforeunload', (e) => {
  if (take) e.preventDefault();
});

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    recBtn.click();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (take) return;
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    setVideoOffset(settings.videoOffsetMs + dir * (e.shiftKey ? 10 : frameMs()));
  } else if (e.key === 'f' || e.key === 'F') {
    setFrozen(!frozen);
  } else if ((e.key === 'l' || e.key === 'L') && !take) {
    setArrangement(settings.arrangement === 'side' ? 'stacked' : 'side');
  } else if (e.key === 'v' || e.key === 'V') {
    setView(settings.view === 'cameras' ? 'output' : 'cameras');
  }
});
// Arrow keys on a focused slider would move it too; route them through our handler only.
for (const r of [videoRange, audioRange]) r.addEventListener('keydown', (e) => e.key.startsWith('Arrow') && e.preventDefault());

// ---------- devices ----------

function chooseDefaults() {
  const cams = devices.cameras;
  const a = settings.slots.A;
  const b = settings.slots.B;
  if (!a.deviceId && !b.deviceId && cams.length) {
    const builtIn = cams.find((c) => /facetime|built-in|macbook/i.test(c.label)) ?? cams[0];
    const other = cams.find((c) => c !== builtIn);
    Object.assign(a, { deviceId: builtIn.deviceId, label: builtIn.label });
    if (other) Object.assign(b, { deviceId: other.deviceId, label: other.label });
  }
  if (!settings.audioDeviceId && !settings.audioLabel && devices.mics.length) {
    const builtIn = devices.mics.find((m) => /macbook|built-in/i.test(m.label)) ?? devices.mics[0];
    settings.audioDeviceId = builtIn.deviceId;
    settings.audioLabel = builtIn.label;
  }
  persist();
}

function renderDeviceSelects() {
  for (const slot of SLOTS) fillSelect(panes[slot].cam, devices.cameras, settings.slots[slot].deviceId, '— No camera —');
  fillSelect(micSel, devices.mics, settings.audioDeviceId, '— No audio —');
  // fillSelect matches by id; re-match by label for devices whose id changed.
  for (const slot of SLOTS) {
    const s = settings.slots[slot];
    const d = findDevice(devices.cameras, s.deviceId, s.label);
    if (d) panes[slot].cam.value = d.deviceId;
  }
  const m = findDevice(devices.mics, settings.audioDeviceId, settings.audioLabel);
  if (m) micSel.value = m.deviceId;
}

navigator.mediaDevices.addEventListener('devicechange', async () => {
  devices = await listDevices();
  renderDeviceSelects();
  if (take) return; // don't reshuffle cameras mid-take
  for (const slot of SLOTS) {
    const s = settings.slots[slot];
    if (!panes[slot].track && s.deviceId && findDevice(devices.cameras, s.deviceId, s.label)) openSlot(slot);
  }
  if (settings.audioDeviceId && !audio.hasMic && findDevice(devices.mics, settings.audioDeviceId, settings.audioLabel)) {
    openAudio();
  }
});

// Browsers only start audio after a user gesture.
window.addEventListener('pointerdown', () => audio.resume());
window.addEventListener('keydown', () => audio.resume());

/**
 * A <video> showing a track with no frames yet holds the page's load event open,
 * and Chrome won't show the camera permission prompt until the page has loaded.
 * So: wait for load, then connect the previews.
 */
async function attachPreviewsAfterLoad() {
  if (document.readyState !== 'complete') {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
  }
  for (const slot of SLOTS) panes[slot].video.srcObject = new MediaStream([pipeline.tracks[slot]]);
  outputVideo.srcObject = new MediaStream([pipeline.tracks.C]);
}

async function init() {
  await attachPreviewsAfterLoad();
  setArrangement(settings.arrangement);
  setView(settings.view);
  applyConfig();
  for (const slot of SLOTS) setPaneEmpty(slot, 'Waiting for camera permission…');
  await unlockLabels();
  devices = await listDevices();
  if (!devices.cameras.length) {
    for (const slot of SLOTS) setPaneEmpty(slot, 'No cameras found (or permission denied)');
  }
  chooseDefaults();
  renderDeviceSelects();
  dir = await loadDir();
  renderFolder();
  await Promise.all([...SLOTS.map(openSlot), openAudio()]);
}

init();
