'use strict';
// Continuous recorder: copies the camera stream (no re-encode) into 5-minute MP4 clips,
// one folder per day:  <dir>/02_10_2026/02_10_2026_14_05_00.mp4  (DD_MM_YYYY_HH_MM_SS, 24-hour, local
// time; set TZ in the container). Names don't sort by date as text, so listings sort by parsed date.
//
// - Reads go2rtc's RTSP restream, so the camera serves one client for live view + recording.
// - Clips are fragmented MP4: a crash or power cut loses seconds, not the whole clip, and
//   the clip being written can already be played.
// - Watchdog restarts ffmpeg if it exits or the current clip stops growing (retries every ≤15 s).
// - NAS safety: the primary dir (the NAS) must contain a marker file (RECORD_NAS_MARKER). If it's
//   missing or not writable — NAS down, or an empty local folder where the share should be —
//   recording switches to the local buffer dir, and buffered clips are moved to the NAS once it's back.
// - Retention: clips older than RECORD_RETENTION_DAYS are deleted; if free space drops under
//   RECORD_MIN_FREE_GB, or the recordings total more than RECORD_MAX_GB, the oldest clips go first.
// - onEvent(type, detail) reports: nas_down, nas_up, recording_down, recording_up.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DAY_RE = /^(\d{2})_(\d{2})_(\d{4})$/;                                  // DD_MM_YYYY
const FILE_RE = /^(\d{2})_(\d{2})_(\d{4})_(\d{2})_(\d{2})_(\d{2})\.mp4$/;  // DD_MM_YYYY_HH_MM_SS.mp4
const OLD_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;                              // first build: YYYY-MM-DD/HH-MM-SS.mp4
const OLD_FILE_RE = /^(\d{2})-(\d{2})-(\d{2})\.mp4$/;
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${pad(d.getDate())}_${pad(d.getMonth() + 1)}_${d.getFullYear()}`;
const dayDate = (day) => { const m = day.match(DAY_RE); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };

/** Local Date for a clip, from its folder + file name. */
function clipStart(day, name) {
  const m = name.match(FILE_RE);
  if (!m || !DAY_RE.test(day)) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
}

function createRecorder(opts) {
  const {
    dir,                         // primary: the NAS
    bufferDir = null,            // fallback on local disk while the NAS is unavailable
    marker = '.nas-ok',             // must exist in dir for it to count as the real NAS (null = don't check)
    source,
    segmentSeconds = 300,
    retentionDays = 7,
    minFreeGb = 20,
    maxGb = 80,
    downAlertMs = 5 * 60e3,      // recording_down after this long without new video
    onEvent = () => {},
    log = console,
  } = opts;

  let ff = null;
  let ffDir = null;              // where the running ffmpeg writes
  let stopping = false;
  let switching = false;        // ffmpeg stopped on purpose to change folders
  let startedAt = null;
  let restarts = 0;
  let lastErr = null;
  let lastGrowth = Date.now();
  let current = null;            // { day, name, size, base }
  let lastCleanup = null;
  let nasOk = null;              // null = not checked yet
  let downSince = null;          // set once recording_down has been reported
  let lastMove = null;
  let nasErr = null;
  const timers = [];

  // while the NAS is down, leave it out of listings: calls on a dead network mount can stall
  const dirs = () => [nasOk === false && bufferDir ? null : dir, bufferDir].filter(Boolean);

  /** The NAS counts as up when the marker is there and we can write next to it (async + timeout,
   *  so a hung share can't freeze the server). */
  async function checkNas() {
    const fsp = fs.promises;
    const probe = path.join(dir, `.probe-${process.pid}`);
    const work = (async () => {
      if (marker) await fsp.access(path.join(dir, marker));
      await fsp.writeFile(probe, String(Date.now()));
      await fsp.unlink(probe);
      nasErr = null;
      return true;
    })().catch((e) => { nasErr = e.message; return false; });
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => { nasErr = 'NAS check timed out (10s)'; r(false); }, 10e3); });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  // one check at a time (concurrent checks would trip over each other's probe file)
  let nasCheck = null;
  function updateNas() {
    if (!nasCheck) nasCheck = doUpdateNas().finally(() => { nasCheck = null; });
    return nasCheck;
  }
  async function doUpdateNas() {
    const ok = await checkNas();
    if (nasOk !== null && ok !== nasOk) {
      log.warn(`recorder: NAS ${ok ? 'is back' : 'unavailable'}${ok ? '' : bufferDir ? ' — recording to local buffer' : ''}`);
      onEvent(ok ? 'nas_up' : 'nas_down', { bufferDir });
    } else if (nasOk === null && !ok) {
      log.warn(`recorder: NAS unavailable at start${bufferDir ? ' — recording to local buffer' : ''}`);
      onEvent('nas_down', { bufferDir });
    }
    nasOk = ok;
    return ok;
  }

  const targetDir = () => (nasOk || !bufferDir ? dir : bufferDir);

  const ensureDirs = (base) => {
    const now = new Date();
    // ffmpeg's segment muxer can't create folders: make today's and tomorrow's ahead of midnight
    for (const d of [now, new Date(now.getTime() + 864e5)]) fs.mkdirSync(path.join(base, dayStr(d)), { recursive: true });
  };

  async function spawnFfmpeg() {
    if (stopping || ff) return;
    await updateNas();
    if (stopping || ff) return;
    const base = targetDir();
    try { ensureDirs(base); } catch (e) { lastErr = `can't write to ${base}: ${e.message}`; log.error('recorder:', lastErr); return void setTimeout(spawnFfmpeg, 15e3); }
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      ...(source.startsWith('rtsp') ? ['-rtsp_transport', 'tcp', '-timeout', '15000000'] : []), '-i', source,
      '-map', '0:v', '-c', 'copy',
      '-f', 'segment', '-segment_time', String(segmentSeconds), '-segment_atclocktime', '1',
      '-reset_timestamps', '1', '-strftime', '1',
      '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
      path.join(base, '%d_%m_%Y', '%d_%m_%Y_%H_%M_%S.mp4'),
    ];
    ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    ffDir = base;
    startedAt = Date.now();
    let errTail = '';
    ff.stderr.on('data', (c) => { errTail = (errTail + c).slice(-4000); });
    ff.on('error', (e) => { lastErr = e.message; });
    ff.on('exit', (code, sig) => {
      ff = null;
      ffDir = null;
      if (stopping) return;
      if (switching) { switching = false; return void setTimeout(spawnFfmpeg, 500); }
      const lines = errTail.trim().split('\n').filter(Boolean);
      lastErr = lines.pop() || `ffmpeg stopped (${code ?? sig})`;
      restarts += 1;
      const wait = Math.min(15, 3 * restarts);
      log.warn(`recorder: ${lastErr} — restarting in ${wait}s`);
      setTimeout(spawnFfmpeg, wait * 1000);
    });
  }

  function listDaysIn(base) {
    try { return fs.readdirSync(base).filter((d) => DAY_RE.test(d)); } catch (e) { return []; }
  }
  function listNamesIn(base, day) {
    try { return fs.readdirSync(path.join(base, day)).filter((n) => FILE_RE.test(n)); } catch (e) { return []; }
  }
  /** All day folders across NAS + buffer, oldest first. */
  function listDays() {
    const set = new Set();
    for (const b of dirs()) listDaysIn(b).forEach((d) => set.add(d));
    return [...set].sort((a, b) => dayDate(a) - dayDate(b));
  }
  /** Clip names of a day across NAS + buffer, oldest first. */
  function listNames(day) {
    const set = new Set();
    for (const b of dirs()) listNamesIn(b, day).forEach((n) => set.add(n));
    return [...set].sort((a, b) => clipStart(day, a) - clipStart(day, b));
  }
  /** Full path of a clip: on the NAS if it's there, else in the buffer. */
  function locate(day, name) {
    for (const b of dirs()) {
      const p = path.join(b, day, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  function newestClip() {
    const base = ffDir || targetDir();
    const days = listDaysIn(base).sort((a, b) => dayDate(a) - dayDate(b)).slice(-2).reverse();
    for (const day of days) {
      const names = listNamesIn(base, day).sort((a, b) => clipStart(day, a) - clipStart(day, b));
      if (names.length) {
        const name = names[names.length - 1];
        const size = fs.statSync(path.join(base, day, name)).size;
        return { day, name, size, base };
      }
    }
    return null;
  }

  /** Move finished clips from the local buffer to the NAS (copy, verify size, delete). */
  function moveBuffered() {
    if (!bufferDir || !nasOk) return;
    let moved = 0;
    for (const day of listDaysIn(bufferDir)) {
      for (const name of listNamesIn(bufferDir, day)) {
        if (current && current.base === bufferDir && current.day === day && current.name === name && ff) continue;  // still being written
        const src = path.join(bufferDir, day, name);
        const dst = path.join(dir, day, name);
        try {
          fs.mkdirSync(path.join(dir, day), { recursive: true });
          fs.copyFileSync(src, dst);
          if (fs.statSync(dst).size === fs.statSync(src).size) { fs.unlinkSync(src); moved++; }
        } catch (e) { log.error(`recorder: couldn't move ${name} to the NAS: ${e.message}`); return; }
      }
      try { if (listNamesIn(bufferDir, day).length === 0 && fs.readdirSync(path.join(bufferDir, day)).length === 0) fs.rmdirSync(path.join(bufferDir, day)); } catch (e) { /* */ }
    }
    if (moved) { lastMove = { at: new Date().toISOString(), moved }; log.log(`recorder: moved ${moved} buffered clip(s) to the NAS`); }
  }

  async function watchdog() {
    const wasOk = nasOk;
    await updateNas();
    try { ensureDirs(targetDir()); } catch (e) { /* reported by spawn */ }
    // the NAS went away or came back: restart ffmpeg so it writes to the right place
    if (ff && ffDir !== targetDir()) {
      log.warn(`recorder: switching recording to ${targetDir()}`);
      switching = true;
      try { ff.kill('SIGINT'); } catch (e) { switching = false; }
    }
    if (wasOk === false && nasOk) setTimeout(() => { try { moveBuffered(); } catch (e) { /* */ } }, 5e3);
    let c = null;
    try { c = newestClip(); } catch (e) { /* share hiccup */ }
    if (c && (!current || c.name !== current.name || c.day !== current.day || c.base !== current.base || c.size > current.size)) {
      lastGrowth = Date.now();
      current = c;
      if (Date.now() - startedAt > 60e3) lastErr = null;   // video is flowing again
    }
    const stalled = Date.now() - lastGrowth;
    if (Date.now() - startedAt > 5 * 60e3 && stalled < 60e3) restarts = 0;   // healthy again
    if (ff && stalled > 90e3 && Date.now() - startedAt > 90e3) {
      lastErr = 'no new video for 90s — restarting the recorder';
      log.warn(`recorder: ${lastErr}`);
      try { ff.kill('SIGKILL'); } catch (e) { /* */ }
    }
    // alerts: report a sustained outage once, and the recovery once
    if (stalled > downAlertMs && !downSince) {
      downSince = new Date(lastGrowth);
      onEvent('recording_down', { since: downSince.toISOString(), lastErr });
    } else if (stalled < 60e3 && downSince) {
      onEvent('recording_up', { since: downSince.toISOString(), minutes: Math.round((Date.now() - downSince) / 60e3) });
      downSince = null;
    }
  }

  function freeBytes(base = dir) {
    if (base === dir && nasOk === false && bufferDir) return null;
    try { const s = fs.statfsSync(base); return s.bavail * s.bsize; } catch (e) { return null; }
  }

  function cleanup() {
    const cutoff = Date.now() - retentionDays * 864e5;
    let removed = 0;
    const all = [];
    for (const day of listDays()) {
      for (const name of listNames(day)) {
        const t = clipStart(day, name);
        const p = t && locate(day, name);
        if (!p) continue;
        let size = 0;
        try { size = fs.statSync(p).size; } catch (e) { /* */ }
        all.push({ day, name, t: t.getTime(), size, p });
      }
    }
    const isCurrent = (c) => current && c.day === current.day && c.name === current.name;
    for (const c of all) {
      if (c.t < cutoff && !isCurrent(c)) { try { fs.unlinkSync(c.p); removed++; } catch (e) { /* */ } }
    }
    // size cap: keep the recordings at or under maxGb, oldest first
    const kept = all.filter((x) => x.t >= cutoff);
    let total = kept.reduce((n, c) => n + c.size, 0);
    const maxBytes = maxGb * 1e9;
    for (const c of kept) {
      if (total <= maxBytes) break;
      if (isCurrent(c)) continue;
      try { fs.unlinkSync(c.p); total -= c.size; c.gone = true; removed++; } catch (e) { /* */ }
    }
    // disk guard (per location): oldest first until there's room again
    const minFree = minFreeGb * 1e9;
    for (const base of dirs()) {
      let free = freeBytes(base);
      for (const c of kept.filter((x) => !x.gone && x.p.startsWith(base + path.sep))) {
        if (free == null || free >= minFree) break;
        if (isCurrent(c)) continue;
        try { fs.unlinkSync(c.p); free += c.size; c.gone = true; total -= c.size; removed++; } catch (e) { /* */ }
      }
    }
    // drop empty day folders, but never today's or tomorrow's
    const keep = new Set([dayStr(new Date()), dayStr(new Date(Date.now() + 864e5))]);
    for (const base of dirs()) {
      for (const day of listDaysIn(base)) {
        if (!keep.has(day) && listNamesIn(base, day).length === 0) { try { fs.rmdirSync(path.join(base, day)); } catch (e) { /* not empty */ } }
      }
    }
    lastCleanup = { at: new Date().toISOString(), removed, totalBytes: total };
    if (removed) log.log(`recorder: cleanup removed ${removed} clip(s)`);
  }

  /** Rename clips from the first build (YYYY-MM-DD/HH-MM-SS.mp4) to DD_MM_YYYY/DD_MM_YYYY_HH_MM_SS.mp4. */
  function migrateOldNames() {
    let moved = 0;
    for (const old of fs.readdirSync(dir).filter((d) => OLD_DAY_RE.test(d))) {
      const [, y, mo, d] = old.match(OLD_DAY_RE);
      const day = `${d}_${mo}_${y}`;
      fs.mkdirSync(path.join(dir, day), { recursive: true });
      for (const n of fs.readdirSync(path.join(dir, old))) {
        const m = n.match(OLD_FILE_RE);
        if (!m) continue;
        try { fs.renameSync(path.join(dir, old, n), path.join(dir, day, `${day}_${m[1]}_${m[2]}_${m[3]}.mp4`)); moved++; } catch (e) { /* */ }
      }
      try { fs.rmdirSync(path.join(dir, old)); } catch (e) { /* not empty */ }
    }
    if (moved) log.log(`recorder: renamed ${moved} clip(s) to DD_MM_YYYY_HH_MM_SS`);
  }

  return {
    start() {
      if (bufferDir) fs.mkdirSync(bufferDir, { recursive: true });
      updateNas().then((ok) => {
        if (!ok) return;
        try { migrateOldNames(); } catch (e) { log.error('recorder: rename failed:', e.message); }
        setTimeout(() => { try { moveBuffered(); } catch (e) { /* */ } }, 20e3);
      });
      setTimeout(spawnFfmpeg, 3000);   // give go2rtc a moment to open its RTSP port
      timers.push(setInterval(() => { watchdog().catch((e) => log.error('recorder watchdog:', e.message)); }, 30e3));
      timers.push(setInterval(() => { try { cleanup(); moveBuffered(); } catch (e) { log.error('recorder cleanup:', e.message); } }, 10 * 60e3));
      setTimeout(() => { try { cleanup(); } catch (e) { /* */ } }, 60e3);
    },
    /** Run retention now (also runs every 10 minutes). */
    cleanup() { cleanup(); return lastCleanup; },
    stop() {
      stopping = true;
      timers.forEach(clearInterval);
      if (ff) ff.kill('SIGINT');   // lets ffmpeg finish the current fragment
    },
    status() {
      const stalled = Date.now() - lastGrowth;
      return {
        recording: Boolean(ff) && stalled < 90e3,
        videoAgeSeconds: Math.round(stalled / 1000),
        since: startedAt ? new Date(startedAt).toISOString() : null,
        current: current ? `${current.day}/${current.name}` : null,
        writingTo: nasOk || !bufferDir ? 'nas' : 'local-buffer',
        nasOk,
        nasErr,
        lastErr,
        restarts,
        retentionDays,
        maxGb,
        segmentSeconds,
        freeBytes: freeBytes(),
        bufferedClips: bufferDir ? listDaysIn(bufferDir).reduce((n, d) => n + listNamesIn(bufferDir, d).length, 0) : 0,
        lastMove,
        lastCleanup,
      };
    },
    /** Days with clips, newest first: [{ day, clips, bytes, seconds, first, last }] */
    days() {
      return listDays().reverse().map((day) => {
        const list = this.clips(day) || [];
        const bytes = list.reduce((n, c) => n + c.bytes, 0);
        const seconds = Math.round(list.reduce((n, c) => n + (new Date(c.end) - new Date(c.start)) / 1000, 0));
        return { day, clips: list.length, bytes, seconds, first: list[0]?.name || null, last: list[list.length - 1]?.name || null };
      }).filter((d) => d.clips > 0);
    },
    /** Clips of one day: [{ name, start, end, bytes, live, local }] (start/end as ISO) */
    clips(day) {
      if (!DAY_RE.test(day)) return null;
      const names = listNames(day);
      return names.map((name, i) => {
        const p = locate(day, name);
        let st = null;
        try { st = fs.statSync(p); } catch (e) { return null; }
        const start = clipStart(day, name);
        const next = names[i + 1] ? clipStart(day, names[i + 1]) : null;
        const live = Boolean(current && current.day === day && current.name === name && ff);
        // a network share may not update mtime while a file is written, so the clip's end is the next
        // clip's start when they're back to back, "now" for the live clip, else a best guess
        const full = start.getTime() + segmentSeconds * 1000;
        let endMs;
        if (next && next.getTime() - start.getTime() <= segmentSeconds * 1000 + 60e3) endMs = next.getTime();
        else if (live) endMs = Date.now();
        else endMs = st.mtimeMs > start.getTime() + 10e3 ? Math.min(st.mtimeMs, full + 30e3) : full;
        return { name, start: start.toISOString(), end: new Date(endMs).toISOString(), bytes: st.size, live, local: Boolean(bufferDir) && p.startsWith(bufferDir + path.sep) };
      }).filter(Boolean);
    },
    /** Clips overlapping [from, to] (Dates), oldest first, with full paths. */
    clipsBetween(from, to) {
      const out = [];
      for (const day of listDays()) {
        for (const c of this.clips(day) || []) {
          if (new Date(c.end) > from && new Date(c.start) < to) out.push({ ...c, day, path: locate(day, c.name) });
        }
      }
      return out;
    },
    locate,
    dir,
    bufferDir,
  };
}

module.exports = { createRecorder, dayStr, dayDate };
