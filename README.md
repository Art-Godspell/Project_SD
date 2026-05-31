# falconDB — Distributed Key-Value Database

A fault-tolerant, distributed key-value database built entirely in **Node.js** with no external database dependencies. The system uses **Raft consensus** for leader election and **Two-Phase Commit (2PC)** for data replication across nodes.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Running the System](#running-the-system)
  - [Using the falconDBd Controller](#using-the-falcondbd-controller)
  - [Starting Servers Manually](#starting-servers-manually)
- [API Reference](#api-reference)
  - [Reverse Proxy Routes](#reverse-proxy-rp-routes)
  - [Data Node Routes](#data-node-dn-routes)
  - [Response Format](#response-format)
  - [Error Codes](#error-codes)
- [System Workflow](#system-workflow)
  - [Startup &amp; Election](#1-startup--raft-election)
  - [Write Operations (2PC)](#2-write-operations-two-phase-commit)
  - [Read Operations](#3-read-operations)
  - [Update with --delete-- Semantics](#4-update-with---delete---semantics)
  - [Sharding](#5-sharding)
- [Running the Test Client](#running-the-test-client)
- [Log Files](#log-files)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
                          ┌──────────────────┐
                          │     Client       │
                          └────────┬─────────┘
                                   │
                          ┌────────▼─────────┐
                          │  Reverse Proxy   │
                          │   (RP) :3000     │
                          └───┬──────────┬───┘
              shard 0–7       │          │       shard 8–f
                 ┌────────────▼┐        ┌▼────────────┐
                 │  DN Group 1 │        │  DN Group 2  │
                 ├─────────────┤        ├──────────────┤
                 │ dn1a  :4001 │◄──────►│ dn2a  :4004  │
                 │ dn1b  :4002 │  Raft  │ dn2b  :4005  │
                 │ dn1c  :4003 │  + 2PC │ dn2c  :4006  │
                 └─────────────┘        └──────────────┘
```

The system consists of **7 servers**:

| Component | Role | Count |
|-----------|------|-------|
| **Reverse Proxy (RP)** | Public entry point. Receives client requests, shards keys, and forwards to the correct DN group master. | 1 |
| **Data Node (DN)** | Stores key-value data on disk. Each DN group has 3 servers that replicate data via Two-Phase Commit. One server per group is elected **Master** via Raft. | 6 (2 groups × 3) |

### Key Design Decisions

- **No external databases** — all data is stored as JSON files on disk using the native `fs` module.
- **Raft consensus** — each DN group elects a leader. With 3 servers per group, the system tolerates 1 node failure per group (majority = 2/3).
- **Two-Phase Commit** — all write operations (create, update, delete) are coordinated across all replicas to guarantee data consistency.
- **MD5 sharding** — the first hex character of `md5(key)` determines which DN group handles the key.

---

## Prerequisites

Before running falconDB, ensure you have the following installed:

| Requirement | Version | Check Command | Install Guide |
|-------------|---------|---------------|---------------|
| **Node.js** | ≥ 16.x | `node --version` | [nodejs.org](https://nodejs.org/) |
| **npm** | ≥ 8.x | `npm --version` | Comes with Node.js |
| **forever** (optional) | latest | `forever --version` | `npm install -g forever` |
| **curl** (optional) | any | `curl --version` | Pre-installed on macOS/Linux |

> **Note:** `forever` is only required if you want to use the `falconDBd` bash controller script for process management. You can start servers manually without it.

---

## Installation

1. **Clone or copy** the project to your machine:
   ```bash
   git clone <repository-url>
   cd "SD Project"
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```
   This installs: `express`, `winston`, `axios`, and `md5`.

3. **Verify the installation:**
   ```bash
   node -c app/src/rp/server.js && echo "✓ Ready"
   ```

---

## Project Structure

```
SD Project/
├── package.json                    # Node.js manifest & dependencies
├── README.md                       # This file
│
└── app/
    ├── etc/
    │   └── configure.json          # Central configuration (all servers read this)
    │
    ├── falconDBd                   # Bash controller: start/stop/restart/stat
    │
    ├── src/
    │   ├── shared/                 # Modules shared by RP and DN servers
    │   │   ├── config.js           #   Configuration loader & helpers
    │   │   ├── errors.js           #   Normalized error code catalog
    │   │   ├── response.js         #   Standardized {data, error} response formatter
    │   │   ├── logger.js           #   Winston logger factory (system + raft loggers)
    │   │   └── middleware.js       #   Access control: RPt and DNp route guards
    │   │
    │   ├── rp/                     # Reverse Proxy server
    │   │   ├── server.js           #   RP entry point
    │   │   ├── routes.js           #   RP route definitions
    │   │   └── sharding.js         #   MD5-based key → DN group routing
    │   │
    │   ├── dn/                     # Data Node server
    │   │   ├── server.js           #   DN entry point (takes serverId as CLI arg)
    │   │   ├── routes.js           #   DN route definitions
    │   │   ├── storage.js          #   File-based CRUD engine
    │   │   ├── raft.js             #   Raft leader election algorithm
    │   │   └── twopc.js            #   Two-Phase Commit coordinator/participant
    │   │
    │   └── test/
    │       └── test_client.js      #   Integration test client
    │
    ├── DBdata/                     # Data storage (created at runtime)
    │   ├── dn1a/                   #   Each DN server has its own directory
    │   ├── dn1b/
    │   ├── dn1c/
    │   ├── dn2a/
    │   ├── dn2b/
    │   └── dn2c/
    │
    └── logs/                       # Log files (created at runtime)
        ├── rp/
        │   └── rp.log              #   RP system log
        ├── dn1a/
        │   ├── dn1a.log            #   DN system log
        │   └── raft.log            #   Raft election trace log
        ├── dn1b/
        │   ├── dn1b.log
        │   └── raft.log
        └── ...                     #   (one directory per DN server)
```

### Module Descriptions

| Module | Location | Description |
|--------|----------|-------------|
| **Config** | `shared/config.js` | Loads `app/etc/configure.json` and provides helper functions to look up servers by ID, find peers within a DN group, and get RP connection details. |
| **Errors** | `shared/errors.js` | Defines all error codes following the convention `e<Component><Module><Number><Severity>` (e.g., `eRPRT001E`). Provides a `makeError()` factory. |
| **Response** | `shared/response.js` | Formats all API responses as `{data: <payload>, error: 0}` for success or `{data: 0, error: {code, errno, message}}` for errors. |
| **Logger** | `shared/logger.js` | Creates Winston loggers. Each server gets a system log, and each DN additionally gets a dedicated `raft.log` with a custom `trace` level. |
| **Middleware** | `shared/middleware.js` | Implements access control. `requireRPt` restricts DN routes to only accept requests from the RP or configured test client IP. `requireDNp` restricts election/maintenance routes to same-group peers. |
| **Storage** | `dn/storage.js` | CRUD engine using `fs`. Files are named `md5(key).json` and contain `{"key": <key>, "value": <value>}`. Implements `--delete--` merge semantics on update. |
| **Raft** | `dn/raft.js` | Simplified Raft with Follower/Candidate/Leader states. Random election timeout (150–300ms), heartbeat interval (75ms). The elected leader notifies the RP via `/set_master`. |
| **2PC** | `dn/twopc.js` | Two-Phase Commit with Coordinator (runs on Master) and Participant (runs on all DNs). Prepare → vote → commit/abort. |
| **Sharding** | `rp/sharding.js` | Maps keys to DN groups using `md5(key)[0]`. Hex chars `0–7` → group 1, `8–f` → group 2. |

---

## Configuration

All servers read from `app/etc/configure.json`:

```json
{
  "rp": {
    "id": "rp",
    "host": "127.0.0.1",
    "port": 3000
  },
  "dn_groups": [
    {
      "id": "dn1",
      "servers": [
        { "id": "dn1a", "host": "127.0.0.1", "port": 4001 },
        { "id": "dn1b", "host": "127.0.0.1", "port": 4002 },
        { "id": "dn1c", "host": "127.0.0.1", "port": 4003 }
      ]
    },
    {
      "id": "dn2",
      "servers": [
        { "id": "dn2a", "host": "127.0.0.1", "port": 4004 },
        { "id": "dn2b", "host": "127.0.0.1", "port": 4005 },
        { "id": "dn2c", "host": "127.0.0.1", "port": 4006 }
      ]
    }
  ],
  "test_client_ip": "127.0.0.1",
  "log_level": "trace"
}
```

| Field | Description |
|-------|-------------|
| `rp` | Reverse Proxy server configuration (host, port). |
| `dn_groups` | Array of DN groups. Each group has a unique `id` and an array of `servers`. |
| `test_client_ip` | IP address allowed to directly access DN routes during testing/demos. |
| `log_level` | Default log level for all servers (`trace`, `debug`, `info`, `warn`, `error`). |

> **To run on multiple machines:** change the `host` fields from `127.0.0.1` to the actual IP addresses of each machine, and ensure all machines have the same `configure.json`.

---

## Running the System

### Using the falconDBd Controller

The `falconDBd` bash script manages all 7 servers. It requires `forever` to be installed globally.

```bash
# Install forever globally (one-time setup)
npm install -g forever

# Make the script executable (one-time)
chmod +x app/falconDBd
```

| Command | Description |
|---------|-------------|
| `./app/falconDBd start` | Starts the RP first, waits 1 second, then starts all 6 DN servers. Raft elections happen automatically. |
| `./app/falconDBd stop` | Sends a graceful `/stop` request to the RP (which cascades to DNs), then runs `forever stopall` as a fallback. |
| `./app/falconDBd restart` | Stops all servers, waits 1 second, then starts them again. |
| `./app/falconDBd stat` | Queries `/status` on every server and prints a color-coded summary showing which servers are alive and their Raft roles. |

### Starting Servers Manually

If you don't have `forever`, you can start each server individually in separate terminal windows:

```bash
# Terminal 1: Start the Reverse Proxy
node app/src/rp/server.js

# Terminal 2–7: Start each Data Node (one per terminal)
node app/src/dn/server.js dn1a
node app/src/dn/server.js dn1b
node app/src/dn/server.js dn1c
node app/src/dn/server.js dn2a
node app/src/dn/server.js dn2b
node app/src/dn/server.js dn2c
```

> **Important:** Start the RP first, then the DN servers. The DNs will elect leaders via Raft and automatically register with the RP within a few seconds.

**Quick-start with background processes (single terminal):**

```bash
# Start RP in background
node app/src/rp/server.js &

# Wait for RP to be ready
sleep 1

# Start all DNs in background
node app/src/dn/server.js dn1a &
node app/src/dn/server.js dn1b &
node app/src/dn/server.js dn1c &
node app/src/dn/server.js dn2a &
node app/src/dn/server.js dn2b &
node app/src/dn/server.js dn2c &

# Wait for elections
sleep 3

# Verify masters are registered
curl -s http://127.0.0.1:3000/status | node -e "
  process.stdin.resume();
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    const j = JSON.parse(d);
    console.log('Masters:', JSON.stringify(j.data.masters, null, 2));
  });
"
```

---

## API Reference

### Reverse Proxy (RP) Routes

All client requests should be sent to the RP (default: `http://127.0.0.1:3000`).

| Route | Method | Access | Description |
|-------|--------|--------|-------------|
| `/status` | GET | Public | Health check. Returns server status and registered masters. |
| `/stat` | GET | Public | Detailed system statistics including DN group status. |
| `/admin/loglevel` | GET | Private | Get current log level, or set with `?level=debug`. |
| `/db/c` | POST | Public | **Create** a key-value pair. |
| `/db/r` | GET | Public | **Read** a value by key. |
| `/db/u` | POST | Public | **Update** a value (with `--delete--` merge semantics). |
| `/db/d` | GET | Public | **Delete** a key. |
| `/set_master` | GET | DNp | Receives master registration from DN leaders (internal). |
| `/stop` | GET | RPt | Graceful shutdown — cascades stop to all DN masters. |

#### Usage Examples

```bash
# Create
curl -X POST http://127.0.0.1:3000/db/c \
  -H "Content-Type: application/json" \
  -d '{"key": "user:001", "value": {"name": "Alice", "age": 30, "city": "NYC"}}'

# Read
curl "http://127.0.0.1:3000/db/r?key=user:001"

# Update (add email, remove age, set tag to literal "--delete--")
curl -X POST http://127.0.0.1:3000/db/u \
  -H "Content-Type: application/json" \
  -d '{"key": "user:001", "value": {"age": "--delete--", "email": "alice@mail.com", "tag": "\\-\\-delete\\-\\-"}}'

# Delete
curl "http://127.0.0.1:3000/db/d?key=user:001"

# Check status
curl http://127.0.0.1:3000/status

# Change log level
curl "http://127.0.0.1:3000/admin/loglevel?level=debug"
```

### Data Node (DN) Routes

DN servers are not meant to be accessed directly by clients. The CRUD routes (`/db/*`) only accept requests from the RP's IP address or the configured `test_client_ip`.

| Route | Method | Access | Description |
|-------|--------|--------|-------------|
| `/status` | GET | Public | Health check with Raft role. |
| `/stat` | GET | Public | Statistics (Raft status, record count, memory). |
| `/admin/loglevel` | GET | Private | Get/set log level. |
| `/db/c` | POST | RPt | Create (only from RP or test client). |
| `/db/r` | GET | RPt | Read (only from RP or test client). |
| `/db/u` | POST | RPt | Update (only from RP or test client). |
| `/db/d` | GET | RPt | Delete (only from RP or test client). |
| `/election` | GET | DNp | Raft vote request and heartbeat handler (internal). |
| `/maintenance` | POST | DNp | 2PC prepare/commit/abort handler (internal). |
| `/stop` | GET | RPt | Graceful shutdown. |

#### Access Control Types

| Type | Meaning |
|------|---------|
| **Public** | No restriction — anyone can call. |
| **Private** | Admin endpoints — no IP restriction but intended for operators. |
| **RPt** | Only accepts requests from the RP's IP or `test_client_ip`. |
| **DNp** | Only accepts requests from peer DN servers in the same group. |

### Response Format

All API responses follow this strict format:

```json
// Success
{
  "data": { /* payload */ },
  "error": 0
}

// Error
{
  "data": 0,
  "error": {
    "code": "eRPRT001E",
    "errno": 400,
    "message": "Missing or invalid request body"
  }
}
```

### Error Codes

Error codes follow the pattern: `e<Component><Module><Number><Severity>`

| Code | HTTP | Description |
|------|------|-------------|
| `eRPRT001E` | 400 | Missing or invalid request body |
| `eRPRT002E` | 404 | Key not found |
| `eRPRT003E` | 409 | Key already exists |
| `eRPRT004E` | 500 | Data node unreachable |
| `eRPRT005E` | 503 | No master known for DN group |
| `eDNST001E` | 500 | File system error |
| `eDNST002E` | 404 | Key not found in storage |
| `eDNST003E` | 409 | Key already exists in storage |
| `eDNRF001I` | — | Election started |
| `eDNRF002I` | — | Vote requested/granted/denied |
| `eDNRF003I` | — | Leader elected |
| `eDNRF004E` | 500 | Election timeout/failure |
| `eDNTC001E` | 500 | Two-Phase Commit prepare failed |
| `eDNTC002E` | 500 | Two-Phase Commit commit/abort failed |
| `eDNMD001W` | 403 | Request rejected — unauthorized origin IP |

---

## System Workflow

### 1. Startup & Raft Election

```
1. RP starts and listens on port 3000
2. All 6 DN servers start as Followers
3. Each Follower sets a random election timeout (150–300ms)
4. The first Follower to timeout becomes a Candidate:
   - Increments its term
   - Votes for itself
   - Sends RequestVote to peers via GET /election
5. Peers grant their vote (first-come-first-served per term)
6. Candidate with majority (2/3) becomes Leader
7. Leader notifies RP via GET /set_master?group=<id>&id=<id>&host=<host>&port=<port>
8. Leader sends periodic heartbeats (every 75ms) to suppress new elections
```

### 2. Write Operations (Two-Phase Commit)

All write operations (Create, Update, Delete) go through 2PC to ensure data consistency:

```
Client → RP → DN Master (Coordinator)

Phase 1 — Prepare:
  Master → POST /maintenance?action=prepare → All Replicas
  Each Replica validates the operation and votes "commit" or "abort"

Phase 2a — Commit (if all voted commit):
  Master executes the operation locally
  Master → POST /maintenance?action=commit → All Replicas
  Replicas execute the operation

Phase 2b — Abort (if any voted abort):
  Master → POST /maintenance?action=abort → All Replicas
  No data is modified
```

### 3. Read Operations

Reads are simple — the RP forwards to the DN group master, which reads directly from local storage:

```
Client → GET /db/r?key=mykey → RP → DN Master → Read from disk → Response
```

### 4. Update with --delete-- Semantics

The update operation performs a **merge** of the incoming object with the stored object, with special handling:

| Incoming Value | Action |
|---------------|--------|
| `"--delete--"` | **Remove** that member from the stored object |
| `"\\-\\-delete\\-\\-"` | **Set** the member to the literal string `"--delete--"` |
| Any other value | **Overwrite** the member |

**Example:**

```
Stored:   {"name": "Alice", "age": 30, "city": "NYC"}
Update:   {"age": "--delete--", "email": "a@b.com", "tag": "\\-\\-delete\\-\\-"}
Result:   {"name": "Alice", "city": "NYC", "email": "a@b.com", "tag": "--delete--"}
```

### 5. Sharding

Keys are distributed across DN groups using MD5 hashing:

```
md5("mykey") → "a1b2c3d4..."
First hex char: 'a' (= 10 in decimal)
With 2 groups: 10 / 8 = 1 → DN Group 2
```

| First hex char | DN Group |
|---------------|----------|
| `0` – `7` | Group 1 (dn1a, dn1b, dn1c) |
| `8` – `f` | Group 2 (dn2a, dn2b, dn2c) |

---

## Running the Test Client

The integration test exercises the full CRUD cycle including `--delete--` semantics:

```bash
# Run against default RP (127.0.0.1:3000)
node app/src/test/test_client.js

# Run against a custom RP address
node app/src/test/test_client.js 192.168.1.100 3000
```

**Test coverage:**

1. RP health check
2. Create a key-value record
3. Read the record back
4. Update with `--delete--` member removal and escaped literal
5. Read again to verify update semantics
6. Delete the record
7. Verify deletion returns 404

---

## Log Files

All logs are stored under `app/logs/`:

| File | Content |
|------|---------|
| `app/logs/rp/rp.log` | RP system log (requests, errors, master registrations) |
| `app/logs/<dn_id>/<dn_id>.log` | DN system log (CRUD operations, 2PC activity) |
| `app/logs/<dn_id>/raft.log` | Raft election trace log (votes, terms, leader changes) |

Each DN server writes to its **own** `raft.log`, so you can inspect any individual server's election history:

```bash
# View dn1a's election log
cat app/logs/dn1a/raft.log

# Watch election activity in real-time
tail -f app/logs/dn1a/raft.log
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `npm install` fails | Ensure Node.js ≥ 16 is installed: `node --version` |
| RP shows no masters after startup | Ensure DNs started **after** the RP. Check DN console/log output for errors. |
| `EADDRINUSE` error | A server is already running on that port. Kill it: `lsof -i :<port>` then `kill <pid>` |
| `forever` not found | Install globally: `npm install -g forever`, or start servers manually. |
| DN rejects requests with 403 | The request is not coming from the RP's IP or `test_client_ip`. Check `configure.json`. |
| Raft election keeps looping | Ensure all 3 servers in a group can reach each other. Check firewall rules. |
| Data not replicating | Check DN logs for 2PC errors. Ensure the master can reach all peers. |

---

## Technologies

| Package | Version | Purpose |
|---------|---------|---------|
| [express](https://expressjs.com/) | ^4.18.2 | HTTP server & routing |
| [winston](https://github.com/winstonjs/winston) | ^3.11.0 | Structured logging |
| [axios](https://axios-http.com/) | ^1.6.2 | Inter-server HTTP requests |
| [md5](https://github.com/pvorb/node-md5) | ^2.3.0 | Key hashing for filenames & sharding |
| [forever](https://github.com/foreversd/forever) | latest | Process management (optional) |