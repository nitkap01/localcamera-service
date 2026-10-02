'use strict';
// Email alerts through Gmail SMTP (curl, no extra npm packages).
// Set ALERT_SMTP_USER + ALERT_SMTP_PASS (a Gmail app password) and ALERT_TO in the host's .env —
// never in git. Without them, alerts are only logged.
// The same kind of alert is sent at most once per ALERT_REPEAT_MINUTES (default 30) and at most
// ALERT_MAX_PER_DAY (default 30) in total, so a flapping camera can't flood the inbox.
const { spawn } = require('child_process');
const os = require('os');

function createAlerter(opts) {
  const {
    user = '',
    pass = '',
    to = '',
    from = user,
    smtpUrl = 'smtps://smtp.gmail.com:465',
    repeatMs = 30 * 60e3,
    maxPerDay = 30,
    prefix = '[Camera]',
    log = console,
  } = opts;
  const enabled = Boolean(user && pass && to);
  const lastSent = new Map();   // key -> ms
  let day = new Date().toDateString();
  let sentToday = 0;
  let suppressed = 0;
  const history = [];            // last 50 alerts, for /api/health

  function sendMail(subject, body) {
    return new Promise((resolve) => {
      const msg = [
        `From: Camera <${from}>`,
        `To: ${to}`,
        `Subject: ${prefix} ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
        '',
        `— ${os.hostname()} · ${new Date().toLocaleString('en-GB', { hour12: false })}`,
      ].join('\r\n');
      const args = ['-sS', '--max-time', '30', '--ssl-reqd', '--url', smtpUrl, '--user', `${user}:${pass}`,
        '--mail-from', from, ...to.split(',').flatMap((r) => ['--mail-rcpt', r.trim()]), '-T', '-'];
      const p = spawn('curl', args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (c) => { err += c; });
      p.on('error', (e) => { log.error('alerts: curl failed:', e.message); resolve(false); });
      p.on('exit', (code) => { if (code) log.error(`alerts: mail not sent (${code}): ${err.trim()}`); resolve(code === 0); });
      p.stdin.end(msg);
    });
  }

  /** Send an alert; `key` groups repeats (defaults to the subject). `force` skips the repeat limit. */
  async function alert(subject, body = '', { key = subject, force = false } = {}) {
    const today = new Date().toDateString();
    if (today !== day) { day = today; sentToday = 0; }
    history.unshift({ at: new Date().toISOString(), subject });
    history.length = Math.min(history.length, 50);
    log.warn(`ALERT: ${subject}${body ? ' — ' + body.split('\n')[0] : ''}`);
    if (!enabled) return false;
    const last = lastSent.get(key) || 0;
    if (!force && Date.now() - last < repeatMs) { suppressed++; return false; }
    if (sentToday >= maxPerDay) { suppressed++; return false; }
    lastSent.set(key, Date.now());
    sentToday++;
    return sendMail(subject, body);
  }

  return {
    alert,
    enabled,
    status: () => ({ enabled, to: enabled ? to : null, sentToday, suppressed, recent: history.slice(0, 10) }),
  };
}

module.exports = { createAlerter };
