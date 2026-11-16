// Meitrack MS03 MCP tests (no network: local fake MS03 server and in-memory rows)
process.env.MEITRACK_MS03_NO_STDIO = "1";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const m = await import("./meitrack-ms03-mcp.mjs");

test("clustersFromRows keys by alias or host and dedupes servers shared by several products", () => {
  const c = m.clustersFromRows([
    { name: "Product D", serverUrl: "https://d.ms03.example.com", username: "user1", password: "p1" },
    { name: "Partner", serverUrl: "https://partner.example.net", username: "user1", password: "p2" },
    { name: "Product B", serverUrl: "https://b.ms03.example.com/", username: "user1", password: "p2" },
    { name: "Product D long retention", serverUrl: "https://d.ms03.example.com", username: "user1", password: "p1" },
  ], m.parseAliases("cloud=partner.example.net"));
  assert.deepEqual(Object.keys(c).sort(), ["b", "cloud", "d"]);
  assert.equal(c.b.url, "https://b.ms03.example.com");
  assert.equal(c.d.label, "Product D");
});

test("time helpers convert Bangkok local to GMT and YYMMDDHHMMSS", () => {
  const d = m.parseLocal("2026-11-16 08:30:00");
  assert.equal(m.gmt(d), "2026-11-16 01:30:00");
  assert.equal(m.compactLocal(d), "261116083000");
  assert.throws(() => m.parseLocal("16/11/2026"));
});

test("login with plain DB password, token reuse and refresh, find + status", async () => {
  const calls = [];
  let tokenN = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams) });
    res.setHeader("content-type", "application/json");
    const p = u.pathname.replace("/openapi/api/", "");
    if (p === "Login") return res.end(JSON.stringify(u.searchParams.get("password") === "pw" ? { state: true, value: `TOK${++tokenN}` } : { state: false, message: "wrong" }));
    if (u.searchParams.get("Token") === "TOK1" && p === "Tracker/GetTrackerConnectStatus") return res.end(JSON.stringify({ state: false, message: "This token has exceeded the use of the number of times" }));
    if (p === "Tracker") return res.end(JSON.stringify({ state: true, value: [{ sn_imei_id: "860000000000001", tracker_name: "TRUCK-01", tracker_sim_number: "0000000000" }] }));
    if (p === "Tracker/GetTrackerConnectStatus") return res.end(JSON.stringify({ state: true, value: [{ imei: "860000000000001", onlineMode: 1, lastReceivedTime: "2026-11-16 08:00:00" }] }));
    if (p === "HistoryLocation") return res.end(JSON.stringify({ state: true, value: [{ gps_info: { latitude: 13.7 } }, { gps_info: { latitude: 13.8 } }] }));
    res.end(JSON.stringify({ state: false, message: "?" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  await m.loadClusters(true, async () => [{ name: "Fake", serverUrl: base, username: "user1", password: "pw" }]);
  assert.equal(m._state.CLUSTERS["127"].source, "database");

  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...a) => { if (String(s).startsWith('{"jsonrpc"')) { out.push(JSON.parse(s)); return true; } return orig(s, ...a); };
  const call = async (name, args) => { await m.handle({ jsonrpc: "2.0", id: out.length + 1, method: "tools/call", params: { name, arguments: args } }); const r = out.at(-1).result; return r.isError ? r.content[0].text : JSON.parse(r.content[0].text); };
  try {
    const f = await call("ms03_find_device", { keyword: "truck-0", cluster: "127" });
    assert.equal(f.count, 1);
    assert.equal(f.results[0].imei, "860000000000001");
    const s = await call("ms03_device_status", { imei: "860000000000001", cluster: "127" });
    assert.equal(s.online, true);
    assert.equal(s.online_mode, "online (GSM)");
    assert.equal(s.last_location.gps_info.latitude, 13.8);
    const l = await call("ms03_list_clusters", {});
    assert.ok(!JSON.stringify(l).includes('"pw"'), "credentials must not leak");
  } finally { process.stdout.write = orig; srv.close(); }
  const logins = calls.filter((c) => c.path.endsWith("/Login"));
  assert.equal(logins.length, 2, "one login, one refresh after token quota error");
  assert.equal(logins[0].q.password, "pw", "plain password sent as-is");
});

test("lastLocation pages through 100-row pages and widens the window when empty", async () => {
  const calls = [];
  const fetchPage = async (p) => {
    calls.push(p);
    const h = (Date.parse(p.EndGMT.replace(" ", "T") + "Z") - Date.parse(p.BeginGMT.replace(" ", "T") + "Z")) / 3600000;
    if (h < 2) return { state: true, value: [] }; // nothing in the last hour
    const total = 230, rows = [];
    for (let i = p.StartIdx; i < Math.min(total, p.StartIdx + p.Limit); i++) rows.push({ i, gps_info: { l_datetime: "2026-11-16T01:30:00" } });
    return { state: true, value: rows };
  };
  const last = await m.lastLocation("x", "1", 24, fetchPage);
  assert.equal(last.i, 229);
  assert.equal(last.time_local, "2026-11-16 08:30:00");
  assert.ok(calls.every((c) => c.Limit <= 100));
  assert.equal(calls.length, 1 + 3);
});

test("netError tells timeouts and certificate problems apart from firewall issues", () => {
  assert.match(m.netError("h", { name: "AbortError" }).message, /did not answer/);
  assert.match(m.netError("h", { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }).message, /invalid TLS certificate/);
  assert.match(m.netError("h", { cause: { code: "ECONNREFUSED" } }).message, /firewall/);
});

test("fileResult summarizes per channel and returns the newest files up to limit", () => {
  const files = [];
  for (let i = 0; i < 120; i++) for (const ch of [3, 4]) files.push({ ch, begin_local: `2026-11-16 08:${String(i % 60).padStart(2, "0")}:00`.replace("08:", i < 60 ? "08:" : "09:"), end_local: "x" });
  const r = m.fileResult("b", "1", "ftp", files, 10);
  assert.equal(r.count, 240);
  assert.equal(r.returned, 10);
  assert.deepEqual(r.channels.map((c) => [c.channel, c.files]), [[3, 120], [4, 120]]);
  assert.equal(r.files[0].begin_local, "2026-11-16 09:59:00");
  assert.equal(m.fromCompact("261116095953"), "2026-11-16 09:59:53");
});
