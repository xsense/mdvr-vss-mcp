// node --test test.mjs  (no network: uses a local fake VSS server and in-memory rows)
process.env.HOWEN_VSS_NO_STDIO = "1";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

const m = await import("./howen-vss-mcp.mjs");
const md5 = (s) => createHash("md5").update(s).digest("hex");

test("normUrl drops :9965 unless asked to keep it", () => {
  assert.equal(m.normUrl("https://vss.example.com:9965", false), "https://vss.example.com");
  assert.equal(m.normUrl("https://vss.example.com:9965/", true), "https://vss.example.com:9965");
});

test("clustersFromRows keys by alias or first host label and dedupes hosts", () => {
  const aliases = m.parseAliases("main=vss.example.com, ha=ha.vss.example.org");
  const c = m.clustersFromRows([
    { name: "Main", serverUrl: "https://vss.example.com:9965", username: "user1", password: md5("x") },
    { name: "HA", serverUrl: "https://ha.vss.example.org:9965", username: "user2", password: md5("y") },
    { name: "Test", serverUrl: "https://t1.vss.example.com:9965", username: "user1", password: md5("x") },
    { name: "dup", serverUrl: "https://vss.example.com", username: "other", password: "z" },
    { name: "no creds", serverUrl: "https://nope.example.com", username: null, password: null },
  ], false, aliases);
  assert.deepEqual(Object.keys(c), ["main", "ha", "t1"]);
  assert.equal(c.main.user, "user1");
  assert.equal(c.ha.label, "HA");
  assert.equal(c.t1.url, "https://t1.vss.example.com");
});

test("envClusters reads PREFIX_<KEY>_URL/_USER/_PASSWORD and ignores other variables", () => {
  const e = m.envClusters("HOWEN_VSS", { HOWEN_VSS_MAIN_URL: "https://a.example", HOWEN_VSS_MAIN_USER: "u", HOWEN_VSS_MAIN_PASSWORD: "p", HOWEN_VSS_DB_URI: "x", HOWEN_VSS_TIMEOUT_MS: "1" });
  assert.deepEqual(e, { main: { url: "https://a.example", user: "u", password: "p" } });
});

test("login uses DB credentials; MD5 passwords are sent as-is, plain ones are hashed", async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const j = JSON.parse(b); seen.push({ path: req.url, body: j });
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("apiLogin.action")) return res.end(JSON.stringify({ status: 10000, data: { token: "T-" + j.username } }));
      res.end(JSON.stringify({ status: 10025, msg: "No Data" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const rows = [
    { name: "Hashed", serverUrl: `${base}/a`, username: "u1", password: md5("secret") },
    { name: "Plain", serverUrl: `http://localhost:${srv.address().port}/b`, username: "u2", password: "secret" },
  ];
  await m.loadClusters(true, async () => rows);
  const { ORDER, CLUSTERS } = m._state;
  assert.ok(ORDER.includes("127") && ORDER.includes("localhost"), ORDER.join(","));
  assert.equal(CLUSTERS["127"].source, "database");
  const { handle } = m;
  const out = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...a) => { if (String(s).startsWith("{\"jsonrpc\"")) { out.push(JSON.parse(s)); return true; } return origWrite(s, ...a); };
  try {
    await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vss_list_clusters", arguments: { test_login: true } } });
  } finally { process.stdout.write = origWrite; srv.close(); }
  const r = JSON.parse(out[0].result.content[0].text);
  const byKey = Object.fromEntries(r.clusters.map((c) => [c.cluster, c]));
  assert.equal(byKey["127"].login, "ok");
  assert.equal(byKey["localhost"].login, "ok");
  assert.ok(!JSON.stringify(r).includes(md5("secret")), "credentials must not leak");
  const logins = seen.filter((s) => s.path.endsWith("apiLogin.action"));
  assert.deepEqual(logins.map((l) => l.body.password), [md5("secret"), md5("secret")]);
});
