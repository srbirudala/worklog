import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Jira client ──────────────────────────────────────────────────────────────

const JIRA_BASE = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');

function authHeader() {
  const creds = Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${creds}`;
}

async function jira(path, opts = {}) {
  const url = `${JIRA_BASE}/rest/api/3${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ── IST helpers ──────────────────────────────────────────────────────────────

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function toISTDate(iso) {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function commentText(field) {
  if (!field?.content) return '';
  return field.content
    .flatMap(b => b.content || [])
    .filter(n => n.type === 'text')
    .map(n => n.text)
    .join('')
    .trim();
}

function adfComment(text) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Config: team members from .env
app.get('/api/config', (req, res) => {
  let members = [];
  try { members = JSON.parse(process.env.TEAM_MEMBERS || '[]'); } catch {}
  res.json({ members, jiraBase: JIRA_BASE });
});

// Worklogs for a set of dates + one user
// GET /api/worklogs?accountId=xxx&dates[]=2026-08-31&dates[]=2026-09-01
app.get('/api/worklogs', async (req, res) => {
  const { accountId } = req.query;
  const dates = [].concat(req.query['dates[]'] || req.query.dates || []);

  if (!accountId || !dates.length) {
    return res.status(400).json({ error: 'accountId and at least one date required' });
  }

  try {
    const result = Object.fromEntries(dates.map(d => [d, []]));

    await Promise.all(dates.map(async date => {
      const jql = `worklogDate = "${date}" AND worklogAuthor = "${accountId}"`;
      const data = await jira('/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql, fields: ['summary', 'worklog'], maxResults: 50 }),
      });

      for (const issue of data?.issues || []) {
        let worklogs = issue.fields.worklog?.worklogs || [];

        // Jira returns up to 20 worklogs inline; paginate if there are more
        const total = issue.fields.worklog?.total || 0;
        if (total > worklogs.length) {
          const extra = await jira(`/issue/${issue.key}/worklog?startAt=20&maxResults=100`);
          worklogs = worklogs.concat(extra?.worklogs || []);
        }

        for (const wl of worklogs) {
          if (wl.author.accountId !== accountId) continue;
          if (toISTDate(wl.started) !== date) continue;
          result[date].push({
            issueKey: issue.key,
            issueSummary: issue.fields.summary,
            worklogId: wl.id,
            started: wl.started,
            timeSpent: wl.timeSpent,
            timeSpentSeconds: wl.timeSpentSeconds,
            comment: commentText(wl.comment),
          });
        }
      }
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create worklog
// POST /api/worklogs  { issueKey, timeSpent, comment, started }
app.post('/api/worklogs', async (req, res) => {
  const { issueKey, timeSpent, comment, started } = req.body;
  if (!issueKey || !timeSpent || !started) {
    return res.status(400).json({ error: 'issueKey, timeSpent, started required' });
  }
  try {
    const body = { timeSpent, started };
    if (comment) body.comment = adfComment(comment);
    const data = await jira(`/issue/${issueKey}/worklog`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    res.json({
      worklogId: data.id,
      timeSpent: data.timeSpent,
      timeSpentSeconds: data.timeSpentSeconds,
      started: data.started,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update worklog
// PUT /api/worklogs/:issueKey/:worklogId  { timeSpent, comment, started }
app.put('/api/worklogs/:issueKey/:worklogId', async (req, res) => {
  const { issueKey, worklogId } = req.params;
  const { timeSpent, comment, started } = req.body;
  try {
    const body = { timeSpent, started };
    if (comment !== undefined) body.comment = comment ? adfComment(comment) : { type: 'doc', version: 1, content: [] };
    const data = await jira(`/issue/${issueKey}/worklog/${worklogId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    res.json({ timeSpent: data.timeSpent, timeSpentSeconds: data.timeSpentSeconds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete worklog
// DELETE /api/worklogs/:issueKey/:worklogId
app.delete('/api/worklogs/:issueKey/:worklogId', async (req, res) => {
  const { issueKey, worklogId } = req.params;
  try {
    await jira(`/issue/${issueKey}/worklog/${worklogId}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Issue picker autocomplete
// GET /api/issues/search?q=PCA-19
app.get('/api/issues/search', async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.json([]);
  try {
    const data = await jira(`/issue/picker?query=${encodeURIComponent(q)}&showSubTasks=true`);
    let issues = (data?.sections || [])
      .flatMap(s => s.issues || [])
      .map(i => ({ key: i.key, summary: i.summaryText || i.summary }));

    // Fallback: try direct key lookup if no picker results
    if (!issues.length && /^[A-Za-z]+-\d+$/.test(q.trim())) {
      try {
        const d = await jira(`/issue/${q.trim().toUpperCase()}?fields=summary`);
        issues = [{ key: d.key, summary: d.fields.summary }];
      } catch {}
    }
    res.json(issues.slice(0, 10));
  } catch {
    res.json([]);
  }
});

// Jira user search
// GET /api/users/search?q=surendranath
app.get('/api/users/search', async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.json([]);
  try {
    const data = await jira(`/user/search?query=${encodeURIComponent(q)}&maxResults=10`);
    const users = (Array.isArray(data) ? data : []).map(u => ({
      accountId: u.accountId,
      displayName: u.displayName,
      emailAddress: u.emailAddress,
    }));
    res.json(users);
  } catch {
    res.json([]);
  }
});

app.listen(PORT, () => {
  console.log(`\n  Worklog app  →  http://localhost:${PORT}\n`);
  if (!process.env.JIRA_API_TOKEN || !process.env.JIRA_USER_EMAIL) {
    console.warn('  ⚠  JIRA_USER_EMAIL or JIRA_API_TOKEN not set — copy .env.example to .env and fill in credentials\n');
  }
});
