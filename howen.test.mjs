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

test("storage classification requires explicit alarm text, not telemetry status", () => {
  assert.equal(m.storageAlarmText({ name: 'sd1', status: '1' }), null);
  assert.equal(m.storageAlarmText('satellites:22; st:7'), null);
  assert.deepEqual(m.storageAlarmText('NO:sd1 ; State:L3_Disk invalid block: Judge the video partition ; satellites:22'), {
    medium: 'sd1', level: 'L3', description: 'Disk invalid block: Judge the video partition', st: 7,
    recording_impact: 'Not established by this alarm text; verify recorded files.'
  });
});

test("alarm history sends the web-client query, paginates, handles no data and errors", async () => {
  let mode = 'data'; const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const b = JSON.parse(body); seen.push({path:req.url, body:b});
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('apiLogin.action')) return res.end(JSON.stringify({status:10000,data:{token:'alarm-test-token'}}));
      if (req.url.endsWith('findAll.action')) return res.end(JSON.stringify({status:10000,data:{dataList:[{deviceno:'847053273528',imei:'865847053273528',devicename:'test plate'}]}}));
      if (mode === 'empty') return res.end(JSON.stringify({status:10025,msg:'No Data'}));
      if (mode === 'error') return res.end(JSON.stringify({status:10129,msg:'Requests too frequent'}));
      res.end(JSON.stringify({status:10000,data:{totalCount:2,dataList:[{guid:'a1',deviceguid:'847053273528',alarmtype:99,createtime:'2026-11-17 09:00:00',alarmvalue:'NO:sd1 ; State:L3_Disk invalid block: Judge the video partition ; satellites:22',drivername:'private driver',takeupuser:'private operator'}]}}));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  await m.loadClusters(true, async () => [{name:'Test',serverUrl:`http://127.0.0.1:${srv.address().port}`,username:'tester',password:'secret'}]);
  const out = [], orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s,...a) => { if (String(s).startsWith('{"jsonrpc"')) {out.push(JSON.parse(s));return true;} return orig(s,...a); };
  const args = {deviceID:'847053273528',cluster:'127',start:'2026-11-17 00:00:00',end:'2026-11-17 23:59:59',page_size:1};
  const call = async (arguments_ = args) => {
    await m.handle({id:40,method:'tools/call',params:{name:'vss_alarm_history',arguments:arguments_}});
    return out.at(-1).result;
  };
  try {
    await m.handle({id:39,method:'tools/list'});
    assert.equal(out.at(-1).result.tools.find(t=>t.name==='vss_alarm_history').annotations.readOnlyHint,true);
    let r = await call(), data = JSON.parse(r.content[0].text);
    assert.equal(data.next_page,2); assert.equal(data.total_count,2);
    assert.equal(data.alarms[0].storage.level,'L3');
    assert.ok(!JSON.stringify(data).includes('private'));
    const request = seen.find(x=>x.path.endsWith('/alarm/findAllByTime.action'));
    assert.equal(request.body.deviceGuid,args.deviceID); assert.equal(request.body.deviceID,args.deviceID);
    assert.equal(request.body.beginTime,args.start); assert.equal(request.body.alarmType,'');
    r = await call({...args, deviceID:'865847053273528'}); data = JSON.parse(r.content[0].text);
    assert.equal(data.deviceID,'847053273528');
    const imeiReq = seen.filter(x=>x.path.endsWith('/alarm/findAllByTime.action')).at(-1);
    assert.equal(imeiReq.body.deviceGuid,'847053273528'); assert.equal(imeiReq.body.deviceID,'847053273528');
    mode='empty'; data=JSON.parse((await call()).content[0].text);
    assert.equal(data.count,0); assert.equal(data.next_page,null);
    mode='error'; assert.equal((await call()).isError,true);
    const count = seen.length;
    for (const change of [{start:'2026-02-30 00:00:00'},{page:0},{page_size:101},{end:'2026-11-16 00:00:00'},{alarm_types:'1;delete'},{deviceID:''}]) assert.equal((await call({...args,...change})).isError,true);
    assert.equal(seen.length,count,'invalid inputs must not reach the server');
  } finally {process.stdout.write=orig; await new Promise(r=>srv.close(r));}
});

test("evidence helpers: alarm types, envelopes, field mapping", () => {
  assert.deepEqual(m.evidenceAlarmTypes(undefined), []);
  assert.deepEqual(m.evidenceAlarmTypes([61, "62"]), [61, 62]);
  assert.deepEqual(m.evidenceAlarmTypes("61, 62"), [61, 62]);
  assert.throws(() => m.evidenceAlarmTypes(["1;drop"]));
  assert.throws(() => m.evidenceAlarmTypes([-1]));
  assert.deepEqual(m.evidenceRows([{ a: 1 }]), { rows: [{ a: 1 }], total_count: null });
  assert.deepEqual(m.evidenceRows({ dataList: [], totalCount: "3" }), { rows: [], total_count: 3 });
  assert.deepEqual(m.evidenceRows({ dataList: [] }), { rows: [], total_count: null });
  assert.throws(() => m.evidenceRows({ list: [] }), /unexpected Evidence response/);
  assert.throws(() => m.evidenceRows(null), /unexpected Evidence response/);
  const f = m.evidenceFile({ alarmGuid: "A1", guid: "G1", deviceID: "1", fileType: 2, channel: 3, fileStartTime: "s", fileStopTime: "e", downUrl: "https://x/v.mp4" });
  assert.equal(f.file_type_name, "alarm video"); assert.equal(f.down_url, "https://x/v.mp4"); assert.equal(f.alarm_guid, "A1");
  assert.equal(m.evidenceFile({ downUrl: "" }).down_url, null);
});

test("evidence files sends the 3.24 query, paginates, handles no data, errors and bad envelopes", async () => {
  let mode = "data"; const seen = [];
  const file = { deviceID: "430062045923", alarmType: 61, alarmGuid: "17949839000310320000430062045923", fileType: 2, channel: 1,
    filePath: "/evidence/a.mp4", fileStartTime: "2026-11-18 06:38:10", fileStopTime: "2026-11-18 06:38:30", downUrl: "https://vss.example/down/a.mp4", guid: "g1" };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", d => body += d); req.on("end", () => {
      const b = JSON.parse(body); seen.push({ path: req.url, body: b });
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("apiLogin.action")) return res.end(JSON.stringify({ status: 10000, data: { token: "ev-token" } }));
      if (req.url.endsWith("findAll.action")) return res.end(JSON.stringify({ status: 10000, data: { dataList: [{ deviceno: "430062045923", imei: "86430062045923", plateno: "72-0382" }] } }));
      if (mode === "empty") return res.end(JSON.stringify({ status: 10025, msg: "No Data" }));
      if (mode === "error") return res.end(JSON.stringify({ status: 10129, msg: "Requests too frequent" }));
      if (mode === "weird") return res.end(JSON.stringify({ status: 10000, data: { rows: [file] } }));
      if (mode === "array") return res.end(JSON.stringify({ status: 10000, data: [file] }));
      res.end(JSON.stringify({ status: 10000, data: { totalCount: 2, dataList: [file] } }));
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  await m.loadClusters(true, async () => [{ name: "Test", serverUrl: `http://127.0.0.1:${srv.address().port}`, username: "tester", password: "secret" }]);
  const out = [], orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...a) => { if (String(s).startsWith('{"jsonrpc"')) { out.push(JSON.parse(s)); return true; } return orig(s, ...a); };
  const args = { deviceID: "430062045923", cluster: "127", start: "2026-11-18 06:37:00", end: "2026-11-18 06:40:00", alarm_types: [61], page: 1, page_size: 1 };
  const call = async (a = args) => { await m.handle({ id: 50, method: "tools/call", params: { name: "vss_evidence_files", arguments: a } }); return out.at(-1).result; };
  try {
    await m.handle({ id: 49, method: "tools/list" });
    const t = out.at(-1).result.tools.find(x => x.name === "vss_evidence_files");
    assert.ok(t, "tool listed without write mode"); assert.equal(t.annotations.readOnlyHint, true);
    let data = JSON.parse((await call()).content[0].text);
    assert.equal(data.count, 1); assert.equal(data.total_count, 2); assert.equal(data.next_page, 2);
    assert.equal(data.files[0].alarm_guid, file.alarmGuid); assert.equal(data.files[0].down_url, file.downUrl);
    assert.equal(data.plate, "72-0382");
    const { token: _t, ...q } = seen.filter(x => x.path.endsWith("/vss/record/findRecords.action")).at(-1).body;
    assert.ok(_t, "token sent");
    assert.deepEqual(q, { pageNum: 1, pageSize: 1, beginTime: args.start, endTime: args.end, deviceIdList: ["430062045923"], alarmTypeList: [61] });
    data = JSON.parse((await call({ ...args, alarm_types: undefined, page_size: 50 })).content[0].text);
    assert.equal(data.next_page, null);
    assert.ok(!("alarmTypeList" in seen.filter(x => x.path.endsWith("/findRecords.action")).at(-1).body));
    mode = "array"; data = JSON.parse((await call()).content[0].text);
    assert.equal(data.total_count, null); assert.equal(data.next_page, 2, "full page without total -> try next page");
    mode = "empty"; data = JSON.parse((await call()).content[0].text);
    assert.equal(data.count, 0); assert.equal(data.next_page, null);
    mode = "error"; assert.equal((await call()).isError, true);
    mode = "weird"; const w = await call(); assert.equal(w.isError, true); assert.match(w.content[0].text, /unexpected Evidence response/);
    const count = seen.length;
    for (const change of [{ start: "2026-02-30 00:00:00" }, { page: 0 }, { page_size: 101 }, { end: "2026-11-17 00:00:00" }, { alarm_types: ["61;x"] }, { deviceID: "" }, { deviceID: "1,2" }])
      assert.equal((await call({ ...args, ...change })).isError, true, JSON.stringify(change));
    assert.equal(seen.length, count, "invalid inputs must not reach the server");
  } finally { process.stdout.write = orig; await new Promise(r => srv.close(r)); }
});
