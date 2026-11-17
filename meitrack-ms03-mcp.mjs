#!/usr/bin/env node
// Meitrack MS03 MCP server (stdio, Node >= 18). Wraps the MS03 Web API (/openapi/api/*).
//
// Cluster source (credentials are never returned by any tool). Nothing about any server is built in.
//   MEITRACK_MS03_DB_URI (or HOWEN_VSS_DB_URI / PLUS_DATABASE_URI)  PostgreSQL URI of a database with
//       "CameraServer" + "CameraAccess" tables (uniqueId = 'meitrack', enabled). Servers, URLs, usernames and
//       passwords are read from it and refreshed every MEITRACK_MS03_DB_REFRESH_MS (default 600000).
//   MEITRACK_MS03_ALIASES     "key=host,key=host" - short cluster keys for database hosts
//                             (default key: first label of the host name)
//   MEITRACK_MS03_<KEY>_URL / _USER / _PASSWORD   define a cluster in env, or override a database cluster with that key
//   MEITRACK_MS03_TZ_MINUTES  local time zone offset for inputs/outputs (default 420 = UTC+7)
//   MEITRACK_MS03_ALLOW_WRITE=1   exposes ms03_add_device (default: read-only)
//   MEITRACK_MS03_TIMEOUT_MS      per-request timeout (default 20000)
//   MEITRACK_MS03_SCAN_TIMEOUT_MS per-request timeout of ms03_storage_alarm_scan (default 60000)

import { createInterface } from "node:readline";

const VERSION = "0.3.0";
const PREFIX = "MEITRACK_MS03";
const CLUSTERS = {};
const ORDER = []; // mutated in place so tool schemas referencing it stay current
const env = process.env;
const ALLOW_WRITE = env.MEITRACK_MS03_ALLOW_WRITE === "1";
const TIMEOUT = Number(env.MEITRACK_MS03_TIMEOUT_MS || 20000);
const TOKEN_TTL_MS = 50 * 60 * 1000; // token lives ~60 min
const DB_URI = env.MEITRACK_MS03_DB_URI || env.HOWEN_VSS_DB_URI || env.PLUS_DATABASE_URI || "";
const DB_REFRESH_MS = Number(env.MEITRACK_MS03_DB_REFRESH_MS || 600000);
const TZ_MIN = Number(env.MEITRACK_MS03_TZ_MINUTES || 420); // default Asia/Bangkok
const SD_TIMEOUT = Number(env.MEITRACK_MS03_SD_TIMEOUT_MS || 90000);
const SCAN_TIMEOUT = Number(env.MEITRACK_MS03_SCAN_TIMEOUT_MS || 60000);

const hostKey = (host) => host.split(".")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "") || "ms03";
const envPrefix = (key) => `${PREFIX}_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
// "b=ms03-b.example.com,c=..." -> { "ms03-b.example.com": "b", ... }
export function parseAliases(s) {
  const out = {};
  for (const part of String(s || "").split(",")) {
    const [k, h] = part.split("=").map((x) => x && x.trim());
    if (k && h) out[h.toLowerCase()] = k.toLowerCase();
  }
  return out;
}
// Clusters defined in env: PREFIX_<KEY>_URL / _USER / _PASSWORD.
export function envClusters(prefix, e = process.env) {
  const out = {};
  const re = new RegExp(`^${prefix}_([A-Z0-9_]+)_(URL|USER|PASSWORD)$`);
  for (const [name, val] of Object.entries(e)) {
    const m = name.match(re);
    if (!m || !val) continue;
    (out[m[1].toLowerCase()] ||= {})[m[2].toLowerCase()] = val;
  }
  return out;
}
const ALIASES = parseAliases(env.MEITRACK_MS03_ALIASES);
const trimUrl = (u) => String(u).trim().replace(/\/+$/, "");

// Database rows [{ name, serverUrl, username, password }] -> clusters. Pure (exported for tests).
export function clustersFromRows(rows, aliases = ALIASES) {
  const out = {};
  const seen = new Set();
  for (const r of rows) {
    if (!r.serverUrl || !r.username || !r.password) continue;
    let u;
    try { u = new URL(String(r.serverUrl).trim()); } catch { continue; }
    if (seen.has(u.host)) continue; // same server listed for several products
    seen.add(u.host);
    let key = aliases[u.hostname.toLowerCase()] || hostKey(u.hostname);
    while (out[key]) key += "_";
    out[key] = {
      label: String(r.name || u.host),
      url: trimUrl(`${u.protocol}//${u.host}${u.pathname}`),
      user: String(r.username), pass: String(r.password), source: "database",
    };
  }
  return out;
}

let pgPool = null;
async function queryDb() {
  if (!pgPool) {
    let pg;
    try { pg = (await import("pg")).default; } catch { throw new Error("database URI is set but the 'pg' package is not installed"); }
    // libpq semantics: sslmode=require/prefer encrypts without verifying the certificate.
    const u = new URL(DB_URI);
    const mode = u.searchParams.get("sslmode");
    u.searchParams.delete("sslmode");
    const ssl = mode === "disable" ? false : mode && mode.startsWith("verify") ? { rejectUnauthorized: true } : mode ? { rejectUnauthorized: false } : undefined;
    pgPool = new pg.Pool({ connectionString: u.toString(), ssl, max: 1, idleTimeoutMillis: 30000, connectionTimeoutMillis: TIMEOUT, application_name: "meitrack-ms03-mcp" });
    pgPool.on("error", () => {});
  }
  const { rows } = await pgPool.query(`
    SELECT s.name, s."serverUrl", a.username, a.password
      FROM "CameraServer" s
      JOIN "CameraAccess" a ON a.id = s."cameraAccessId"
     WHERE s."uniqueId" = 'meitrack' AND s.enabled AND COALESCE(a.enabled, true)
     ORDER BY s."createdAt"`);
  return rows;
}

const tokens = new Map(); // key -> {token, exp, user, pass}
let loadedAt = 0;
let loadError = null;
export async function loadClusters(force = false, rowsLoader = queryDb) {
  if (!force && loadedAt && Date.now() - loadedAt < DB_REFRESH_MS) return;
  let next = {};
  if (DB_URI || rowsLoader !== queryDb) {
    try { next = clustersFromRows(await rowsLoader()); loadError = null; } catch (e) {
      loadError = `database: ${e.message}`;
      if (loadedAt) { loadedAt = Date.now() - DB_REFRESH_MS + 60000; return; } // keep last good list, retry in 1 min
    }
  }
  for (const [k, e] of Object.entries(envClusters(PREFIX))) {
    if (!next[k] && !e.url) continue;
    if (!next[k]) next[k] = { label: k, url: "", user: "", pass: "", source: "none" };
    if (e.url) next[k].url = trimUrl(e.url);
    if (e.user && e.password) Object.assign(next[k], { user: e.user, pass: e.password, source: "env" });
  }
  for (const k of Object.keys(CLUSTERS)) delete CLUSTERS[k];
  Object.assign(CLUSTERS, next);
  ORDER.splice(0, ORDER.length, ...Object.keys(next).sort());
  for (const [k, t] of tokens) { if (!next[k] || next[k].user !== t.user || next[k].pass !== t.pass) tokens.delete(k); }
  loadedAt = Date.now();
}
export const _state = { CLUSTERS, ORDER };

function cfg(key) {
  const c = CLUSTERS[key];
  if (!c) throw new Error(`unknown cluster "${key}" (use: ${ORDER.join(", ")})`);
  return { key, ...c };
}
const configured = () => ORDER.filter((k) => CLUSTERS[k].user && CLUSTERS[k].pass);

// Explain a fetch failure without leaking the URL (it carries the token/password).
export function netError(host, e, path = "") {
  const code = e?.cause?.code || e?.name || "error";
  const what = path ? `${path}: ` : "";
  if (code === "AbortError" || code === "TimeoutError") return new Error(`${what}${host} did not answer within the timeout`);
  if (/CERT|SIGNATURE|SELF_SIGNED|TLS|SSL/i.test(code)) return new Error(`${what}${host} has an invalid TLS certificate (${code}) - fix the certificate chain on that server`);
  return new Error(`${what}cannot reach ${host} (${code}) - check firewall/allowlist for this runtime`);
}

// GET JSON. The URL carries the token/password, so errors never include it.
async function get(base, path, params, timeout = TIMEOUT) {
  const url = `${base}/openapi/api/${path}?${new URLSearchParams(params)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal }).catch((e) => { throw netError(new URL(base).host, e, path); });
    const text = await r.text();
    try { return JSON.parse(text); } catch { throw new Error(`${path}: HTTP ${r.status}, non-JSON response`); }
  } finally { clearTimeout(t); }
}

async function token(key, force = false) {
  const hit = tokens.get(key);
  if (!force && hit && hit.exp > Date.now()) return hit.token;
  const c = cfg(key);
  if (!c.user || !c.pass) throw new Error(`cluster ${key}: credentials not configured (${envPrefix(key)}_USER / _PASSWORD or CameraAccess in the database)${loadError ? ` - ${loadError}` : ""}`);
  const res = await get(c.url, "Login", { userid: c.user, password: c.pass });
  if (res.state !== true || !res.value) throw new Error(`cluster ${key}: login failed${res.message ? ` (${res.message})` : ""}`);
  tokens.set(key, { token: res.value, exp: Date.now() + TOKEN_TTL_MS, user: c.user, pass: c.pass });
  return res.value;
}

const TOKEN_ERR = /invalid token|expired token|token (is )?(invalid|expired)|token has expired|exceeded the use of the number of times/i;
async function api(key, path, params = {}, timeout = TIMEOUT) {
  let res = await get(cfg(key).url, path, { ...params, Token: await token(key) }, timeout);
  if (res?.state === false && TOKEN_ERR.test(String(res.message || ""))) {
    res = await get(cfg(key).url, path, { ...params, Token: await token(key, true) }, timeout);
  }
  return res;
}
function value(key, res, what) {
  if (Array.isArray(res)) return res; // SearchFTPFile may return a bare array
  if (res?.state !== true) {
    // No message from the server: show the (token-free) response body so the cause is visible.
    const detail = res?.message ? res.message : `response: ${JSON.stringify(res).slice(0, 300)}`;
    throw new Error(`cluster ${key}: ${what} failed (${detail})`);
  }
  return res.value;
}

// Device list per cluster, cached 5 min (Tracker returns every terminal of the account).
const lists = new Map();
async function trackers(key) {
  const hit = lists.get(key);
  if (hit && hit.exp > Date.now()) return hit.list;
  const list = value(key, await api(key, "Tracker"), "Tracker") || [];
  lists.set(key, { list, exp: Date.now() + 5 * 60 * 1000 });
  return list;
}
const brief = (key, d) => ({
  cluster: key, imei: d.sn_imei_id ?? d.imei, name: d.tracker_name, sim: d.tracker_sim_number,
  type: d.tracker_type_id, firmware: d.tracker_firmware_version, account: d.account ?? d.user_name ?? d.userid,
});

async function eachCluster(cluster, fn) {
  const keys = cluster ? [cluster] : configured();
  if (!keys.length) throw new Error("no cluster has credentials configured");
  const errors = [];
  await Promise.all(keys.map(async (k) => { try { await fn(k); } catch (e) { errors.push(e.message); } }));
  return errors;
}

async function connectStatus(key, imeis) {
  return value(key, await api(key, "Tracker/GetTrackerConnectStatus", { Imeis: imeis.join(","), timeZoneMinutes: TZ_MIN }), "GetTrackerConnectStatus") || [];
}

// Find which cluster holds an IMEI (exact match). Prefers an online device, then the latest lastReceivedTime.
async function locate(imei, cluster) {
  const hits = [];
  const errors = await eachCluster(cluster, async (k) => {
    for (const d of await trackers(k)) if (String(d.sn_imei_id ?? d.imei) === String(imei)) hits.push({ cluster: k, device: d });
  });
  if (!hits.length) throw new Error(`IMEI ${imei} not found${cluster ? ` in ${cluster}` : ""}${errors.length ? ` (errors: ${errors.join("; ")})` : ""}`);
  if (hits.length > 1) {
    for (const h of hits) { try { h.status = (await connectStatus(h.cluster, [imei]))[0]; } catch { /* ignore */ } }
    hits.sort((a, b) => (Number(b.status?.onlineMode ?? -1) >= 0) - (Number(a.status?.onlineMode ?? -1) >= 0)
      || String(b.status?.lastReceivedTime || "").localeCompare(String(a.status?.lastReceivedTime || "")));
  }
  return { ...hits[0], also_in: hits.slice(1).map((h) => h.cluster) };
}

// Latest GPS point. HistoryLocation returns at most 100 rows per page in time order, so look back in growing
// windows (1h, 6h, then `hours`) and page through the first window that has data.
const PAGE = 100;
export async function lastLocation(k, imei, hours = 24, fetchPage = (p) => api(k, "HistoryLocation", p)) {
  const end = new Date();
  for (const h of [...new Set([1, 6, hours].filter((x) => x <= hours).concat(hours))]) {
    let lastPt = null;
    for (let page = 0, start = 0; page < 50; page++, start += PAGE) {
      const pts = value(k, await fetchPage({ Imeis: imei, BeginGMT: gmt(new Date(end - h * 3600000)), EndGMT: gmt(end), StartIdx: start, Limit: PAGE }), "HistoryLocation") || [];
      if (pts.length) lastPt = pts[pts.length - 1];
      if (pts.length < PAGE) break;
    }
    if (lastPt) return withLocal(lastPt);
  }
  return null;
}
// Add local-time copies of the GMT timestamps the API returns.
export function withLocal(row) {
  const loc = (s) => (s ? new Date(new Date(`${String(s).replace(" ", "T")}Z`).getTime() + TZ_MIN * 60000).toISOString().replace("T", " ").slice(0, 19) : undefined);
  const t = row?.tracker_location || row;
  const g = t?.gps_info || row?.gps_info;
  return { ...row, time_local: loc(t?.r_datetime || g?.l_datetime), gps_time_local: loc(g?.l_datetime) };
}

// File lists can be thousands of rows: summarize per channel and return only the newest `limit` files.
export const fromCompact = (s) => (/^\d{12}$/.test(String(s)) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)} ${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}` : s);
export function fileResult(k, imei, source, files, limit = 50) {
  const sorted = [...files].sort((a, b) => String(b.begin_local).localeCompare(String(a.begin_local)));
  const by = new Map();
  for (const f of files) {
    const ch = f.ch ?? f.channel;
    const e = by.get(ch) || { channel: ch, files: 0, first_begin: f.begin_local, last_end: f.end_local };
    e.files++;
    if (String(f.begin_local) < String(e.first_begin)) e.first_begin = f.begin_local;
    if (String(f.end_local) > String(e.last_end)) e.last_end = f.end_local;
    by.set(ch, e);
  }
  const channels = [...by.values()].sort((a, b) => Number(a.channel) - Number(b.channel));
  return { cluster: k, imei, source, count: files.length, channels, returned: Math.min(limit, files.length), files: sorted.slice(0, limit) };
}

// Time helpers. Inputs are local (TZ_MIN) "YYYY-MM-DD HH:mm[:ss]".
export function parseLocal(s) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`bad time "${s}" (use YYYY-MM-DD HH:mm:ss, local time)`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - TZ_MIN * 60000);
}
export const gmt = (d) => d.toISOString().replace("T", " ").slice(0, 19); // YYYY-MM-DD HH:mm:ss UTC
export const compactLocal = (d) => new Date(d.getTime() + TZ_MIN * 60000).toISOString().replace(/[-:TZ]/g, "").slice(2, 14); // YYMMDDHHMMSS local
const ONLINE = { "-1": "offline", 0: "online (GPRS)", 1: "online (GSM)", 2: "online (Wi-Fi)", 3: "online (LAN)" };

// ---------------- Fleet-wide alarm scan ----------------
// HistoryAlarm accepts many comma-separated IMEIs. The server answers HTTP 404 once the URL passes ~2 KB
// (150 IMEIs fail, 100 pass), so batches are capped by count and by the length of the Imeis parameter.
// `message` carries the total row count; rows come back in time order and page with StartIdx/Limit.
export const SCAN_MAX_IMEI_CHARS = 1700;
export function batchImeis(imeis, size = 50, maxChars = SCAN_MAX_IMEI_CHARS) {
  const out = [];
  let cur = [], len = 0;
  for (const i of imeis) {
    const add = String(i).length + (cur.length ? 1 : 0);
    if (cur.length && (cur.length >= size || len + add > maxChars)) { out.push(cur); cur = []; len = 0; }
    len += String(i).length + (cur.length ? 1 : 0);
    cur.push(String(i));
  }
  if (cur.length) out.push(cur);
  return out;
}

const gmtToLocal = (d) => new Date(d.getTime() + TZ_MIN * 60000).toISOString().replace("T", " ").slice(0, 19);
const localOf = (s) => (s ? new Date(new Date(`${String(s).replace(" ", "T")}Z`).getTime() + TZ_MIN * 60000).toISOString().replace("T", " ").slice(0, 19) : null);
// Fold raw HistoryAlarm rows into one summary per IMEI (counts per code, first/last local time, last position).
export function summarizeAlarms(rows, acc = new Map()) {
  for (const r of rows) {
    const t = r?.tracker_location || {};
    const imei = String(t.sn_imei_id ?? r?.imei ?? "");
    if (!imei) continue;
    const code = String(r.meitrackeventid ?? t.alarm_id ?? "?");
    const when = localOf(t.r_datetime || t.gps_info?.l_datetime);
    const e = acc.get(imei) || { imei, tracker_name: t.tracker_name ?? null, total: 0, counts: {}, first_local: when, last_local: when, last_location: null };
    e.total++;
    e.counts[code] = (e.counts[code] || 0) + 1;
    if (when && (!e.first_local || when < e.first_local)) e.first_local = when;
    if (when && (!e.last_local || when >= e.last_local)) {
      e.last_local = when;
      const g = t.gps_info;
      if (t.tracker_name) e.tracker_name = t.tracker_name;
      e.last_location = g ? { lat: g.latitude, lng: g.longitude, speed: g.speed, gps_valid: g.gps_valid, gps_time_local: localOf(g.l_datetime), address: g.address || undefined } : null;
    }
    acc.set(imei, e);
  }
  return acc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Run one request with retries; the token refresh itself is handled inside api().
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(1000 * (i + 1)); }
  }
  throw last;
}

// Scan one cluster. fetchPage(params) returns the raw HistoryAlarm response (injectable for tests).
export async function scanCluster(k, imeis, { beginGMT, endGMT, alarmTypes, batchSize = 50, pageSize = 1000, concurrency = 3, tries = 3, maxPages = 200 }, fetchPage) {
  const batches = batchImeis(imeis, batchSize);
  const acc = new Map();
  const failed = [];
  let requests = 0, rows = 0, next = 0;
  const one = async (b, idx) => {
    const local = new Map();
    let got = 0;
    for (let page = 0, start = 0; page < maxPages; page++, start += pageSize) {
      const p = { Imeis: b.join(","), BeginGMT: beginGMT, EndGMT: endGMT, StartIdx: start, Limit: pageSize, timeZoneMinutes: TZ_MIN };
      if (alarmTypes) p.AlarmTypes = alarmTypes;
      requests++;
      const res = await withRetry(async () => value(k, await fetchPage(p), "HistoryAlarm"), tries);
      const v = Array.isArray(res) ? res : [];
      summarizeAlarms(v, local);
      got += v.length;
      if (v.length < pageSize) return { local, got, truncated: false };
    }
    return { local, got, truncated: true };
  };
  const worker = async () => {
    while (next < batches.length) {
      const idx = next++;
      const b = batches[idx];
      try {
        const { local, got, truncated } = await one(b, idx);
        rows += got;
        for (const [imei, e] of local) acc.set(imei, e);
        if (truncated) failed.push({ cluster: k, batch: idx, imeis: b, error: `stopped after ${maxPages} pages - narrow the time range` });
      } catch (e) {
        failed.push({ cluster: k, batch: idx, imeis: b, error: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
  failed.sort((a, b) => a.batch - b.batch);
  return { batches: batches.length, requests, rows, devices: acc, failed };
}

const clusterProp = { type: "string", enum: ORDER, description: "MS03 cluster. Omit to search all configured clusters." };
const imeiProp = { type: "string", description: "Device IMEI (sn_imei_id), 15 digits" };
const timeProp = (d) => ({ type: "string", description: `${d} - local time, YYYY-MM-DD HH:mm:ss` });

const TOOLS = [
  {
    name: "ms03_list_clusters",
    description: "List Meitrack MS03 clusters (from the CameraServer database table and/or env), URL, credential source and whether credentials exist. Never returns credentials.",
    inputSchema: { type: "object", properties: { test_login: { type: "boolean" }, reload: { type: "boolean", description: "Re-read the database now" } } },
    readOnly: true,
    async run({ test_login, reload }) {
      if (reload) await loadClusters(true);
      const out = [];
      for (const k of ORDER) {
        const c = cfg(k);
        const row = { cluster: k, name: c.label, url: c.url, credentials: !!(c.user && c.pass), source: c.source };
        if (test_login && row.credentials) { try { await token(k, true); row.login = "ok"; } catch (e) { row.login = e.message; } }
        out.push(row);
      }
      return { clusters: out, database: DB_URI ? (loadError || "ok") : "not configured", write_enabled: ALLOW_WRITE };
    },
  },
  {
    name: "ms03_find_device",
    description: "Search devices by IMEI, name/plate, SIM or firmware (substring, case-insensitive) across clusters. Returns cluster, IMEI, name, SIM, type, firmware.",
    inputSchema: { type: "object", properties: { keyword: { type: "string" }, cluster: clusterProp, limit: { type: "integer", minimum: 1, maximum: 200, default: 20 } }, required: ["keyword"] },
    readOnly: true,
    async run({ keyword, cluster, limit = 20 }) {
      const q = String(keyword).toLowerCase();
      const results = [];
      const errors = await eachCluster(cluster, async (k) => {
        for (const d of await trackers(k)) {
          const hay = [d.sn_imei_id, d.imei, d.tracker_name, d.tracker_sim_number, d.tracker_firmware_version].map((x) => String(x ?? "").toLowerCase());
          if (hay.some((h) => h.includes(q))) results.push(brief(k, d));
        }
      });
      return { count: results.length, results: results.slice(0, limit), errors };
    },
  },
  {
    name: "ms03_device_status",
    description: "Online status of a device (onlineMode, lastConnectTime, lastReceivedTime) plus its latest GPS point from the last `hours` (default 24). Finds the cluster automatically.",
    inputSchema: { type: "object", properties: { imei: imeiProp, cluster: clusterProp, hours: { type: "number", default: 24 } }, required: ["imei"] },
    readOnly: true,
    async run({ imei, cluster, hours = 24 }) {
      const { cluster: k, device, also_in } = await locate(imei, cluster);
      const s = (await connectStatus(k, [imei]))[0] || null;
      let last = null;
      try { last = await lastLocation(k, imei, hours); } catch (e) { last = `HistoryLocation failed: ${e.message}`; }
      return {
        ...brief(k, device), also_in, online: s ? Number(s.onlineMode) >= 0 : null,
        online_mode: s ? (ONLINE[s.onlineMode] ?? String(s.onlineMode)) : null, status: s, last_location: last,
      };
    },
  },
  {
    name: "ms03_alarm_history",
    description: "Alarm history (HistoryAlarm) for a device in a time range. Optional alarm codes, e.g. 608 storage failure, 609 storage full, 576-583 CH1-8 video loss, 190 TF card lost.",
    inputSchema: {
      type: "object",
      properties: { imei: imeiProp, cluster: clusterProp, start: timeProp("Start"), end: timeProp("End"), alarm_types: { type: "string", description: "Comma-separated alarm codes" }, limit: { type: "integer", default: 100 } },
      required: ["imei", "start", "end"],
    },
    readOnly: true,
    async run({ imei, cluster, start, end, alarm_types, limit = 100 }) {
      const k = cluster || (await locate(imei)).cluster;
      const p = { Imeis: imei, BeginGMT: gmt(parseLocal(start)), EndGMT: gmt(parseLocal(end)), StartIdx: 0, Limit: limit, timeZoneMinutes: TZ_MIN };
      if (alarm_types) p.AlarmTypes = alarm_types;
      const v = value(k, await api(k, "HistoryAlarm", p), "HistoryAlarm") || [];
      return { cluster: k, imei, count: v.length, alarms: v.map(withLocal) };
    },
  },
  {
    name: "ms03_storage_alarm_scan",
    description: "Fleet-wide scan of storage alarms (default 608 storage failure, 609 storage full, 190 TF card lost) for EVERY device of one or all clusters, using batched HistoryAlarm calls. Returns one summary row per device that had alarms (counts per code, first/last local time, last position) plus totals and the batches/IMEIs that could not be scanned. Never returns raw events. Range up to 31 days.",
    inputSchema: {
      type: "object",
      properties: {
        start: timeProp("Start"), end: timeProp("End"), cluster: clusterProp,
        alarm_types: { type: "string", default: "608,609,190", description: "Comma-separated alarm codes" },
        batch_size: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "IMEIs per HistoryAlarm call (server rejects URLs over ~2 KB, ~100 IMEIs)" },
        max_devices: { type: "integer", minimum: 1, maximum: 5000, default: 3000, description: "Max device rows returned (most alarms first); totals always cover all devices" },
      },
      required: ["start", "end"],
    },
    readOnly: true,
    async run({ start, end, cluster, alarm_types = "608,609,190", batch_size = 50, max_devices = 3000 }) {
      const b = parseLocal(start), e = parseLocal(end);
      if (!(e > b)) throw new Error("end must be after start");
      if (e - b > 31 * 86400000) throw new Error("range is limited to 31 days");
      if (alarm_types && !/^\d+(,\d+)*$/.test(String(alarm_types).replace(/\s/g, ""))) throw new Error("alarm_types must be comma-separated numbers");
      const types = alarm_types ? String(alarm_types).replace(/\s/g, "") : "";
      const t0 = Date.now();
      const perCluster = [], devices = [], failed = [];
      const errors = await eachCluster(cluster, async (k) => {
        const c0 = Date.now();
        let list;
        try { list = await withRetry(() => trackers(k)); } catch (err) { throw new Error(`cluster ${k}: device list failed - ${err.message}`); }
        const names = new Map(list.map((d) => [String(d.sn_imei_id ?? d.imei), d.tracker_name]));
        const imeis = [...names.keys()].filter(Boolean);
        const r = await scanCluster(k, imeis, { beginGMT: gmt(b), endGMT: gmt(e), alarmTypes: types, batchSize: batch_size },
          (p) => api(k, "HistoryAlarm", p, Math.max(TIMEOUT, SCAN_TIMEOUT)));
        const failedImeis = r.failed.reduce((n, f) => n + f.imeis.length, 0);
        for (const d of r.devices.values()) devices.push({ cluster: k, ...d, tracker_name: names.get(d.imei) ?? d.tracker_name });
        failed.push(...r.failed);
        perCluster.push({ cluster: k, devices_scanned: imeis.length - failedImeis, devices_with_alarms: r.devices.size, devices_failed: failedImeis, batches: r.batches, requests: r.requests, events: r.rows, seconds: Math.round((Date.now() - c0) / 100) / 10 });
      });
      devices.sort((x, y) => y.total - x.total || String(y.last_local).localeCompare(String(x.last_local)));
      perCluster.sort((x, y) => x.cluster.localeCompare(y.cluster));
      const sum = (f) => perCluster.reduce((n, c) => n + c[f], 0);
      return {
        range_local: { start: gmtToLocal(b), end: gmtToLocal(e) }, alarm_types: types || "all",
        summary: {
          clusters: perCluster.length, devices_scanned: sum("devices_scanned"), devices_with_alarms: devices.length,
          devices_failed: sum("devices_failed"), events: sum("events"), batches: sum("batches"), requests: sum("requests"),
          seconds: Math.round((Date.now() - t0) / 100) / 10, complete: !failed.length && !errors.length,
        },
        per_cluster: perCluster, cluster_errors: errors,
        failed_batches: failed,
        returned: Math.min(max_devices, devices.length), devices: devices.slice(0, max_devices),
      };
    },
  },
  {
    name: "ms03_video_files",
    description: "List recorded video files for a device. source=sd (on the device SD card, device must be online) or ftp (already uploaded, includes MP4 download URLs).",
    inputSchema: {
      type: "object",
      properties: {
        imei: imeiProp, cluster: clusterProp, start: timeProp("Start"), end: timeProp("End"),
        source: { type: "string", enum: ["sd", "ftp"], default: "ftp" },
        channel: { type: "integer", description: "Channel number; 0 or omitted = all" },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 50, description: "Max files returned (newest first); the per-channel summary always covers all files" },
      },
      required: ["imei", "start", "end"],
    },
    readOnly: true,
    async run({ imei, cluster, start, end, source = "ftp", channel = 0, limit = 50 }) {
      const k = cluster || (await locate(imei)).cluster;
      const s = compactLocal(parseLocal(start)), e = compactLocal(parseLocal(end));
      if (source === "sd") {
        // The platform asks the device over the air, which can take close to a minute.
        const v = value(k, await api(k, "Commander/GetVideoFileInfo", { imei, channel, starttime: s, endtime: e, meitrackalarms: 0, audiovideo: 0, stream: 1, store: 0 }, Math.max(TIMEOUT, SD_TIMEOUT)), "GetVideoFileInfo");
        const files = v?.files || [];
        return fileResult(k, imei, source, files.map((f) => ({ ...f, begin_local: fromCompact(f.starttime), end_local: fromCompact(f.stoptime) })), limit);
      }
      const v = value(k, await api(k, "Stream/SearchFTPFile", { imei, channels: channel ? String(channel) : "", startTime: s, endTime: e, filetype: 0 }, Math.max(TIMEOUT, SD_TIMEOUT)), "SearchFTPFile") || [];
      const slim = v.map((f) => ({ ch: f.ch, begin_local: f.beginTime, end_local: f.endTime, size: f.movieSize, alarm: f.alarmStatus, mp4: f.downloadurlMP4 || f.downloadurl }));
      return fileResult(k, imei, source, slim, limit);
    },
  },
  {
    name: "ms03_add_device",
    description: "WRITE. Add a device (Tracker/Add). Checks every cluster for the IMEI first and refuses if it exists. Requires confirm=true after the user approved the exact values.",
    inputSchema: {
      type: "object",
      properties: {
        cluster: { type: "string", enum: ORDER }, account: { type: "string", description: "Account to attach the device to" },
        imei: imeiProp, name: { type: "string", description: "Tracker name / plate" }, sim: { type: "string" },
        tracker_password: { type: "string", default: "0000" }, tracker_type_id: { type: "string", default: "0", description: "0 = auto detect, 55 = MD500S" },
        confirm: { type: "boolean" },
      },
      required: ["cluster", "account", "imei", "name", "sim", "confirm"],
    },
    async run(a) {
      if (a.confirm !== true) throw new Error("write refused: confirm must be true, and only after the user explicitly approved this exact change");
      try { const f = await locate(a.imei); throw Object.assign(new Error(`IMEI ${a.imei} already exists in ${[f.cluster, ...f.also_in].join(", ")}`), { dup: true }); } catch (e) { if (e.dup) throw e; }
      const req = { Account: a.account, AddImei: a.imei, TrackerPassword: a.tracker_password || "0000", TrackerName: a.name, TrackerSimNumber: a.sim, TrackerTypeId: a.tracker_type_id || "0", Month: 0 };
      const res = await api(a.cluster, "Tracker/Add", req);
      value(a.cluster, res, "Tracker/Add");
      lists.delete(a.cluster);
      const after = (await trackers(a.cluster)).find((d) => String(d.sn_imei_id ?? d.imei) === String(a.imei));
      return { cluster: a.cluster, request: { ...req, TrackerPassword: "***" }, response: res.value ?? null, after: after ? brief(a.cluster, after) : null };
    },
  },
];
const visibleTools = () => TOOLS.filter((t) => t.readOnly || ALLOW_WRITE);

// ---------------- MCP JSON-RPC over stdio ----------------
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

export async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;
  if (method === "tools/list" || method === "tools/call") await loadClusters();
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "meitrack-ms03", version: VERSION },
        instructions: "Meitrack MS03 (MDVR MD500/MD500S) tools. Clusters come from the CameraServer/CameraAccess database tables and/or env; call ms03_list_clusters to see them. Times are local (MEITRACK_MS03_TZ_MINUTES, default UTC+7). ms03_add_device exists only when enabled and needs confirm=true after the user approves the exact values. Never print credentials.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: visibleTools().map(({ name, description, inputSchema, readOnly }) => ({
          name, description, inputSchema, annotations: { readOnlyHint: !!readOnly, destructiveHint: false, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const tool = visibleTools().find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
      try {
        return reply(id, { content: [{ type: "text", text: JSON.stringify(await tool.run(params.arguments || {}), null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

if (process.env.MEITRACK_MS03_NO_STDIO !== "1") {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, "parse error"); }
    handle(msg).catch((e) => fail(msg.id ?? null, -32603, e.message));
  });
}
