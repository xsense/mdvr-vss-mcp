#!/usr/bin/env node
// Howen VSS MCP server (stdio, Node >= 18).
// Wraps Howen VSS Web API V2.8.0. Clusters come from a database and/or env.
//
// Cluster source (credentials are never returned by any tool). Nothing about any server is built in.
//   HOWEN_VSS_DB_URI (or PLUS_DATABASE_URI)  PostgreSQL URI of a database with "CameraServer" + "CameraAccess"
//       tables (uniqueId = 'howen', enabled). Clusters, URLs, usernames and passwords are read from it and
//       refreshed every HOWEN_VSS_DB_REFRESH_MS (default 600000). Passwords stored as MD5 hex are sent as-is.
//   HOWEN_VSS_ALIASES         "key=host,key=host" - short cluster keys for database hosts
//                             (default key: first label of the host name)
//   HOWEN_VSS_<KEY>_URL / _USER / _PASSWORD   define a cluster in env, or override a database cluster with that key
//   HOWEN_VSS_KEEP_PORT=1     keep the :9965 port from the database URL (default: drop it and use HTTPS 443)
//   HOWEN_VSS_ALLOW_WRITE=1   enables add/modify/remove/set tools (default: read-only)
//   HOWEN_VSS_TIMEOUT_MS      per-request timeout (default 20000)

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const VERSION = "0.4.0";
const PREFIX = "HOWEN_VSS";
// CLUSTERS / ORDER are mutated in place on reload so tool schemas that reference ORDER stay current.
const CLUSTERS = {};
const ORDER = [];
const ALLOW_WRITE = process.env.HOWEN_VSS_ALLOW_WRITE === "1";
const TIMEOUT = Number(process.env.HOWEN_VSS_TIMEOUT_MS || 20000);
const TOKEN_TTL_MS = 25 * 60 * 1000; // VSS token lives 30 min
const DB_URI = process.env.HOWEN_VSS_DB_URI || process.env.PLUS_DATABASE_URI || "";
const DB_REFRESH_MS = Number(process.env.HOWEN_VSS_DB_REFRESH_MS || 600000);
const KEEP_PORT = process.env.HOWEN_VSS_KEEP_PORT === "1";

// "main=vss.example.com,ha=ha.example.com" -> { "vss.example.com": "main", ... }
export function parseAliases(s) {
  const out = {};
  for (const part of String(s || "").split(",")) {
    const [k, h] = part.split("=").map((x) => x && x.trim());
    if (k && h) out[h.toLowerCase()] = k.toLowerCase();
  }
  return out;
}
// Clusters defined in env: PREFIX_<KEY>_URL / _USER / _PASSWORD.
export function envClusters(prefix, env = process.env) {
  const out = {};
  const re = new RegExp(`^${prefix}_([A-Z0-9_]+)_(URL|USER|PASSWORD)$`);
  for (const [name, val] of Object.entries(env)) {
    const m = name.match(re);
    if (!m || !val) continue;
    const key = m[1].toLowerCase();
    (out[key] ||= {})[m[2].toLowerCase()] = val;
  }
  return out;
}
const ALIASES = parseAliases(process.env.HOWEN_VSS_ALIASES);

const isMd5 = (s) => /^[0-9a-f]{32}$/i.test(String(s || ""));
const md5hex = (s) => createHash("md5").update(String(s), "utf8").digest("hex");

export function normUrl(raw, keepPort = KEEP_PORT) {
  const u = new URL(String(raw).trim());
  if (!keepPort && u.port === "9965") u.port = "";
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
}

// Turn database rows [{ name, serverUrl, username, password }] into clusters. Pure (exported for tests).
export function clustersFromRows(rows, keepPort = KEEP_PORT, aliases = ALIASES) {
  const out = {};
  const seenHost = new Set();
  for (const r of rows) {
    if (!r.serverUrl || !r.username || !r.password) continue;
    let url;
    try { url = normUrl(r.serverUrl, keepPort); } catch { continue; }
    const host = new URL(url).hostname;
    if (seenHost.has(host)) continue; // same VSS listed twice (e.g. different retention products)
    seenHost.add(host);
    let key = aliases[host.toLowerCase()] || host.split(".")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "") || "vss";
    while (out[key]) key += "_";
    out[key] = { label: String(r.name || host), url, user: String(r.username), pass: String(r.password), source: "database" };
  }
  return out;
}

let pgPool = null;
async function queryDb() {
  if (!pgPool) {
    let pg;
    try { pg = (await import("pg")).default; } catch { throw new Error("HOWEN_VSS_DB_URI is set but the 'pg' package is not installed"); }
    // libpq semantics: sslmode=require/prefer encrypts without verifying the certificate (RDS CA is not in Node's store).
    const u = new URL(DB_URI);
    const mode = u.searchParams.get("sslmode");
    u.searchParams.delete("sslmode");
    const ssl = mode === "disable" ? false : mode && mode.startsWith("verify") ? { rejectUnauthorized: true } : mode ? { rejectUnauthorized: false } : undefined;
    pgPool = new pg.Pool({ connectionString: u.toString(), ssl, max: 1, idleTimeoutMillis: 30000, connectionTimeoutMillis: TIMEOUT, application_name: "howen-vss-mcp" });
    pgPool.on("error", () => {}); // idle client errors must not crash the stdio server
  }
  const { rows } = await pgPool.query(`
    SELECT s.name, s."serverUrl", a.username, a.password
      FROM "CameraServer" s
      JOIN "CameraAccess" a ON a.id = s."cameraAccessId"
     WHERE s."uniqueId" = 'howen' AND s.enabled AND COALESCE(a.enabled, true)
     ORDER BY s."createdAt"`);
  return rows;
}

const tokens = new Map(); // key -> {token, exp, pass}
let loadedAt = 0;
let loadError = null;
// (Re)build the cluster registry: database first (if configured), then env overrides/fallbacks.
export async function loadClusters(force = false, rowsLoader = queryDb) {
  if (!force && loadedAt && Date.now() - loadedAt < DB_REFRESH_MS) return;
  let fromDb = {};
  if (DB_URI || rowsLoader !== queryDb) {
    try { fromDb = clustersFromRows(await rowsLoader()); loadError = null; } catch (e) {
      loadError = `database: ${e.message}`;
      if (loadedAt) { loadedAt = Date.now() - DB_REFRESH_MS + 60000; return; } // keep last good list, retry in 1 min
    }
  }
  const next = { ...fromDb };
  for (const [k, e] of Object.entries(envClusters(PREFIX))) {
    if (!next[k] && !e.url) continue; // credentials without a URL and no database cluster to attach them to
    if (!next[k]) next[k] = { label: k, url: "", user: "", pass: "", source: "none" };
    if (e.url) next[k].url = e.url.replace(/\/+$/, "");
    if (e.user && e.password) Object.assign(next[k], { user: e.user, pass: e.password, source: "env" });
  }
  for (const k of Object.keys(CLUSTERS)) delete CLUSTERS[k];
  Object.assign(CLUSTERS, next);
  ORDER.splice(0, ORDER.length, ...Object.keys(next).sort());
  for (const [k, t] of tokens) { if (!next[k] || next[k].pass !== t.pass || next[k].user !== t.user) tokens.delete(k); }
  loadedAt = Date.now();
}
export const _state = { CLUSTERS, ORDER, get loadError() { return loadError; } };

function cfg(key) {
  const c = CLUSTERS[key];
  if (!c) throw new Error(`unknown cluster "${key}" (use: ${ORDER.join(", ")})`);
  return { key, label: c.label, url: c.url, user: c.user, pass: c.pass, source: c.source };
}
const configured = () => ORDER.filter((k) => { const c = cfg(k); return c.user && c.pass; });

async function post(url, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    }).catch((e) => {
      const host = new URL(url).host, code = e.cause?.code || e.name;
      if (code === "AbortError") throw new Error(`${host} did not answer within ${TIMEOUT} ms`);
      if (/CERT|SIGNATURE|SELF_SIGNED|TLS|SSL/i.test(code)) throw new Error(`${host} has an invalid TLS certificate (${code}) - fix the certificate chain on that server`);
      throw new Error(`cannot reach ${host} (${code}: ${e.cause?.message || e.message}) - check firewall/allowlist for this runtime`);
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: non-JSON response`); }
    return json;
  } finally { clearTimeout(t); }
}

async function token(key, force = false) {
  const hit = tokens.get(key);
  if (!force && hit && hit.exp > Date.now()) return hit.token;
  const c = cfg(key);
  if (!c.user || !c.pass) {
    throw new Error(`cluster ${key}: credentials not configured (${PREFIX}_${key.toUpperCase()}_USER / _PASSWORD or CameraAccess in the database)${loadError ? ` - ${loadError}` : ""}`);
  }
  const md5 = isMd5(c.pass) ? c.pass.toLowerCase() : md5hex(c.pass);
  const res = await post(`${c.url}/vss/user/apiLogin.action`, { username: c.user, password: md5 });
  if (String(res.status) !== "10000" || !res.data?.token) {
    throw new Error(`cluster ${key}: login failed (status ${res.status}${res.msg ? `, ${res.msg}` : ""})`);
  }
  tokens.set(key, { token: res.data.token, exp: Date.now() + TOKEN_TTL_MS, user: c.user, pass: c.pass });
  return res.data.token;
}

// Call an API path; retry once with a fresh token if the session looks expired.
async function api(key, path, body = {}) {
  const c = cfg(key);
  let res = await post(`${c.url}${path}`, { ...body, token: await token(key) });
  if (String(res.status) !== "10000" && /token|login|session/i.test(String(res.msg || ""))) {
    res = await post(`${c.url}${path}`, { ...body, token: await token(key, true) });
  }
  return res;
}
const ok = (res) => String(res.status) === "10000";
function check(key, res, what) {
  if (!ok(res)) throw new Error(`cluster ${key}: ${what} failed (status ${res.status}${res.msg ? `, ${res.msg}` : ""})`);
  return res;
}

async function findIn(key, keyword, pageCount = 10) {
  const res = await api(key, "/vss/vehicle/findAll.action", { keyword, pageNum: 1, pageCount });
  if (String(res.status) === "10025") return []; // VSS "No Data" = empty result, not an error
  check(key, res, "findAll");
  return res.data?.dataList || [];
}

// All fleets that have at least one vehicle (findAll keyword only matches device id/name, so list everything).
async function listFleets(key) {
  const res = await api(key, "/vss/vehicle/findAll.action", { keyword: "", pageNum: -1, pageCount: -1 });
  if (String(res.status) === "10025") return [];
  check(key, res, "findAll");
  const m = new Map();
  for (const d of res.data?.dataList || []) {
    if (!d.fleetid) continue;
    const e = m.get(d.fleetid) || { fleetname: d.fleetname, fleetid: d.fleetid, vehicles: 0 };
    e.vehicles++;
    m.set(d.fleetid, e);
  }
  return [...m.values()].sort((a, b) => String(a.fleetname).localeCompare(String(b.fleetname)));
}

// Locate which cluster holds a device. Exact deviceno match wins; otherwise freshest lastonlinetime.
async function locate(deviceID, cluster) {
  const keys = cluster ? [cluster] : configured();
  if (!keys.length) throw new Error("no cluster has credentials configured");
  const hits = [];
  const errors = [];
  await Promise.all(keys.map(async (k) => {
    try {
      for (const d of await findIn(k, deviceID)) {
        if (String(d.deviceno) === String(deviceID) || String(d.imei || "").endsWith(String(deviceID))) hits.push({ cluster: k, device: d });
      }
    } catch (e) { errors.push(e.message); }
  }));
  if (!hits.length) throw new Error(`device ${deviceID} not found in ${keys.join(", ")}${errors.length ? ` (errors: ${errors.join("; ")})` : ""}`);
  hits.sort((a, b) => String(b.device.lastonlinetime || "").localeCompare(String(a.device.lastonlinetime || "")));
  return hits[0];
}

// Alarm Record fields and endpoint verified against the deployed VSS web client.
// Only an explicit NO:<medium>; State:Lx_... alarm text supplies a storage level.
// Telemetry storage.status and unrelated numeric st fields are never classified.
export function storageAlarmText(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/NO:\s*((?:sd|hdd)\d+)\s*;\s*State:\s*(L[123])[_\s]+([^;]+)/i);
  if (!match) return null;
  const description = match[3].trim();
  const invalidBlock = match[2].toUpperCase() === "L3" && /^Disk invalid block(?::|$)/i.test(description);
  return { medium: match[1].toLowerCase(), level: match[2].toUpperCase(), description,
    ...(invalidBlock ? { st: 7 } : {}),
    recording_impact: "Not established by this alarm text; verify recorded files." };
}

function alarmRange(start, end) {
  const parse = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error("times must be YYYY-MM-DD HH:mm:ss (UTC+7)");
    const date = new Date(value.replace(" ", "T") + "Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19).replace("T", " ") !== value) throw new Error("invalid calendar time");
    return date.getTime();
  };
  const a = parse(start), b = parse(end);
  if (a > b || b - a > 31 * 86400000) throw new Error("start must be <= end and range must be at most 31 days");
}

const clusterProp = { type: "string", enum: ORDER, description: "VSS cluster. Omit to search all configured clusters." };
const devProp = { type: "string", description: "Howen device number (deviceno), e.g. 001234567890" };

const TOOLS = [
  {
    name: "vss_list_clusters",
    description: "List the Howen VSS clusters (from the CameraServer database table and/or env), their URLs, credential source and whether credentials are configured. Never returns credentials.",
    inputSchema: { type: "object", properties: { test_login: { type: "boolean", description: "Also try to log in to each configured cluster" }, reload: { type: "boolean", description: "Re-read the cluster list from the database now" } } },
    readOnly: true,
    async run({ test_login, reload }) {
      if (reload) await loadClusters(true);
      const out = [];
      for (const k of ORDER) {
        const c = cfg(k);
        const row = { cluster: k, name: c.label, url: c.url, credentials: !!(c.user && c.pass), source: c.source };
        if (test_login && row.credentials) {
          try { await token(k, true); row.login = "ok"; } catch (e) { row.login = e.message; }
        }
        out.push(row);
      }
      return { clusters: out, database: DB_URI ? (loadError || "ok") : "not configured", write_enabled: ALLOW_WRITE };
    },
  },
  {
    name: "vss_find_device",
    description: "Search devices by device number, IMEI, plate or name across clusters (Operation → Vehicle list, live). Returns cluster, deviceno, plate, IMEI, SIM, fleet, model, channels, last online/offline time.",
    inputSchema: {
      type: "object",
      properties: { keyword: { type: "string", description: "Device no / IMEI / plate / name" }, cluster: clusterProp, limit: { type: "integer", minimum: 1, maximum: 100, default: 10 } },
      required: ["keyword"],
    },
    readOnly: true,
    async run({ keyword, cluster, limit = 10 }) {
      const keys = cluster ? [cluster] : configured();
      if (!keys.length) throw new Error("no cluster has credentials configured");
      const results = [];
      const errors = [];
      await Promise.all(keys.map(async (k) => {
        try {
          for (const d of await findIn(k, keyword, limit)) {
            results.push({
              cluster: k, deviceno: d.deviceno, devicename: d.devicename, plateno: d.plateno, imei: d.imei, sim: d.sim,
              fleetname: d.fleetname, fleetid: d.fleetid, devicetype: d.devicetype, deviceModel: d.deviceModel,
              channelname: d.channelname, chassisno: d.chassisno, lastonlinetime: d.lastonlinetime, lastofflinetime: d.lastofflinetime,
            });
          }
        } catch (e) { errors.push(e.message); }
      }));
      return { count: results.length, results, errors };
    },
  },
  {
    name: "vss_list_fleets",
    description: "List fleets (name, fleetId, vehicle count) per cluster, optionally filtered by a name substring. Only fleets with at least one vehicle are visible.",
    inputSchema: { type: "object", properties: { cluster: clusterProp, name: { type: "string", description: "Case-insensitive substring of the fleet name" } } },
    readOnly: true,
    async run({ cluster, name }) {
      const keys = cluster ? [cluster] : configured();
      const out = [];
      const errors = [];
      await Promise.all(keys.map(async (k) => {
        try {
          for (const f of await listFleets(k)) {
            if (!name || String(f.fleetname).toLowerCase().includes(String(name).toLowerCase())) out.push({ cluster: k, ...f });
          }
        } catch (e) { errors.push(e.message); }
      }));
      return { count: out.length, fleets: out, errors };
    },
  },
  {
    name: "vss_device_status",
    description: "Latest telemetry of a device: report time, lat/lng, speed, heading, satellites, ACC, voltages, storage/4G state, plus online/offline derived with a 30-minute window. Finds the cluster automatically if omitted.",
    inputSchema: { type: "object", properties: { deviceID: devProp, cluster: clusterProp }, required: ["deviceID"] },
    readOnly: true,
    async run({ deviceID, cluster }) {
      const { cluster: k, device } = await locate(deviceID, cluster);
      const res = check(k, await api(k, "/vss/vehicle/getDeviceStatus.action", { deviceID: String(deviceID) }), "getDeviceStatus");
      const s = Array.isArray(res.data) ? res.data[0] : res.data;
      let state = s?.stateJson;
      if (typeof state === "string") { try { state = JSON.parse(state); } catch { /* keep raw */ } }
      const ts = s?.reportTime ? Date.parse(String(s.reportTime).replace(" ", "T") + "+07:00") : NaN;
      const ageMin = Number.isFinite(ts) ? Math.round((Date.now() - ts) / 60000) : null;
      return {
        cluster: k, cluster_name: CLUSTERS[k].label, deviceno: device.deviceno, plate: device.plateno || device.devicename,
        imei: device.imei, fleet: device.fleetname, model: device.deviceModel || device.devicetype,
        lastonlinetime: device.lastonlinetime, lastofflinetime: device.lastofflinetime,
        online_30min: ageMin !== null ? ageMin <= 30 : null, minutes_since_report: ageMin,
        status: s ? { ...s, stateJson: state } : null,
      };
    },
  },
  {
    name: "vss_get_device_setting",
    description: "Read device parameters (device must be online). Default segments: JTBASE (Basic Info: protocol1/protocol2 0=close 1=T 2=H, gpsinterval1/2, license), SERVER (center servers), VERSIONINFO.",
    inputSchema: {
      type: "object",
      properties: { deviceID: devProp, cluster: clusterProp, segments: { type: "array", items: { type: "string" }, description: "Parameter segments, default [JTBASE, SERVER, VERSIONINFO]" } },
      required: ["deviceID"],
    },
    readOnly: true,
    async run({ deviceID, cluster, segments }) {
      const k = cluster || (await locate(deviceID)).cluster;
      const settingPara = Object.fromEntries((segments?.length ? segments : ["JTBASE", "SERVER", "VERSIONINFO"]).map((s) => [s, ""]));
      const res = check(k, await api(k, "/vss/vehicle/getVehicleSetting.action", { deviceID: String(deviceID), settingPara, lang: "en" }), "getVehicleSetting");
      return { cluster: k, deviceID: String(deviceID), settings: res.data };
    },
  },
  {
    name: "vss_alarm_history",
    description: "Read Alarm Record history, including Storage abnormal text. Times are UTC+7. Returns one bounded page and total_count; follow next_page to complete a search. Storage L levels come only from explicit alarm text, never telemetry storage.status. Historical alarms do not prove a current fault. No alarm acknowledgement or device changes.",
    inputSchema: { type: "object", properties: {
      deviceID: devProp, cluster: clusterProp,
      start: { type: "string", description: "Start UTC+7, YYYY-MM-DD HH:mm:ss" },
      end: { type: "string", description: "End UTC+7, YYYY-MM-DD HH:mm:ss; maximum range 31 days" },
      alarm_types: { type: "string", description: "Optional comma-separated numeric VSS alarm types; omit for all types" },
      page: { type: "integer", minimum: 1, default: 1 },
      page_size: { type: "integer", minimum: 1, maximum: 100, default: 50 }
    }, required: ["deviceID", "start", "end"] },
    readOnly: true,
    async run({ deviceID, cluster, start, end, alarm_types = "", page = 1, page_size = 50 }) {
      if (typeof deviceID !== "string" || !/^\d+$/.test(deviceID)) throw new Error("deviceID must be one numeric device number");
      alarmRange(start, end);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(page_size) || page_size < 1 || page_size > 100) throw new Error("invalid pagination");
      if (typeof alarm_types !== "string" || (alarm_types && !/^\d+(,\d+)*$/.test(alarm_types))) throw new Error("alarm_types must be comma-separated numeric types");
      const { cluster: k, device } = await locate(deviceID, cluster);
      const res = await api(k, "/vss/alarm/findAllByTime.action", {
        deviceGuid: deviceID, deviceID, beginTime: start, endTime: end,
        keyword: "", alarmType: alarm_types, pageNum: page, pageCount: page_size, takeType: ""
      });
      if (String(res.status) !== "10025") check(k, res, "alarm/findAllByTime");
      const data = String(res.status) === "10025" ? { dataList: [], totalCount: 0 } : res.data;
      if (!Array.isArray(data?.dataList)) throw new Error("unexpected Alarm Record response: dataList missing");
      const alarms = data.dataList.map(row => ({
        id: row.guid, deviceID: row.deviceguid ?? deviceID, alarm_type: row.alarmtype,
        time: row.createtime, report_time: row.reportTime, end_time: row.endTime,
        alarm_state: row.alarmState, detail: row.alarmvalue, end_detail: row.endDetail,
        storage: storageAlarmText(row.alarmvalue)
      }));
      const total = Number(data.totalCount);
      const total_count = Number.isInteger(total) && total >= 0 ? total : null;
      const next_page = (total_count !== null ? page * page_size < total_count : alarms.length === page_size) ? page + 1 : null;
      return { cluster: k, deviceID, plate: device.plateno || device.devicename, start, end, timezone: "UTC+7",
        page, page_size, count: alarms.length, total_count, next_page, alarms,
        note: "Historical alarms only; no conclusion about current fault or recovery. All types searched when alarm_types is empty." };
    }
  },
  // ---------------- write tools (only listed when HOWEN_VSS_ALLOW_WRITE=1) ----------------
  {
    name: "vss_set_device_setting",
    description: "WRITE. Change fields in one parameter segment (e.g. JTBASE protocol1). Reads the current segment first, merges only the given fields, sends the whole segment back, then re-reads. Requires confirm=true. Device must be online.",
    inputSchema: {
      type: "object",
      properties: {
        deviceID: devProp, cluster: clusterProp,
        segment: { type: "string", description: "e.g. JTBASE or SERVER" },
        changes: { type: "object", description: 'Fields to change, e.g. {"protocol1":"2","gpsinterval1":"30"}' },
        confirm: { type: "boolean", description: "Must be true; only set after the user explicitly approved this exact change" },
      },
      required: ["deviceID", "segment", "changes", "confirm"],
    },
    async run({ deviceID, cluster, segment, changes, confirm }) {
      needConfirm(confirm);
      const k = cluster || (await locate(deviceID)).cluster;
      const read = async () => {
        const r = check(k, await api(k, "/vss/vehicle/getVehicleSetting.action", { deviceID: String(deviceID), settingPara: { [segment]: "" }, lang: "en" }), "getVehicleSetting");
        const seg = r.data?.[segment] ?? r.data?.settingPara?.[segment];
        if (!seg || typeof seg !== "object") throw new Error(`segment ${segment} not returned by device; aborting without writing`);
        return seg;
      };
      const before = await read();
      const merged = { ...before, ...Object.fromEntries(Object.entries(changes).map(([a, b]) => [a, String(b)])) };
      const res = check(k, await api(k, "/vss/vehicle/apiVehicleSetting.action", { deviceID: String(deviceID), settingPara: { [segment]: merged }, lang: "en" }), "apiVehicleSetting");
      let after = null;
      try { after = await read(); } catch (e) { after = `re-read failed: ${e.message}`; }
      return { cluster: k, deviceID: String(deviceID), segment, changed: diff(before, after && typeof after === "object" ? after : merged, Object.keys(changes)), response: res.data ?? null, after };
    },
  },
  {
    name: "vss_add_device",
    description: "WRITE. Add a device in Operation → Vehicle. fleetName is resolved to fleetId from existing vehicles in that cluster. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        cluster: { type: "string", enum: ORDER }, deviceID: devProp,
        deviceName: { type: "string", description: "Vehicle name / plate" },
        deviceType: { type: "string", description: "e.g. ME41-04 (copy devicetype from another vehicle in the cluster)" },
        fleetId: { type: "string" }, fleetName: { type: "string" },
        channelName: { type: "string", default: "CH1;CH2;CH3;CH4" }, chassisNo: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["cluster", "deviceID", "deviceName", "deviceType", "confirm"],
    },
    async run(a) {
      needConfirm(a.confirm);
      let fleetId = a.fleetId;
      if (!fleetId && a.fleetName) {
        const f = (await listFleets(a.cluster)).find((d) => d.fleetname === a.fleetName);
        if (!f) throw new Error(`fleet "${a.fleetName}" not found in ${a.cluster}; pass fleetId`);
        fleetId = f.fleetid;
      }
      const body = { deviceID: String(a.deviceID), deviceName: a.deviceName, deviceType: a.deviceType, channelName: a.channelName || "CH1;CH2;CH3;CH4", nodeGuid: "0" };
      if (fleetId) body.fleetId = fleetId;
      if (a.chassisNo) body.chassisNo = a.chassisNo;
      const res = check(a.cluster, await api(a.cluster, "/vss/vehicle/apiAddDevice.action", body), "apiAddDevice");
      const after = (await findIn(a.cluster, String(a.deviceID))).find((d) => String(d.deviceno) === String(a.deviceID)) || null;
      return { cluster: a.cluster, request: body, response: res.data ?? null, after };
    },
  },
  {
    name: "vss_modify_device",
    description: "WRITE. Edit a vehicle in Operation → Vehicle (name/plate, type, channels, chassis). Unspecified fields keep their current values. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        deviceID: devProp, cluster: clusterProp,
        deviceName: { type: "string" }, deviceType: { type: "string" }, channelName: { type: "string" }, chassisNo: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["deviceID", "confirm"],
    },
    async run(a) {
      needConfirm(a.confirm);
      const { cluster: k, device: d } = await locate(a.deviceID, a.cluster);
      const before = { deviceName: d.devicename, deviceType: d.devicetype, channelName: d.channelname, chassisNo: d.chassisno };
      const body = { deviceID: String(a.deviceID) };
      for (const f of ["deviceName", "deviceType", "channelName", "chassisNo"]) {
        const v = a[f] ?? before[f];
        if (v !== undefined && v !== null) body[f] = v;
      }
      const res = check(k, await api(k, "/vss/vehicle/apiModifyDevice.action", body), "apiModifyDevice");
      const n = (await findIn(k, String(a.deviceID))).find((x) => String(x.deviceno) === String(a.deviceID));
      const after = n ? { deviceName: n.devicename, deviceType: n.devicetype, channelName: n.channelname, chassisNo: n.chassisno } : null;
      return { cluster: k, deviceID: String(a.deviceID), before, after, response: res.data ?? null };
    },
  },
  {
    name: "vss_remove_device",
    description: "WRITE, DESTRUCTIVE. Delete a device from Operation → Vehicle. Requires confirm=true and the cluster.",
    inputSchema: { type: "object", properties: { deviceID: devProp, cluster: { type: "string", enum: ORDER }, confirm: { type: "boolean" } }, required: ["deviceID", "cluster", "confirm"] },
    async run({ deviceID, cluster, confirm }) {
      needConfirm(confirm);
      const before = (await findIn(cluster, String(deviceID))).find((d) => String(d.deviceno) === String(deviceID));
      if (!before) throw new Error(`device ${deviceID} not found in ${cluster}`);
      const res = check(cluster, await api(cluster, "/vss/vehicle/apiRemoveDevice.action", { deviceID: String(deviceID) }), "apiRemoveDevice");
      return { cluster, deviceID: String(deviceID), removed: { plate: before.plateno || before.devicename, fleet: before.fleetname }, response: res.data ?? null };
    },
  },
];

function needConfirm(c) {
  if (c !== true) throw new Error("write refused: confirm must be true, and only after the user explicitly approved this exact change");
}
function diff(before, after, keys) {
  return keys.map((k) => ({ field: k, before: before?.[k], after: after?.[k] }));
}
const visibleTools = () => TOOLS.filter((t) => t.readOnly || ALLOW_WRITE);

// ---------------- MCP JSON-RPC over stdio ----------------
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

export async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications
  if (method === "tools/list" || method === "tools/call") await loadClusters();
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "howen-vss", version: VERSION },
        instructions: "Howen VSS (MDVR) tools. Clusters come from the CameraServer/CameraAccess database tables and/or env; call vss_list_clusters to see them. Read tools are safe. Write tools exist only when enabled and need confirm=true after the user explicitly approves the exact change; always show before/after. Never print credentials.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: visibleTools().map(({ name, description, inputSchema, readOnly }) => ({
          name, description, inputSchema,
          annotations: { readOnlyHint: !!readOnly, destructiveHint: name === "vss_remove_device", openWorldHint: true },
        })),
      });
    case "tools/call": {
      const tool = visibleTools().find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const out = await tool.run(params.arguments || {});
        return reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

if (process.env.HOWEN_VSS_NO_STDIO !== "1") {
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, "parse error"); }
  handle(msg).catch((e) => fail(msg.id ?? null, -32603, e.message));
});
}
