# mdvr-vss-mcp

Two MCP servers (stdio, Node >= 18) for MDVR video platforms:

| Bin | Platform |
|---|---|
| `howen-vss-mcp` | Howen VSS Web API V2.8.0 |
| `meitrack-ms03-mcp` | Meitrack MS03 Web API (`/openapi/api/*`, MD500 / MD500S) |

No server address, username or password is built in. Servers and credentials come from a PostgreSQL database
and/or environment variables. No tool ever returns a credential.

## Run

The package has two bins, so name the one to run with `-p <package> <bin>`.

```
npx -y -p github:xsense/mdvr-vss-mcp howen-vss-mcp
npx -y -p github:xsense/mdvr-vss-mcp meitrack-ms03-mcp
```

Example MCP config:

```json
{
  "mcpServers": {
    "howen-vss-mcp": {
      "command": "npx",
      "args": ["-y", "-p", "github:xsense/mdvr-vss-mcp", "howen-vss-mcp"],
      "env": { "HOWEN_VSS_DB_URI": "postgresql://reader:***@db.example.com:5432/app?sslmode=require" }
    },
    "meitrack-ms03-mcp": {
      "command": "npx",
      "args": ["-y", "-p", "github:xsense/mdvr-vss-mcp", "meitrack-ms03-mcp"],
      "env": { "MEITRACK_MS03_DB_URI": "postgresql://reader:***@db.example.com:5432/app?sslmode=require" }
    }
  }
}
```

## Where servers come from

### 1. Database (optional)

If a database URI is set, the server reads these two tables with a read-only query and reads them again every 10 minutes:

```sql
SELECT s.name, s."serverUrl", a.username, a.password
  FROM "CameraServer" s
  JOIN "CameraAccess" a ON a.id = s."cameraAccessId"
 WHERE s."uniqueId" = 'howen'      -- 'meitrack' for meitrack-ms03-mcp
   AND s.enabled AND COALESCE(a.enabled, true)
```

- Each host becomes one cluster, so a host listed more than once appears once.
- The cluster key is the first label of the host name. For example, `b.ms03.example.com` becomes `b`.
- To choose your own keys, set `*_ALIASES` to a list such as `main=vss.example.com,ha=ha.example.org`.
- `sslmode=require` encrypts the connection without verifying the certificate (libpq behavior), and `verify-full` verifies it.
- If the database can't be reached, the last good list is kept and the server tries again after a minute.

### 2. Environment (optional)

`<PREFIX>_<KEY>_URL`, `<PREFIX>_<KEY>_USER` and `<PREFIX>_<KEY>_PASSWORD` define a cluster named `<key>`. Setting only
`_USER` and `_PASSWORD` overrides the credentials of the database cluster with that key. The prefix is `HOWEN_VSS` or `MEITRACK_MS03`.

```
HOWEN_VSS_MAIN_URL=https://vss.example.com
HOWEN_VSS_MAIN_USER=api-user
HOWEN_VSS_MAIN_PASSWORD=...
```

## howen-vss-mcp

| Variable | Meaning |
|---|---|
| `HOWEN_VSS_DB_URI` (or `PLUS_DATABASE_URI`) | database URI |
| `HOWEN_VSS_ALIASES` | `key=host,...` cluster keys |
| `HOWEN_VSS_<KEY>_URL` / `_USER` / `_PASSWORD` | cluster in env |
| `HOWEN_VSS_DB_REFRESH_MS` | reload interval, default 600000 |
| `HOWEN_VSS_KEEP_PORT` | `1` keeps `:9965` from the database URL. By default it is dropped and HTTPS 443 is used. |
| `HOWEN_VSS_ALLOW_WRITE` | `1` exposes write tools |
| `HOWEN_VSS_TIMEOUT_MS` | request timeout, default 20000 |

VSS login expects an MD5 hex password. A password that is already 32 hex characters is sent as-is; any other password is hashed first.

Read tools:
- `vss_list_clusters`: lists clusters. `test_login` tries to log in to each one, and `reload` re-reads the database.
- `vss_list_fleets`
- `vss_find_device`
- `vss_device_status`
- `vss_alarm_history`: bounded Alarm Record history, with explicit storage alarm levels when present.
- `vss_get_device_setting`

Write tools (only when `HOWEN_VSS_ALLOW_WRITE=1`, each call needs `confirm=true`):
- `vss_set_device_setting`
- `vss_add_device`
- `vss_modify_device`
- `vss_remove_device`

Write tools read the current values first, change only the requested fields, and return before/after.

## meitrack-ms03-mcp

| Variable | Meaning |
|---|---|
| `MEITRACK_MS03_DB_URI` (or `HOWEN_VSS_DB_URI` / `PLUS_DATABASE_URI`) | database URI |
| `MEITRACK_MS03_ALIASES` | `key=host,...` cluster keys |
| `MEITRACK_MS03_<KEY>_URL` / `_USER` / `_PASSWORD` | cluster in env |
| `MEITRACK_MS03_DB_REFRESH_MS` | reload interval, default 600000 |
| `MEITRACK_MS03_TZ_MINUTES` | local time zone offset for tool inputs and outputs, default 420 (UTC+7) |
| `MEITRACK_MS03_TIMEOUT_MS` | request timeout, default 20000 |
| `MEITRACK_MS03_SD_TIMEOUT_MS` | timeout for SD card and FTP file lists, default 90000 |
| `MEITRACK_MS03_SCAN_TIMEOUT_MS` | per-request timeout of `ms03_storage_alarm_scan`, default 60000 |
| `MEITRACK_MS03_ALLOW_WRITE` | `1` exposes `ms03_add_device` |

Times passed to and returned by the tools are local, `YYYY-MM-DD HH:mm:ss`. The API itself uses GMT, and responses gain `time_local` / `gps_time_local` fields.

Read tools:
- `ms03_list_clusters`
- `ms03_find_device`: searches by IMEI, name, SIM or firmware.
- `ms03_device_status`: returns online mode and last received time, plus the latest GPS point.
- `ms03_alarm_history`: alarm history, optionally filtered by alarm codes.
- `ms03_storage_alarm_scan`: scans every device of one or all clusters for storage alarms (default `608,609,190`) in one call. See below.
- `ms03_video_files`: lists files on the device SD card or on FTP (with MP4 URLs). It returns a summary for each channel, then the newest `limit` files (default 50).

Write tool (only when `MEITRACK_MS03_ALLOW_WRITE=1`, needs `confirm=true`):
- `ms03_add_device`: refuses if the IMEI already exists on any cluster.

If the server says a token is expired or has used up its quota, the MCP logs in again once.

## Test

```
npm install && npm test
```

Tests use local fake servers only.

## Howen Alarm Record history

Call `vss_alarm_history` with one device number and a local UTC+7 time range:

```json
{"deviceID":"847053273528","cluster":"main","start":"2026-11-17 00:00:00","end":"2026-11-17 23:59:59","page_size":50,"page":1}
```

The range is limited to 31 days and a page to 100 rows. Follow `next_page` until null
before describing a result as complete. Leave `alarm_types` empty for all types;
when known, pass comma-separated numeric VSS alarm codes. No storage alarm code is assumed.

The implementation follows the deployed VSS web client's Alarm Record query:
`POST /vss/alarm/findAllByTime.action`, with `deviceGuid`, `deviceID`,
`beginTime`, `endTime`, `alarmType`, `pageNum`, and `pageCount`.
Source inspected on 2026-11-17:
[API wrapper](https://howen.xsense.co.th/vss/assets/js/api-alarm-record.BpawIo2W.js),
[Alarm Record UI](https://howen.xsense.co.th/vss/assets/js/alarm-record.g7G_oSuj.js).

Results retain `alarmvalue` as `detail` and return explicit storage levels only for text
of the form `NO:sd1 ; State:L3_Disk invalid block: ...`. That known description is
mapped to `st=7` using the user-provided Storage abnormal table (2026-11-17; no source URL).
Other descriptions retain their text and level without guessing a numeric status.
Telemetry `storage.status` is not classified as an alarm code. L1/L2/L3 do not by
themselves establish recording loss; check recorded files separately. Historical alarms
also do not establish whether a fault is still active or has recovered.
Driver and operator identity fields are excluded from the selected output fields.

This tool only reads history; it does not acknowledge alarms, format cards or alter devices.
Local tests use a fake server. A deployment must additionally verify the response shape
and an actual alarm on the target VSS version before claiming live verification.

## Meitrack fleet storage alarm scan

`ms03_storage_alarm_scan` reads the device list of each cluster (`Tracker`, cached 5 minutes), splits the IMEIs
into batches and calls `HistoryAlarm` with comma-separated `Imeis`, paging with `StartIdx`/`Limit` (1000) until a page is short.

```json
{"start":"2026-11-10 00:00:00","end":"2026-11-17 00:00:00","alarm_types":"608,609,190"}
```

- `cluster` limits the scan to one cluster; omit it to scan all of them in parallel.
- `batch_size` (default 50, max 100). The MS03 server answers HTTP 404 when the URL is longer than about 2 KB
  (150 IMEIs failed and 100 passed on 2026-11-17), so a batch is also capped at 1700 characters of IMEIs.
- Each request is retried 3 times. Expired tokens and used-up token quotas trigger a new login.
  A batch that still fails is listed in `failed_batches` with its IMEIs and the error, and `summary.complete` is `false`.
- The range is limited to 31 days.
- The output has one row per device with alarms: `cluster`, `imei`, `tracker_name`, `total`, `counts` per code,
  `first_local`/`last_local` (local time) and `last_location`. It also includes `summary` and `per_cluster`
  (devices scanned / with alarms / failed, batches, requests, events, seconds). Raw events are never returned.
  Devices are sorted by alarm count and capped by `max_devices` (default 3000); the totals always cover every device.

Live test on 2026-11-17 (4 clusters, 2026-11-10 00:00 to 2026-11-17 00:00, codes 608,609,190):

| Cluster | Devices | Batches | Requests | With alarms | Events | Seconds |
|---|---|---|---|---|---|---|
| b | 561 | 12 | 17 | 18 | 5958 | 1.2 |
| c | 403 | 9 | 9 | 8 | 998 | 0.9 |
| camtruck | 483 | 10 | 10 | 24 | 731 | 2.0 |
| d | 942 | 19 | 20 | 52 | 1459 | 3.2 |
| **all** | **2389** | **50** | **56** | **102** | **9146** | **3.3** (wall clock, clusters in parallel) |

With batch sizes 10 and 100 the totals were the same. For two devices, the per-device counts matched single-IMEI `HistoryAlarm` totals.
