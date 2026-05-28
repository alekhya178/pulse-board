# PulseBoard — Real-Time Collaborative Operations Platform

> A production-quality backend for a collaborative incident and deployment coordination platform, built with **Node.js**, **Express**, and **Redis** as the primary operational data store.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                  Docker Compose Network                  │
│                                                         │
│  ┌──────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │  API Server  │  │   Worker   │  │   Scheduler    │  │
│  │  :3000       │  │  (BRPOP/  │  │  (node-cron)   │  │
│  │  REST + WS   │  │  XREADGRP)│  │                │  │
│  └──────┬───────┘  └─────┬──────┘  └───────┬────────┘  │
│         │                │                  │           │
│         └────────────────┴──────────────────┘           │
│                          │                              │
│               ┌──────────▼──────────┐                  │
│               │     Redis 7.x        │                  │
│               │   Sessions  Streams  │                  │
│               │   Pub/Sub   Sorted   │                  │
│               │   Sets      Bitmaps  │                  │
│               │   HyperLog  GEO      │                  │
│               └─────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

### Components

| Service | Responsibility |
|---|---|
| **API Server** | REST endpoints + WebSocket server for Pub/Sub fan-out |
| **Worker** | Background job processor — BRPOP (job queue) + XREADGROUP (streams) |
| **Scheduler** | Cron-based task scheduler — enqueues jobs, uses distributed locks |
| **Redis 7** | All operational data: sessions, caches, queues, pub/sub, streams, locks, analytics |

---

## Redis Key Naming Schema

All keys follow the pattern `object-type:identifier:attribute`.

| Key Pattern | Redis Type | Purpose | TTL |
|---|---|---|---|
| `session:{token}` | String | User session → user_id | 86400s |
| `rate_limit:{userId}:{minuteTs}` | String (counter) | Rate limit counter | 60s window |
| `feed:{userId}` | List | Activity feed (newest first) | None (capped at 100) |
| `online_users` | Set | Currently online user IDs | None |
| `workspace:{id}` | Hash | Workspace metadata | None |
| `workspace:{id}:members` | Set | Workspace member user IDs | None |
| `workspace:{id}:channels` | Set | Channel IDs in a workspace | None |
| `user:{id}` | Hash | User profile fields | None |
| `user:{id}:workspaces` | Set | Workspace IDs a user belongs to | None |
| `attendance:{userId}:{YYYY-MM}` | Bitmap | Daily activity (bit offset = day) | None |
| `channel:{id}` | Hash | Channel metadata | None |
| `stream:events` | Stream | System event log | None |
| `queue:jobs` | List | Background job queue (LPUSH/BRPOP) | None |
| `trending:channels` | Sorted Set | Channel activity scores | None |
| `reputation:users` | Sorted Set | User reputation scores | None |
| `analytics:dau:{YYYY-MM-DD}` | HyperLogLog | Approximate daily unique users | None |
| `geo:active_users` | GEO | User longitude/latitude index | None |
| `lock:{resource}` | String | Distributed lock token | 30s |
| `scheduler:heartbeat` | String | Scheduler liveness timestamp | None |

---

## Core Requirements Implementation

| # | Requirement | Redis Structure | Commands Used |
|---|---|---|---|
| 1 | Sessions & Authentication | String | `SETEX`, `GET`, `EXPIRE`, `TTL`, `DEL` |
| 2 | API Rate Limiting | String (counter) | `INCR`, `EXPIRE`, `TTL` |
| 3 | Activity Feed | List | `LPUSH`, `LRANGE`, `LTRIM` |
| 4 | Presence Tracking | Set | `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER` |
| 5 | Workspace Membership | Set | `SADD`, `SREM`, `SMEMBERS`, `SINTER` |
| 6 | User Profiles | Hash | `HSET`, `HGET`, `HMGET`, `HGETALL`, `HEXISTS` |
| 7 | Real-Time Messaging | Pub/Sub | `PUBLISH`, `SUBSCRIBE` |
| 8 | Event Streaming | Stream | `XADD`, `XREADGROUP`, `XACK` |
| 9 | Trending & Reputation | Sorted Set | `ZINCRBY`, `ZREVRANGE` |
| 10 | Distributed Locking | String (NX+EX) | `SET NX EX`, `DEL` (via Lua) |
| 11 | Approx. Analytics (DAU) | HyperLogLog | `PFADD`, `PFCOUNT` |
| 12 | Attendance Tracking | Bitmap | `SETBIT`, `GETBIT`, `BITCOUNT` |
| 13 | Geospatial Awareness | GEO | `GEOADD`, `GEOSEARCH`, `GEOPOS` |
| 14 | Atomic Transactions | MULTI/EXEC | `MULTI`, `EXEC` |
| 15 | Background Job Queue | List + Stream | `LPUSH`, `BRPOP`, `XADD`, `XREADGROUP`, `XACK` |

---

## API Endpoints

### Authentication
| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/login` | Login — creates Redis session, returns `session_token` |
| `POST` | `/auth/logout` | Logout — deletes session key |
| `GET` | `/auth/session` | Get session info + remaining TTL |

### Users
| Method | Path | Description |
|---|---|---|
| `GET` | `/users/:id` | Get full profile (HGETALL) |
| `GET` | `/users/:id/fields?fields=name,email` | Partial fetch (HMGET) |
| `PUT` | `/users/:id` | Update profile fields (HSET) |
| `GET` | `/users/:id/attendance?month=YYYY-MM` | Attendance bitmap |
| `POST` | `/users/:id/attendance` | Mark active day (SETBIT) |

### Workspaces
| Method | Path | Description |
|---|---|---|
| `POST` | `/workspaces` | Create workspace |
| `GET` | `/workspaces/:id` | Get workspace info |
| `GET` | `/workspaces/:id/members` | ⭐ List members (SMEMBERS) |
| `POST` | `/workspaces/:id/members` | Add member (SADD) |
| `DELETE` | `/workspaces/:id/members/:uid` | Remove member (SREM) |
| `POST` | `/workspaces/:id/invite/accept` | Accept invite (MULTI/EXEC) |
| `GET` | `/workspaces/common?user_a=&user_b=` | Common workspaces (SINTER) |

### Channels & Messaging
| Method | Path | Description |
|---|---|---|
| `POST` | `/channels` | Create channel |
| `GET` | `/channels` | List all channels |
| `POST` | `/channels/:id/messages` | Publish message (PUBLISH + ZINCRBY) |
| `POST` | `/channels/:id/typing` | Publish typing indicator (PUBLISH) |

### Analytics
| Method | Path | Description |
|---|---|---|
| `GET` | `/analytics/trending` | ⭐ Top trending channels (ZREVRANGE) |
| `GET` | `/analytics/reputation?n=10` | User reputation leaderboard |
| `POST` | `/analytics/reputation/increment` | Increment reputation (ZINCRBY) |
| `POST` | `/analytics/dau` | Record user activity (PFADD) |
| `GET` | `/analytics/dau?date=YYYY-MM-DD` | Get DAU count (PFCOUNT) |
| `GET` | `/analytics/dau/range?from=&to=` | DAU across date range |

### Presence
| Method | Path | Description |
|---|---|---|
| `GET` | `/presence` | All online users (SMEMBERS) |
| `GET` | `/presence/:userId` | Check if user online (SISMEMBER) |
| `POST` | `/presence/online` | Mark online (SADD) |
| `DELETE` | `/presence/online` | Mark offline (SREM) |

### Geospatial
| Method | Path | Description |
|---|---|---|
| `POST` | `/geo/location` | Update location (GEOADD) |
| `GET` | `/geo/location/:userId` | Get stored location (GEOPOS) |
| `GET` | `/geo/nearby?longitude=&latitude=&radius=&unit=km` | Find nearby users (GEOSEARCH) |

### Locks
| Method | Path | Description |
|---|---|---|
| `POST` | `/locks/acquire` | Acquire distributed lock + run task |
| `POST` | `/locks/release` | Explicitly release a lock |
| `GET` | `/locks/:resource` | Check lock state + TTL |

### Jobs & Streams
| Method | Path | Description |
|---|---|---|
| `POST` | `/jobs/enqueue` | Enqueue background job (LPUSH) |
| `GET` | `/jobs/queue-length` | Queue depth (LLEN) |
| `POST` | `/jobs/streams/events` | Add event to stream (XADD) |
| `GET` | `/jobs/streams/events` | Recent stream events (XRANGE) |

### Feed
| Method | Path | Description |
|---|---|---|
| `GET` | `/feed` | My activity feed (LRANGE) |
| `GET` | `/feed/:userId` | Another user's feed |
| `POST` | `/feed/event` | Push custom event (LPUSH + LTRIM) |

### Health
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service + Redis health check |

---

## WebSocket API

Connect to `ws://localhost:3000` and send JSON messages:

```json
// Subscribe to real-time channel messages
{ "action": "subscribe", "channels": ["channel:ch-general:messages", "channel:ch-general:typing"] }

// Presence heartbeat
{ "action": "ping", "user_id": "user-alice-001" }

// Unsubscribe
{ "action": "unsubscribe", "channels": ["channel:ch-general:typing"] }
```

Received messages will be in the format:
```json
{ "channel": "channel:ch-general:messages", "data": { "text": "Hello!", "sender_id": "user-alice-001", "ts": 1716000000000 } }
```

---

## Design Decisions

### Why `ioredis` over `node-redis`?
`ioredis` provides native support for Streams (`XADD`/`XREADGROUP`), pipeline/MULTI, blocking commands (`BRPOP`), and Lua scripting — all needed for this project. It also allows creating multiple independent client connections easily, which is required because a subscribed Pub/Sub connection cannot run other commands.

### Distributed Lock Safety
The lock release uses a **Lua script** (atomic `GET` + conditional `DEL`) to prevent a race condition where:
1. Process A's lock expires
2. Process B acquires the same lock
3. Process A wakes up and accidentally deletes Process B's lock

The Lua script ensures only the lock owner (matching token UUID) can release it.

### Worker Architecture
The Worker runs two concurrent async loops:
- **BRPOP loop** — blocks up to 5s on the job queue, returns immediately when a job arrives
- **XREADGROUP loop** — blocks up to 2s on the event stream, processes and ACKs each event

Both loops run in the same Node.js process using `Promise.all`, which is safe because both operations are I/O-bound (no CPU contention).

### Scheduler + Distributed Lock
The Scheduler uses `acquireLock` before running each cron task. In a multi-replica deployment, all instances try to acquire the lock; only one succeeds and runs the task. The others skip it silently.

### MULTI/EXEC for Invite Acceptance
Accepting a workspace invitation requires two writes:
1. Add the user to `workspace:{id}:members` (Set)
2. Push an event to `feed:{userId}` (List)

Wrapping these in `MULTI/EXEC` ensures atomicity — either both succeed or neither does, even if Redis restarts mid-operation.

---

## Quick Start

### Prerequisites
- Docker ≥ 24 and Docker Compose ≥ 2.x

### 1. Clone and configure
```bash
git clone <repo-url> pulse_board
cd pulse_board
cp .env.example .env   # Edit if needed — defaults work for Docker Compose
```

### 2. Start all services
```bash
docker compose up --build
```

This starts:
- `redis` — Redis 7 with AOF persistence
- `api` — REST + WebSocket server on port 3000
- `worker` — Background job processor
- `scheduler` — Cron task scheduler

### 3. Verify services are healthy
```bash
curl http://localhost:3000/health
# {"status":"ok","redis":"connected","timestamp":"..."}
```

### 4. Run the automated test suite
```bash
bash test.sh
# or on Windows (Git Bash):
bash test.sh http://localhost:3000
```

### 5. Quick manual test flow
```bash
# Login
TOKEN=$(curl -sf -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u1","email":"alice@example.com","name":"Alice"}' \
  | grep -o '"session_token":"[^"]*"' | cut -d'"' -f4)

# Send a message (triggers Pub/Sub + trending score)
curl -X POST http://localhost:3000/channels/ch-general/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello PulseBoard!"}'

# Check trending channels
curl http://localhost:3000/analytics/trending \
  -H "Authorization: Bearer $TOKEN"
```

---

## Development (Local without Docker)

```bash
# Requires Redis running on localhost:6379
cp .env.example .env
# Change REDIS_HOST=localhost in .env

npm install

# Terminal 1 — API
npm start

# Terminal 2 — Worker
npm run worker

# Terminal 3 — Scheduler
npm run scheduler
```

---

## Project Structure

```
pulse_board/
├── src/
│   ├── api/
│   │   ├── routes/       # Express route handlers (one file per domain)
│   │   └── server.js     # Express app + WebSocket server
│   ├── middleware/
│   │   ├── auth.js       # Session token validation
│   │   └── rateLimiter.js# Redis INCR-based rate limiting
│   ├── services/
│   │   ├── redis.js      # ioredis clients (main, subscriber, blocking)
│   │   ├── session.js    # SETEX/GET/DEL session helpers
│   │   ├── feed.js       # LPUSH/LTRIM/LRANGE feed helpers
│   │   ├── presence.js   # SADD/SREM/SMEMBERS presence helpers
│   │   ├── streaming.js  # XADD/XREADGROUP/XACK stream helpers
│   │   ├── pubsub.js     # PUBLISH helper
│   │   └── lock.js       # SET NX EX + Lua release lock helpers
│   ├── worker/
│   │   └── worker.js     # BRPOP job queue + XREADGROUP stream consumer
│   └── scheduler/
│       └── scheduler.js  # node-cron scheduled tasks
├── Dockerfile            # API server (multi-stage, non-root)
├── Dockerfile.worker     # Worker service
├── Dockerfile.scheduler  # Scheduler service
├── docker-compose.yml    # All services + Redis + healthchecks
├── .env.example          # Environment variable template
├── package.json
├── test.sh               # curl-based test suite (all 15 requirements)
└── README.md
```

---

## Demo Frontend Client

A dynamic, real-time single-page web dashboard is served directly at `http://localhost:3000/` for evaluation and coordination testing. 

### Key Features:
* **Slate/Zinc Dark Theme**: Minimalist glassmorphic dashboard styled with Tailwind CSS.
* **Real-Time WS Chat**: Instant messaging, live WebSocket event synchronization, client message deduplication, and typing notifications.
* **Shared Workspaces Finder**: A dedicated SINTER-powered user lookup tool to identify overlapping workspaces.
* **Geospatial & Attendance Simulation**: Interactive modules for coordinates check-in and daily bitmap-backed attendance checking.

---

## Monitoring & Debugging

```bash
# View Redis keys
docker exec pulseboard-redis redis-cli KEYS '*'

# Check session TTL
docker exec pulseboard-redis redis-cli TTL "session:<token>"

# View trending channels
docker exec pulseboard-redis redis-cli ZREVRANGE trending:channels 0 9 WITHSCORES

# View event stream
docker exec pulseboard-redis redis-cli XRANGE stream:events - + COUNT 10

# View job queue length
docker exec pulseboard-redis redis-cli LLEN queue:jobs

# Check scheduler heartbeat
docker exec pulseboard-redis redis-cli GET scheduler:heartbeat

# Follow all service logs
docker compose logs -f
```

---

## License

MIT — built as a portfolio demonstration project.
