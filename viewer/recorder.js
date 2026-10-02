'use strict';
// Continuous recorder: copies the camera stream (no re-encode) into 5-minute MP4 clips,
// one folder per day:  <dir>/2026-10-02/14-05-00.mp4  (local time; set TZ in the container).
//
// - Reads go2rtc's RTSP restream, so the camera serves one client for live view + recording.
// - Clips are fragmented MP4: a crash or power cut loses seconds, not the whole clip, and
//   the clip being written can already be played.
// - Watchdog restarts ffmpeg if it exits or the current clip stops growing.
// - Retention: clips older than RECORD_RETENTION_DAYS are deleted; if free space drops under
//   RECORD_MIN_FREE_GB the oldest clips go first.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{2})-(\d{2})-(\d{2})\.mp4$/;
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local Date for a clip, from its folder + file name. */
function clipStart(day, name) {
  const m = name.match(FILE_RE);
  if (!m || !DAY_RE.test(day)) return null;
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, +m[1], +m[2], +m[3]);
}

function createRecorder(opts) {
  const {
    dir,
    source,
    segmentSeconds = 300,
    retentionDays = 7,
    minFreeGb = 20,
    log = console,
  } = opts;

  let ff = null;
  let stopping = false;
  let startedAt = null;
  let restarts = 0;
  let lastErr = null;
  let lastGrowth = Date.now();
  let current = null;            // { day, name, size }
  let lastCleanup = null;
  const timers = [];

  const ensureDirs = () => {
    const now = new Date();
    // ffmpeg's segment muxer can't create folders: make today's and tomorrow's ahead of midnight
    for (const d of [now, new Date(now.getTime() + 864e5)]) fs.mkdirSync(path.join(dir, dayStr(d)), { recursive: true });
  };

  function spawnFfmpeg() {
    if (stopping) return;
    try { ensureDirs(); } catch (e) { lastErr = `can't write to ${dir}: ${e.message}`; log.error('recorder:', lastErr); return void setTimeout(spawnFfmpeg, 30e3); }
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      ...(source.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []), '-i', source,
      '-map', '0:v', '-c', 'copy',
      '-f', 'segment', '-segment_time', String(segmentSeconds), '-segment_atclocktime', '1',
      '-reset_timestamps', '1', '-strftime', '1',
      '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
      path.join(dir, '%Y-%m-%d', '%H-%M-%S.mp4'),
    ];
    ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    startedAt = Date.now();
    lastGrowth = Date.now();
    let errTail = '';
    ff.stderr.on('data', (c) => { errTail = (errTail + c).slice(-4000); });
    ff.on('error', (e) => { lastErr = e.message; });
    ff.on('exit', (code, sig) => {
      ff = null;
      if (stopping) return;
      const lines = errTail.trim().split('\n').filter(Boolean);
      lastErr = lines.pop() || `ffmpeg stopped (${code ?? sig})`;
      restarts += 1;
      const wait = Math.min(60, 5 * restarts);
      log.warn(`recorder: ${lastErr} — restarting in ${wait}s`);
      setTimeout(spawnFfmpeg, wait * 1000);
    });
  }

  function newestClip() {
    const days = listDays().slice(-2);
    for (const day of days.reverse()) {
      const names = listNames(day);
      if (names.length) {
        const name = names[names.length - 1];
        const size = fs.statSync(path.join(dir, day, name)).size;
        return { day, name, size };
      }
    }
    return null;
  }

  function watchdog() {
    try { ensureDirs(); } catch (e) { /* reported by spawn */ }
    if (!ff) return;
    let c = null;
    try { c = newestClip(); } catch (e) { /* share hiccup */ }
    if (c && (!current || c.name !== current.name || c.day !== current.day || c.size > current.size)) {
      lastGrowth = Date.now();
      current = c;
    }
    if (Date.now() - startedAt > 5 * 60e3 && Date.now() - lastGrowth < 60e3) restarts = 0;   // healthy again
    if (Date.now() - lastGrowth > 90e3) {
      lastErr = 'no new video for 90s — restarting the recorder';
      log.warn(`recorder: ${lastErr}`);
      try { ff.kill('SIGKILL'); } catch (e) { /* */ }
    }
  }

  function listDays() {
    try { return fs.readdirSync(dir).filter((d) => DAY_RE.test(d)).sort(); } catch (e) { return []; }
  }
  function listNames(day) {
    try { return fs.readdirSync(path.join(dir, day)).filter((n) => FILE_RE.test(n)).sort(); } catch (e) { return []; }
  }

  function freeBytes() {
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch (e) { return null; }
  }

  function cleanup() {
    const cutoff = Date.now() - retentionDays * 864e5;
    let removed = 0;
    const all = [];
    for (const day of listDays()) {
      for (const name of listNames(day)) {
        const t = clipStart(day, name);
        if (t) all.push({ day, name, t: t.getTime() });
      }
    }
    const isCurrent = (c) => current && c.day === current.day && c.name === current.name;
    for (const c of all) {
      if (c.t < cutoff && !isCurrent(c)) { try { fs.unlinkSync(path.join(dir, c.day, c.name)); removed++; } catch (e) { /* */ } }
    }
    // disk guard: oldest first until there's room again
    const minFree = minFreeGb * 1e9;
    let free = freeBytes();
    for (const c of all.filter((x) => x.t >= cutoff)) {
      if (free == null || free >= minFree) break;
      if (isCurrent(c)) continue;
      const p = path.join(dir, c.day, c.name);
      try { const sz = fs.statSync(p).size; fs.unlinkSync(p); free += sz; removed++; } catch (e) { /* */ }
    }
    // drop empty day folders, but never today's or tomorrow's
    const keep = new Set([dayStr(new Date()), dayStr(new Date(Date.now() + 864e5))]);
    for (const day of listDays()) {
      if (!keep.has(day) && listNames(day).length === 0) { try { fs.rmdirSync(path.join(dir, day)); } catch (e) { /* not empty */ } }
    }
    lastCleanup = { at: new Date().toISOString(), removed };
    if (removed) log.log(`recorder: cleanup removed ${removed} clip(s)`);
  }

  return {
    start() {
      fs.mkdirSync(dir, { recursive: true });
      spawnFfmpeg();
      timers.push(setInterval(watchdog, 30e3));
      timers.push(setInterval(() => { try { cleanup(); } catch (e) { log.error('recorder cleanup:', e.message); } }, 10 * 60e3));
      setTimeout(() => { try { cleanup(); } catch (e) { /* */ } }, 60e3);
    },
    stop() {
      stopping = true;
      timers.forEach(clearInterval);
      if (ff) ff.kill('SIGINT');   // lets ffmpeg finish the current fragment
    },
    status() {
      return {
        recording: Boolean(ff) && Date.now() - lastGrowth < 90e3,
        since: startedAt ? new Date(startedAt).toISOString() : null,
        current: current ? `${current.day}/${current.name}` : null,
        lastErr,
        restarts,
        retentionDays,
        segmentSeconds,
        freeBytes: freeBytes(),
        lastCleanup,
      };
    },
    /** Days with clips, newest first: [{ day, clips, bytes, first, last }] */
    days() {
      return listDays().reverse().map((day) => {
        const names = listNames(day);
        let bytes = 0;
        for (const n of names) { try { bytes += fs.statSync(path.join(dir, day, n)).size; } catch (e) { /* */ } }
        return { day, clips: names.length, bytes, first: names[0] || null, last: names[names.length - 1] || null };
      }).filter((d) => d.clips > 0);
    },
    /** Clips of one day: [{ name, start, end, bytes, live }] (start/end as ISO) */
    clips(day) {
      if (!DAY_RE.test(day)) return null;
      const names = listNames(day);
      return names.map((name, i) => {
        const p = path.join(dir, day, name);
        let st = null;
        try { st = fs.statSync(p); } catch (e) { return null; }
        const start = clipStart(day, name);
        const next = names[i + 1] ? clipStart(day, names[i + 1]) : null;
        const end = new Date(Math.min(st.mtimeMs, next ? next.getTime() : Infinity, start.getTime() + segmentSeconds * 1000 + 30e3));
        const live = Boolean(current && current.day === day && current.name === name && ff);
        return { name, start: start.toISOString(), end: end.toISOString(), bytes: st.size, live };
      }).filter(Boolean);
    },
    /** Clips overlapping [from, to] (Dates), oldest first, with full paths. */
    clipsBetween(from, to) {
      const out = [];
      for (const day of listDays()) {
        const list = this.clips(day) || [];
        for (const c of list) {
          if (new Date(c.end) > from && new Date(c.start) < to) out.push({ ...c, day, path: path.join(dir, day, c.name) });
        }
      }
      return out;
    },
    dir,
  };
}

module.exports = { createRecorder, dayStr };
