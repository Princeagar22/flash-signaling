/**
 * Persistent admin data: bans, reports, remote app config.
 * Set ADMIN_DATA_PATH on Railway with a mounted volume for durability.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH =
  process.env.ADMIN_DATA_PATH ||
  path.join(__dirname, 'data', 'admin.json');

const DEFAULT_CONFIG = {
  maintenance: false,
  maintenanceMessage:
    'FLASH is under maintenance. Please try again in a few minutes.',
  announcement: '',
  requireLogin: false,
  randomMatchEnabled: true,
  minAppVersion: '',
  minWebVersion: '',
};

function defaultData() {
  return {
    bans: {},
    reports: [],
    config: { ...DEFAULT_CONFIG },
  };
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    if (!fs.existsSync(DATA_PATH)) return defaultData();
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      bans: parsed.bans || {},
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
    };
  } catch (e) {
    console.error('[admin-store] load failed', e.message);
    return defaultData();
  }
}

let data = load();
let saveTimer = null;

function persist() {
  try {
    ensureDir(DATA_PATH);
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[admin-store] save failed', e.message);
  }
}

function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 400);
}

function normEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function isBanned({ email, userId }) {
  const e = normEmail(email);
  if (e && data.bans[e]) return data.bans[e];
  if (userId) {
    for (const [em, entry] of Object.entries(data.bans)) {
      if (entry.userId === userId) return { ...entry, email: em };
    }
  }
  return null;
}

function banUser({ email, userId, reason, by }) {
  const e = normEmail(email);
  if (!e && !userId) return null;
  const key = e || `uid:${userId}`;
  const entry = {
    email: e || '',
    userId: userId || '',
    reason: String(reason || 'Banned by admin').slice(0, 500),
    at: Date.now(),
    by: by || 'admin',
  };
  data.bans[key.startsWith('uid:') ? key : e] = entry;
  saveSoon();
  return entry;
}

function unbanUser({ email, userId }) {
  const e = normEmail(email);
  let removed = false;
  if (e && data.bans[e]) {
    delete data.bans[e];
    removed = true;
  }
  if (userId) {
    for (const [k, v] of Object.entries(data.bans)) {
      if (v.userId === userId || k === `uid:${userId}`) {
        delete data.bans[k];
        removed = true;
      }
    }
  }
  if (removed) saveSoon();
  return removed;
}

function listBans() {
  return Object.entries(data.bans).map(([key, v]) => ({
    key,
    ...v,
  }));
}

function addReport(r) {
  const report = {
    id: r.id,
    reporterId: r.reporterId || '',
    reporterEmail: r.reporterEmail || '',
    reportedUserId: r.reportedUserId || '',
    reportedEmail: r.reportedEmail || '',
    reason: String(r.reason || '').slice(0, 1000),
    context: r.context || 'call',
    room: r.room || '',
    at: r.at || Date.now(),
    status: 'pending',
  };
  data.reports.unshift(report);
  if (data.reports.length > 500) data.reports.length = 500;
  saveSoon();
  return report;
}

function listReports(status) {
  let list = data.reports;
  if (status) list = list.filter((r) => r.status === status);
  return list;
}

function resolveReport(id, status, note) {
  const r = data.reports.find((x) => x.id === id);
  if (!r) return null;
  r.status = status;
  r.resolvedAt = Date.now();
  r.adminNote = String(note || '').slice(0, 500);
  saveSoon();
  return r;
}

function getPublicConfig() {
  return { ...data.config };
}

function setConfig(partial) {
  const allowed = Object.keys(DEFAULT_CONFIG);
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(partial, k)) {
      data.config[k] = partial[k];
    }
  }
  saveSoon();
  return getPublicConfig();
}

module.exports = {
  DATA_PATH,
  isBanned,
  banUser,
  unbanUser,
  listBans,
  addReport,
  listReports,
  resolveReport,
  getPublicConfig,
  setConfig,
  reload: () => {
    data = load();
  },
};
