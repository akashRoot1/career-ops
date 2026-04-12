#!/usr/bin/env node
/**
 * daily-digest.mjs — Morning email digest for career-ops
 *
 * Reads applications.md, pipeline.md, and follow-ups.md then sends
 * a formatted HTML summary to the configured recipient via Gmail SMTP.
 *
 * Required environment variables:
 *   GMAIL_USER          — sender Gmail address (e.g. yourname@gmail.com)
 *   GMAIL_APP_PASSWORD  — Gmail App Password (not your login password)
 *   DIGEST_TO           — recipient email address
 *
 * Run locally:
 *   GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx DIGEST_TO=you@gmail.com node daily-digest.mjs
 *
 * Dry-run (print HTML only, no email sent):
 *   node daily-digest.mjs --dry-run
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTransport } from 'nodemailer';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPS_FILE  = join(ROOT, 'data', 'applications.md');
const PIPE_FILE  = join(ROOT, 'data', 'pipeline.md');
const FU_FILE    = join(ROOT, 'data', 'follow-ups.md');

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysBetween(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return null;
  const d = new Date(dateStr.trim());
  const now = new Date(today());
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const STATUS_ALIASES = {
  evaluada: 'Evaluated', condicional: 'Evaluated', hold: 'Evaluated',
  evaluar: 'Evaluated', verificar: 'Evaluated', evaluated: 'Evaluated',
  aplicado: 'Applied', enviada: 'Applied', aplicada: 'Applied',
  applied: 'Applied', sent: 'Applied',
  respondido: 'Responded', responded: 'Responded',
  entrevista: 'Interview', interview: 'Interview',
  oferta: 'Offer', offer: 'Offer',
  rechazado: 'Rejected', rechazada: 'Rejected', rejected: 'Rejected',
  descartado: 'Discarded', descartada: 'Discarded', discarded: 'Discarded',
  cerrada: 'Discarded', cancelada: 'Discarded',
  'no aplicar': 'Skip', no_aplicar: 'Skip', monitor: 'Skip', skip: 'Skip',
};

function normalizeStatus(raw) {
  const clean = (raw || '')
    .replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return STATUS_ALIASES[clean] || raw.trim();
}

function parseTracker() {
  if (!existsSync(APPS_FILE)) return [];
  const rows = [];
  for (const line of readFileSync(APPS_FILE, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const p = line.split('|').map(s => s.trim());
    if (p.length < 9) continue;
    const num = parseInt(p[1]);
    if (isNaN(num)) continue;
    rows.push({
      num,
      date:    p[2],
      company: p[3],
      role:    p[4],
      score:   p[5],
      status:  normalizeStatus(p[6]),
      pdf:     p[7],
      report:  p[8],
      notes:   p[9] || '',
    });
  }
  return rows;
}

function parsePipeline() {
  if (!existsSync(PIPE_FILE)) return 0;
  const content = readFileSync(PIPE_FILE, 'utf-8');
  // Count non-empty, non-header lines that look like URLs or local: refs
  return content.split('\n').filter(l => /https?:\/\/|local:/.test(l)).length;
}

function parseFollowUps() {
  if (!existsSync(FU_FILE)) return [];
  const rows = [];
  for (const line of readFileSync(FU_FILE, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const p = line.split('|').map(s => s.trim());
    if (p.length < 7) continue;
    const num = parseInt(p[1]);
    if (isNaN(num)) continue;
    rows.push({
      num,
      company:    p[2],
      role:       p[3],
      lastContact: p[4],
      nextAction:  p[5],
      dueDate:     p[6],
      notes:       p[7] || '',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function buildDigest() {
  const apps = parseTracker();
  const pendingInPipeline = parsePipeline();
  const followUps = parseFollowUps();

  // Status breakdown
  const byStatus = {};
  for (const a of apps) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  }

  // Active (Applied + Responded + Interview + Offer)
  const ACTIVE_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer']);
  const active = apps.filter(a => ACTIVE_STATUSES.has(a.status));

  // Overdue follow-ups: applied/responded apps older than 7 days with no recent follow-up
  const needsFollowUp = active
    .filter(a => ['Applied', 'Responded'].includes(a.status))
    .map(a => ({ ...a, daysAgo: daysBetween(a.date) }))
    .filter(a => a.daysAgo !== null && a.daysAgo >= 7)
    .sort((a, b) => b.daysAgo - a.daysAgo)
    .slice(0, 10);

  // Follow-ups due today or overdue
  const dueTodayOrOverdue = followUps
    .filter(fu => {
      if (!fu.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(fu.dueDate)) return false;
      return fu.dueDate <= today();
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // Recent wins (Interview, Offer, Responded in last 14 days)
  const recentWins = apps
    .filter(a => ['Interview', 'Offer', 'Responded'].includes(a.status))
    .map(a => ({ ...a, daysAgo: daysBetween(a.date) }))
    .filter(a => a.daysAgo !== null && a.daysAgo <= 14)
    .sort((a, b) => a.daysAgo - b.daysAgo);

  // Top evaluated (not yet applied, score >= 4.0)
  const topEvaluated = apps
    .filter(a => a.status === 'Evaluated')
    .map(a => {
      const scoreNum = parseFloat(a.score);
      return { ...a, scoreNum };
    })
    .filter(a => !isNaN(a.scoreNum) && a.scoreNum >= 4.0)
    .sort((a, b) => b.scoreNum - a.scoreNum)
    .slice(0, 5);

  return {
    date: today(),
    totalApps: apps.length,
    byStatus,
    pendingInPipeline,
    active,
    needsFollowUp,
    dueTodayOrOverdue,
    recentWins,
    topEvaluated,
  };
}

// ---------------------------------------------------------------------------
// Email HTML builder
// ---------------------------------------------------------------------------

const STATUS_COLORS = {
  Offer:     '#22c55e',
  Interview: '#3b82f6',
  Responded: '#8b5cf6',
  Applied:   '#f59e0b',
  Evaluated: '#6b7280',
  Rejected:  '#ef4444',
  Discarded: '#9ca3af',
  Skip:      '#d1d5db',
};

function badge(status) {
  const color = STATUS_COLORS[status] || '#6b7280';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;color:#fff;background:${color}">${status}</span>`;
}

function statusRow(label, count, color) {
  if (!count) return '';
  return `
    <tr>
      <td style="padding:4px 8px 4px 0;color:#374151;font-size:13px">${label}</td>
      <td style="padding:4px 0;text-align:right">
        <strong style="font-size:14px;color:${color}">${count}</strong>
      </td>
    </tr>`;
}

function sectionHeader(title, emoji) {
  return `
  <tr><td colspan="2" style="padding:20px 0 8px 0">
    <h2 style="margin:0;font-size:16px;color:#111827;border-bottom:2px solid #e5e7eb;padding-bottom:6px">
      ${emoji} ${title}
    </h2>
  </td></tr>`;
}

function buildHtml(d) {
  const totalActive = d.active.length;
  const offers    = d.byStatus['Offer']     || 0;
  const interviews= d.byStatus['Interview'] || 0;
  const responded = d.byStatus['Responded'] || 0;
  const applied   = d.byStatus['Applied']   || 0;
  const evaluated = d.byStatus['Evaluated'] || 0;
  const rejected  = d.byStatus['Rejected']  || 0;
  const discarded = d.byStatus['Discarded'] || 0;

  // Build follow-up rows
  let followupRows = '';
  if (d.needsFollowUp.length > 0) {
    followupRows = d.needsFollowUp.map(a => `
      <tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:6px 8px 6px 0;font-size:13px;color:#111827">${a.company}</td>
        <td style="padding:6px 8px;font-size:12px;color:#6b7280;max-width:200px;overflow:hidden;text-overflow:ellipsis">${a.role}</td>
        <td style="padding:6px 0 6px 8px">${badge(a.status)}</td>
        <td style="padding:6px 0;text-align:right;font-size:12px;color:#ef4444;white-space:nowrap">${a.daysAgo}d ago</td>
      </tr>`).join('');
  } else {
    followupRows = `<tr><td colspan="4" style="padding:8px 0;color:#6b7280;font-size:13px;font-style:italic">No overdue follow-ups 🎉</td></tr>`;
  }

  // Build due-today rows
  let dueRows = '';
  if (d.dueTodayOrOverdue.length > 0) {
    dueRows = d.dueTodayOrOverdue.map(fu => `
      <tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:6px 8px 6px 0;font-size:13px;color:#111827">${fu.company}</td>
        <td style="padding:6px 8px;font-size:12px;color:#6b7280">${fu.role}</td>
        <td style="padding:6px 0 6px 8px;font-size:12px;color:#374151">${fu.nextAction}</td>
        <td style="padding:6px 0;text-align:right;font-size:12px;color:${fu.dueDate < today() ? '#ef4444' : '#f59e0b'};white-space:nowrap">${fu.dueDate}</td>
      </tr>`).join('');
  } else {
    dueRows = `<tr><td colspan="4" style="padding:8px 0;color:#6b7280;font-size:13px;font-style:italic">No follow-ups due today.</td></tr>`;
  }

  // Build wins rows
  let winsRows = '';
  if (d.recentWins.length > 0) {
    winsRows = d.recentWins.map(a => `
      <tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:6px 8px 6px 0;font-size:13px;color:#111827">${a.company}</td>
        <td style="padding:6px 8px;font-size:12px;color:#6b7280;max-width:200px;overflow:hidden;text-overflow:ellipsis">${a.role}</td>
        <td style="padding:6px 0 6px 8px">${badge(a.status)}</td>
        <td style="padding:6px 0;text-align:right;font-size:12px;color:#6b7280;white-space:nowrap">${a.daysAgo}d ago</td>
      </tr>`).join('');
  } else {
    winsRows = `<tr><td colspan="4" style="padding:8px 0;color:#6b7280;font-size:13px;font-style:italic">No recent activity in the last 14 days.</td></tr>`;
  }

  // Build top evaluated rows
  let topRows = '';
  if (d.topEvaluated.length > 0) {
    topRows = d.topEvaluated.map(a => `
      <tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:6px 8px 6px 0;font-size:13px;color:#111827">${a.company}</td>
        <td style="padding:6px 8px;font-size:12px;color:#6b7280;max-width:200px;overflow:hidden;text-overflow:ellipsis">${a.role}</td>
        <td style="padding:6px 0;text-align:right;font-size:14px;font-weight:700;color:#22c55e">${a.score}</td>
      </tr>`).join('');
  } else {
    topRows = `<tr><td colspan="3" style="padding:8px 0;color:#6b7280;font-size:13px;font-style:italic">No high-score evaluated roles pending.</td></tr>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>career-ops daily digest — ${d.date}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);max-width:600px;width:100%">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1e293b,#334155);padding:28px 32px">
            <p style="margin:0 0 4px 0;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em">career-ops</p>
            <h1 style="margin:0;font-size:22px;color:#f8fafc;font-weight:700">Morning Digest</h1>
            <p style="margin:8px 0 0 0;font-size:14px;color:#94a3b8">${new Date(d.date).toLocaleDateString('en-IE', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone:'Europe/Dublin' })}</p>
          </td>
        </tr>

        <!-- Stats bar -->
        <tr>
          <td style="padding:20px 32px 0 32px">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${[
                  ['Total', d.totalApps, '#1e293b'],
                  ['Active', totalActive, '#3b82f6'],
                  ['Inbox', d.pendingInPipeline, '#f59e0b'],
                  ['Overdue', d.needsFollowUp.length, d.needsFollowUp.length > 0 ? '#ef4444' : '#6b7280'],
                ].map(([label, val, color]) => `
                  <td style="text-align:center;padding:0 8px">
                    <div style="background:#f8fafc;border-radius:8px;padding:12px 8px">
                      <div style="font-size:24px;font-weight:700;color:${color}">${val}</div>
                      <div style="font-size:11px;color:#6b7280;margin-top:2px;text-transform:uppercase;letter-spacing:.05em">${label}</div>
                    </div>
                  </td>`).join('')}
              </tr>
            </table>
          </td>
        </tr>

        <!-- Main content -->
        <tr>
          <td style="padding:8px 32px 32px 32px">
            <table width="100%" cellpadding="0" cellspacing="0">

              <!-- Pipeline summary -->
              ${sectionHeader('Pipeline Summary', '📊')}
              <tr><td colspan="2">
                <table width="100%" cellpadding="0" cellspacing="0">
                  ${statusRow('🟢 Offers',     offers,     '#22c55e')}
                  ${statusRow('🔵 Interviews', interviews, '#3b82f6')}
                  ${statusRow('🟣 Responded',  responded,  '#8b5cf6')}
                  ${statusRow('🟡 Applied',    applied,    '#f59e0b')}
                  ${statusRow('⚪ Evaluated',  evaluated,  '#6b7280')}
                  ${statusRow('🔴 Rejected',   rejected,   '#ef4444')}
                  ${statusRow('⬛ Discarded',  discarded,  '#9ca3af')}
                </table>
              </td></tr>

              <!-- Overdue follow-ups -->
              ${sectionHeader('Overdue Follow-ups (≥7 days silent)', '🔔')}
              <tr><td colspan="2">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr style="border-bottom:2px solid #e5e7eb">
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px 4px 0;text-transform:uppercase">Company</th>
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px;text-transform:uppercase">Role</th>
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px;text-transform:uppercase">Status</th>
                    <th style="text-align:right;font-size:11px;color:#6b7280;padding:4px 0;text-transform:uppercase">Age</th>
                  </tr>
                  ${followupRows}
                </table>
              </td></tr>

              <!-- Follow-ups due today -->
              ${sectionHeader('Follow-ups Due Today', '📅')}
              <tr><td colspan="2">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr style="border-bottom:2px solid #e5e7eb">
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px 4px 0;text-transform:uppercase">Company</th>
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px;text-transform:uppercase">Role</th>
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px;text-transform:uppercase">Action</th>
                    <th style="text-align:right;font-size:11px;color:#6b7280;padding:4px 0;text-transform:uppercase">Due</th>
                  </tr>
                  ${dueRows}
                </table>
              </td></tr>

              <!-- Recent wins -->
              ${sectionHeader('Recent Activity (last 14 days)', '🚀')}
              <tr><td colspan="2">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr style="border-bottom:2px solid #e5e7eb">
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px 4px 0;text-transform:uppercase">Company</th>
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px;text-transform:uppercase">Role</th>
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px;text-transform:uppercase">Status</th>
                    <th style="text-align:right;font-size:11px;color:#6b7280;padding:4px 0;text-transform:uppercase">When</th>
                  </tr>
                  ${winsRows}
                </table>
              </td></tr>

              <!-- Top evaluated -->
              ${sectionHeader('Top Evaluated (score ≥4.0, not yet applied)', '⭐')}
              <tr><td colspan="2">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr style="border-bottom:2px solid #e5e7eb">
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px 4px 0;text-transform:uppercase">Company</th>
                    <th style="text-align:left;font-size:11px;color:#6b7280;padding:4px 8px;text-transform:uppercase">Role</th>
                    <th style="text-align:right;font-size:11px;color:#6b7280;padding:4px 0;text-transform:uppercase">Score</th>
                  </tr>
                  ${topRows}
                </table>
              </td></tr>

              ${d.pendingInPipeline > 0 ? `
              <!-- Pipeline inbox -->
              ${sectionHeader('Pending in Pipeline Inbox', '📥')}
              <tr><td colspan="2">
                <p style="margin:8px 0;font-size:14px;color:#374151">
                  You have <strong>${d.pendingInPipeline}</strong> unprocessed URL${d.pendingInPipeline !== 1 ? 's' : ''} in <code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:12px">data/pipeline.md</code>.
                  Run <code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:12px">/career-ops pipeline</code> to process them.
                </p>
              </td></tr>` : ''}

            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center">
            <p style="margin:0;font-size:11px;color:#9ca3af">
              Sent by <strong>career-ops</strong> · daily digest ·
              <a href="https://github.com/santifer/career-ops" style="color:#6b7280;text-decoration:none">github</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Send email
// ---------------------------------------------------------------------------

async function sendDigest() {
  const d = buildDigest();
  const html = buildHtml(d);

  if (DRY_RUN) {
    console.log('=== DRY RUN — email HTML printed below ===\n');
    console.log(html);
    console.log('\n=== DRY RUN complete. No email was sent. ===');
    return;
  }

  const { GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_TO } = process.env;

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !DIGEST_TO) {
    console.error(
      'Missing required env vars: GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_TO\n' +
      'Run with --dry-run to test without credentials.'
    );
    process.exit(1);
  }

  const transporter = createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });

  const dateLabel = new Date(d.date).toLocaleDateString('en-IE', {
    weekday: 'short', month: 'short', day: 'numeric',
    // 'Europe/Dublin' matches the 5 AM Irish-time schedule; adjust if needed
    timeZone: 'Europe/Dublin',
  });

  const info = await transporter.sendMail({
    from: `"career-ops" <${GMAIL_USER}>`,
    to: DIGEST_TO,
    subject: `career-ops digest · ${dateLabel} · ${d.totalApps} apps, ${d.active.length} active`,
    html,
  });

  console.log(`✅  Digest sent → ${DIGEST_TO}  (messageId: ${info.messageId})`);
}

sendDigest().catch(err => {
  console.error('Error sending digest:', err.message);
  process.exit(1);
});
