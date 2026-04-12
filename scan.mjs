#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --email          # scan and send results via email (requires GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_TO)
 *   node scan.mjs --email-always   # like --email but sends even when no new offers found
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { createTransport } from 'nodemailer';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Scan email builder ──────────────────────────────────────────────

function formatScanDate(date, style) {
  const opts = style === 'short'
    ? { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
  return new Date(date).toLocaleDateString('en-IE', opts);
}

function buildScanHtml(newOffers, date, stats) {
  const dateLabel = formatScanDate(date, 'long');

  // Group offers by company
  const byCompany = {};
  for (const o of newOffers) {
    if (!byCompany[o.company]) byCompany[o.company] = [];
    byCompany[o.company].push(o);
  }

  let offersHtml = '';
  if (newOffers.length === 0) {
    offersHtml = `<tr><td colspan="3" style="padding:12px 0;color:#6b7280;font-size:14px;font-style:italic">No new offers matched your filters in this scan.</td></tr>`;
  } else {
    for (const [company, offers] of Object.entries(byCompany)) {
      offersHtml += `
        <tr>
          <td colspan="3" style="padding:12px 0 4px 0;font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;border-top:1px solid #e5e7eb">${company}</td>
        </tr>`;
      for (const o of offers) {
        const location = o.location ? `<span style="color:#9ca3af"> · ${o.location}</span>` : '';
        offersHtml += `
        <tr style="border-bottom:1px solid #f3f4f6">
          <td style="padding:5px 8px 5px 0;font-size:13px;color:#111827">
            <a href="${o.url}" style="color:#3b82f6;text-decoration:none">${o.title}</a>${location}
          </td>
          <td style="padding:5px 0;text-align:right;white-space:nowrap">
            <span style="font-size:11px;background:#f3f4f6;border-radius:4px;padding:2px 6px;color:#6b7280">${o.source || 'api'}</span>
          </td>
        </tr>`;
      }
    }
  }

  const errorRows = stats.errors.length > 0
    ? `<p style="font-size:12px;color:#ef4444;margin:8px 0 0 0">⚠ ${stats.errors.length} error(s): ${stats.errors.map(e => e.company).join(', ')}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>career-ops scan — ${date}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);max-width:600px;width:100%">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1e293b,#334155);padding:28px 32px">
            <p style="margin:0 0 4px 0;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em">career-ops</p>
            <h1 style="margin:0;font-size:22px;color:#f8fafc;font-weight:700">Portal Scan Results</h1>
            <p style="margin:8px 0 0 0;font-size:14px;color:#94a3b8">${dateLabel}</p>
          </td>
        </tr>

        <!-- Stats bar -->
        <tr>
          <td style="padding:20px 32px 0 32px">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${[
                  ['Scanned', stats.companiesScanned, '#1e293b'],
                  ['Found', stats.totalFound, '#6b7280'],
                  ['Filtered', stats.totalFiltered, '#f59e0b'],
                  ['New', newOffers.length, newOffers.length > 0 ? '#22c55e' : '#6b7280'],
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

        <!-- New offers -->
        <tr>
          <td style="padding:24px 32px 32px 32px">
            <h2 style="margin:0 0 12px 0;font-size:16px;color:#111827;border-bottom:2px solid #e5e7eb;padding-bottom:6px">
              🆕 New Offers (${newOffers.length})
            </h2>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${offersHtml}
            </table>
            ${errorRows}
            ${newOffers.length > 0 ? `
            <p style="margin:16px 0 0 0;font-size:13px;color:#6b7280">
              These URLs have been added to your pipeline inbox. Run <code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:12px">/career-ops pipeline</code> to evaluate them.
            </p>` : ''}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center">
            <p style="margin:0;font-size:11px;color:#9ca3af">
              Sent by <strong>career-ops</strong> · portal scan ·
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

async function sendScanEmail(newOffers, date, stats) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_TO } = process.env;

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !DIGEST_TO) {
    console.error(
      'Missing required env vars for --email: GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_TO\n' +
      'Set these as repository secrets in GitHub Actions (Settings → Secrets → Actions)\n' +
      'or export them in your shell for local use.'
    );
    process.exit(1);
  }

  const html = buildScanHtml(newOffers, date, stats);
  const transporter = createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const dateLabel = formatScanDate(date, 'short');

  const info = await transporter.sendMail({
    from: `"career-ops" <${GMAIL_USER}>`,
    to: DIGEST_TO,
    subject: `career-ops scan · ${dateLabel} · ${newOffers.length} new offer${newOffers.length !== 1 ? 's' : ''}`,
    html,
  });

  console.log(`✅  Scan email sent → ${DIGEST_TO}  (messageId: ${info.messageId})`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sendEmail = args.includes('--email') || args.includes('--email-always');
  const emailAlways = args.includes('--email-always');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');

  // 7. Send email if requested
  if (sendEmail && (emailAlways || newOffers.length > 0)) {
    const stats = {
      companiesScanned: targets.length,
      totalFound,
      totalFiltered,
      errors,
    };
    await sendScanEmail(newOffers, date, stats);
  } else if (sendEmail && newOffers.length === 0) {
    console.log('No new offers found — skipping email (use --email-always to send anyway).');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
