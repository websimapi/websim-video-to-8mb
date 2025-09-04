import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';
/* ...existing code... */
const els = {
  file: document.getElementById('fileInput'),
  btn: document.getElementById('encodeBtn'),
  target: document.getElementById('targetSize'),
  quality: document.getElementById('quality'),
  pWrap: document.getElementById('progressWrap'),
  pBar: document.getElementById('progressBar'),
  pText: document.getElementById('status'),
  pPct: document.getElementById('percent'),
  result: document.getElementById('result'),
  outVideo: document.getElementById('outVideo'),
  outInfo: document.getElementById('outInfo'),
  dl: document.getElementById('downloadLink'),
  parts: document.getElementById('parts')
};
let ffmpeg, file, duration = 0, srcDims = { w: 0, h: 0 };

const initFFmpeg = async () => {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress, time }) => {
    els.pBar.style.width = `${Math.round(progress * 100)}%`;
    els.pPct.textContent = `${Math.round(progress * 100)}%`;
    els.pText.textContent = time ? `Processing…` : 'Starting…';
  });
  const base = 'https://unpkg.com/@ffmpeg/core@0.12.4/dist/';
  await ffmpeg.load({
    coreURL: await toBlobURL(base + 'ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURL(base + 'ffmpeg-core.wasm', 'application/wasm')
  });
  return ffmpeg;
};

els.file.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  file = f || null;
  els.btn.disabled = !file;
  if (!file) return;
  // probe duration and size via HTMLVideoElement
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.src = url;
  await new Promise((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error('Metadata load failed'));
  }).catch(() => {});
  duration = isFinite(v.duration) ? v.duration : 0;
  srcDims = { w: v.videoWidth || 0, h: v.videoHeight || 0 };
  URL.revokeObjectURL(url);
});

const chooseScale = (bitrateKbps) => {
  // Simple heuristic based on available bitrate
  const candidates = [
    { w: 1280, h: 720, minK: 2500 },
    { w: 960,  h: 540, minK: 1500 },
    { w: 854,  h: 480, minK: 1000 },
    { w: 640,  h: 360, minK: 600 },
    { w: 426,  h: 240, minK: 350 },
    { w: 320,  h: 180, minK: 200 }
  ];
  let target = candidates[candidates.length - 1];
  for (const c of candidates) if (bitrateKbps >= c.minK) { target = c; break; }
  // do not upscale
  if (srcDims.w && srcDims.h) {
    const scaleDown = Math.min(1, target.w / srcDims.w, target.h / srcDims.h);
    return {
      w: Math.floor(Math.max(16, srcDims.w * scaleDown) / 2) * 2,
      h: Math.floor(Math.max(16, srcDims.h * scaleDown) / 2) * 2
    };
  }
  return target;
};

const buildArgs = ({ vBitrateK, aBitrateK, speed, scale, ss, t, outName = 'out.webm' }) => {
  const maxrateK = Math.round(vBitrateK * 1.5);
  const bufsizeK = Math.round(vBitrateK * 2.0);
  const speedMap = { speed: '6', balanced: '4', quality: '2' };
  return [
    '-i', 'input',
    ...(ss != null ? ['-ss', String(ss)] : []),
    ...(t != null ? ['-t', String(t)] : []),
    '-c:v', 'libvpx-vp9',
    '-b:v', `${vBitrateK}k`,
    '-maxrate', `${maxrateK}k`,
    '-bufsize', `${bufsizeK}k`,
    '-row-mt', '1',
    '-tile-columns', '1',
    '-threads', '4',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=${scale.w}:${scale.h}:flags=lanczos`,
    '-speed', speedMap[speed] || '4',
    '-c:a', 'libopus',
    '-b:a', `${aBitrateK}k`,
    '-movflags', '+faststart',
    '-y', outName
  ];
};

const encodeOnce = async (vBitrateK, aBitrateK, speed, scale, ss = null, t = null, outName = 'out.webm') => {
  const ff = await initFFmpeg();
  await ff.writeFile('input', await fetchFile(file));
  const args = buildArgs({ vBitrateK, aBitrateK, speed, scale, ss, t, outName });
  await ff.exec(args);
  const data = await ff.readFile(outName);
  await ff.deleteFile('input'); await ff.deleteFile(outName);
  return new Blob([data], { type: 'video/webm' });
};

const targetUnderBytes = (mb) => Math.max(1, Math.floor(mb)) * 1024 * 1024;

els.btn.addEventListener('click', async () => {
  if (!file) return;
  els.result.classList.add('hidden');
  els.pWrap.classList.remove('hidden');
  els.pText.textContent = 'Preparing…'; els.pPct.textContent = '0%'; els.pBar.style.width = '0%';

  try {
    const targetMB = Number(els.target.value || 8);
    const targetBytes = targetUnderBytes(targetMB);
    const audioK = 64; // kbps
    const minVideoK = 180; // floor for safety
    const maxVideoK = 6000; // ceiling
    const dur = duration || Math.max(1, file.size / (2_000_000)); // rough fallback
    // Budget bits: leave ~5% headroom for container/overhead
    const totalBits = Math.max(1, (targetBytes * 8) * 0.95);
    const videoBits = Math.max(1, totalBits - (audioK * 1000 * dur));
    let vBitrateK = Math.max(minVideoK, Math.min(maxVideoK, Math.floor(videoBits / (1000 * dur))));

    // Decide scale before first pass
    let scale = chooseScale(vBitrateK);
    const speed = els.quality.value;

    // Try up to 3 attempts tightening bitrate if needed
    let attempt = 0, outBlob = null;
    while (attempt < 3) {
      els.pText.textContent = `Encoding (attempt ${attempt + 1})…`;
      outBlob = await encodeOnce(vBitrateK, audioK, speed, scale);
      if (outBlob.size <= targetBytes) break;
      // reduce bitrate and possibly scale down further
      vBitrateK = Math.max(minVideoK, Math.floor(vBitrateK * 0.85));
      scale = chooseScale(vBitrateK);
      attempt++;
    }

    if (!outBlob) throw new Error('Encoding failed');

    // If too big, split into multiple parts targeting <= target size
    if (outBlob.size > targetBytes && duration > 0) {
      const parts = Math.max(2, Math.ceil(outBlob.size / targetBytes));
      const seg = Math.max(2, Math.floor(duration / parts));
      const blobs = [];
      els.parts.innerHTML = ''; els.parts.classList.remove('hidden');
      for (let i = 0; i < parts; i++) {
        const start = i * seg;
        const durSeg = i === parts - 1 ? Math.max(1, Math.ceil(duration - start)) : seg;
        els.pText.textContent = `Encoding part ${i + 1}/${parts}…`;
        const b = await encodeOnce(vBitrateK, audioK, speed, scale, Math.floor(start), Math.floor(durSeg), `out_${i + 1}.webm`);
        blobs.push(b);
        const url = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = url; a.download = `part${i + 1}.webm`; a.textContent = `Part ${i + 1}`;
        const size = document.createElement('span'); size.textContent = `${(b.size/1024/1024).toFixed(2)} MB`;
        a.appendChild(size); els.parts.appendChild(a);
        if (i === 0) { els.outVideo.src = url; els.dl.href = url; els.dl.download = a.download; }
      }
      els.outInfo.textContent = `Split into ${blobs.length} parts • VP9/Opus • ${scale.w}×${scale.h}`;
      els.result.classList.remove('hidden'); els.pText.textContent = 'Done'; els.pPct.textContent = '100%'; els.pBar.style.width = '100%';
      return;
    }

    // Show single-file result
    els.parts.classList.add('hidden'); els.parts.innerHTML = '';
    const url = URL.createObjectURL(outBlob);
    els.outVideo.src = url;
    els.dl.href = url;
    els.dl.download = `output_${Math.round(outBlob.size/1024)}KB.webm`;
    els.outInfo.textContent = `${(outBlob.size/1024/1024).toFixed(2)} MB • VP9/Opus • ${scale.w}×${scale.h}`;
    els.result.classList.remove('hidden');
    els.pText.textContent = 'Done';
    els.pPct.textContent = '100%';
    els.pBar.style.width = '100%';
  } catch (err) {
    console.error(err);
    els.pText.textContent = 'Error. Try “Faster encode” or smaller size.';
  }
});