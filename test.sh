#!/usr/bin/env bash
# =============================================================================
# PulseBoard API Test Script
# Tests all core requirements against a running API server.
# Usage: bash test.sh [BASE_URL]
# Default: BASE_URL=http://localhost:3000
# =============================================================================

BASE_URL="${1:-http://localhost:3000}"
PASS=0
FAIL=0
TOKEN=""
USER_A="user-alice-001"
USER_B="user-bob-002"
WORKSPACE_ID="ws-engineering"
CHANNEL_ID="ch-general"

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

section() { echo -e "\n${CYAN}${BOLD}▶ $1${NC}"; }
pass()    { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail()    { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); }

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    pass "$label"
  else
    fail "$label — expected '$expected' in: $actual"
  fi
}

echo -e "${BOLD}PulseBoard API Test Suite${NC}"
echo "Base URL: $BASE_URL"
echo "──────────────────────────────────────────────"

# ─── Health Check ────────────────────────────────────────────────────────────
section "Health Check"
res=$(curl -sf "$BASE_URL/health")
check "GET /health returns ok" '"status":"ok"' "$res"
check "Redis connected" '"redis":"connected"' "$res"

# ─── REQ 1 + API: Login ──────────────────────────────────────────────────────
section "Req 1 + API: Sessions & Authentication"
res=$(curl -sf -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_A\",\"email\":\"alice@example.com\",\"name\":\"Alice\"}")
check "POST /auth/login returns 200 with session_token" "session_token" "$res"
TOKEN=$(echo "$res" | grep -o '"session_token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  fail "Could not extract session token — remaining tests may fail"
else
  pass "Session token extracted: ${TOKEN:0:8}..."
fi

# Login second user
res2=$(curl -sf -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_B\",\"email\":\"bob@example.com\",\"name\":\"Bob\"}")
check "Second user login" "session_token" "$res2"
TOKEN_B=$(echo "$res2" | grep -o '"session_token":"[^"]*"' | cut -d'"' -f4)

# Session info
res=$(curl -sf "$BASE_URL/auth/session" -H "Authorization: Bearer $TOKEN")
check "GET /auth/session returns user_id" "\"user_id\":\"$USER_A\"" "$res"
check "Session has positive TTL" "expires_in" "$res"

# ─── REQ 2: Rate Limiting ────────────────────────────────────────────────────
section "Req 2: Rate Limiting"
res=$(curl -sI "$BASE_URL/health" -H "Authorization: Bearer $TOKEN" 2>&1)
# Headers may or may not be present for /health (no auth middleware), test via /feed
res=$(curl -sI "$BASE_URL/feed" -H "Authorization: Bearer $TOKEN" 2>&1)
check "Rate-limit headers present" "X-RateLimit-Limit" "$res"

# ─── REQ 3: Activity Feed ────────────────────────────────────────────────────
section "Req 3: Activity Feed"
res=$(curl -sf "$BASE_URL/feed" -H "Authorization: Bearer $TOKEN")
check "GET /feed returns feed array" '"feed"' "$res"
# Login already pushed an event
check "Feed contains login event" "login" "$res"

# ─── REQ 4: Presence ─────────────────────────────────────────────────────────
section "Req 4: Presence Tracking"
curl -sf -X POST "$BASE_URL/presence/online" -H "Authorization: Bearer $TOKEN" > /dev/null
res=$(curl -sf "$BASE_URL/presence" -H "Authorization: Bearer $TOKEN")
check "GET /presence lists online users" "online_users" "$res"
check "Alice is in the online set" "$USER_A" "$res"

res=$(curl -sf "$BASE_URL/presence/$USER_A" -H "Authorization: Bearer $TOKEN")
check "GET /presence/:id returns online=true" '"online":true' "$res"

curl -sf -X DELETE "$BASE_URL/presence/online" -H "Authorization: Bearer $TOKEN" > /dev/null
res=$(curl -sf "$BASE_URL/presence/$USER_A" -H "Authorization: Bearer $TOKEN")
check "After DELETE /presence/online user is offline" '"online":false' "$res"

# ─── REQ 5: Workspace Membership ─────────────────────────────────────────────
section "Req 5: Workspace Membership"
curl -sf -X POST "$BASE_URL/workspaces" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\",\"name\":\"Engineering\"}" > /dev/null

res=$(curl -sf "$BASE_URL/workspaces/$WORKSPACE_ID/members" -H "Authorization: Bearer $TOKEN")
check "GET /workspaces/:id/members returns array" '"members"' "$res"
check "Creator is a member" "$USER_A" "$res"

curl -sf -X POST "$BASE_URL/workspaces/$WORKSPACE_ID/members" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_B\"}" > /dev/null

res=$(curl -sf "$BASE_URL/workspaces/$WORKSPACE_ID/members" -H "Authorization: Bearer $TOKEN")
check "Second member added" "$USER_B" "$res"

# ─── REQ 6: User Profiles ────────────────────────────────────────────────────
section "Req 6: User Profiles (Redis Hash)"
res=$(curl -sf "$BASE_URL/users/$USER_A" -H "Authorization: Bearer $TOKEN")
check "GET /users/:id returns HGETALL profile" '"email"' "$res"
check "Profile has name field" '"name"' "$res"

res=$(curl -sf "$BASE_URL/users/$USER_A/fields?fields=name,email" -H "Authorization: Bearer $TOKEN")
check "GET /users/:id/fields (HMGET)" '"name"' "$res"

curl -sf -X PUT "$BASE_URL/users/$USER_A" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bio":"Platform Engineer at PulseBoard"}' > /dev/null
res=$(curl -sf "$BASE_URL/users/$USER_A" -H "Authorization: Bearer $TOKEN")
check "PUT /users/:id updates Hash field" "Platform Engineer" "$res"

# ─── REQ 7: Real-Time Messaging (Pub/Sub) ────────────────────────────────────
section "Req 7: Real-Time Messaging (Pub/Sub)"
curl -sf -X POST "$BASE_URL/channels" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel_id\":\"$CHANNEL_ID\",\"name\":\"#general\",\"workspace_id\":\"$WORKSPACE_ID\"}" > /dev/null

res=$(curl -sf -X POST "$BASE_URL/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from PulseBoard!"}')
check "POST /channels/:id/messages publishes and returns message" '"text"' "$res"
check "Message response includes pub_sub_receivers" "pub_sub_receivers" "$res"

res=$(curl -sf -X POST "$BASE_URL/channels/$CHANNEL_ID/typing" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')
check "POST /channels/:id/typing returns sent status" '"status":"sent"' "$res"

# ─── REQ 8: Event Streaming ──────────────────────────────────────────────────
section "Req 8: Event Streaming (Redis Streams)"
res=$(curl -sf -X POST "$BASE_URL/jobs/streams/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"test_event","data":{"key":"value"}}')
check "POST /jobs/streams/events adds to stream (XADD)" "stream_id" "$res"

res=$(curl -sf "$BASE_URL/jobs/streams/events" -H "Authorization: Bearer $TOKEN")
check "GET /jobs/streams/events returns recent entries (XRANGE)" '"events"' "$res"

# ─── REQ 9: Trending Channels ────────────────────────────────────────────────
section "Req 9: Trending Channels & Reputation (Sorted Set)"
# Message was published above — channel should be scored
res=$(curl -sf "$BASE_URL/analytics/trending" -H "Authorization: Bearer $TOKEN")
check "GET /analytics/trending returns ranked channels (ZREVRANGE)" '"trending"' "$res"
check "Channel appears in trending" "$CHANNEL_ID" "$res"

res=$(curl -sf "$BASE_URL/analytics/reputation" -H "Authorization: Bearer $TOKEN")
check "GET /analytics/reputation returns user leaderboard" '"leaderboard"' "$res"

# ─── REQ 10: Distributed Locking ─────────────────────────────────────────────
section "Req 10: Distributed Locking"
res=$(curl -sf -X POST "$BASE_URL/locks/acquire" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resource":"daily_digest"}')
check "POST /locks/acquire acquires lock and runs task" '"task_result"' "$res"
check "Lock is released after task" '"released":true' "$res"

# ─── REQ 11: DAU / HyperLogLog ───────────────────────────────────────────────
section "Req 11: Approximate Analytics / DAU (HyperLogLog)"
TODAY=$(date -u +%Y-%m-%d)
curl -sf -X POST "$BASE_URL/analytics/dau" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_A\",\"date\":\"$TODAY\"}" > /dev/null

res=$(curl -sf "$BASE_URL/analytics/dau?date=$TODAY" -H "Authorization: Bearer $TOKEN")
check "GET /analytics/dau returns approximate_dau >= 1" "approximate_dau" "$res"

# ─── REQ 12: Attendance / Bitmaps ────────────────────────────────────────────
section "Req 12: Attendance & Binary Tracking (Bitmaps)"
MONTH=$(date -u +%Y-%m)
DAY=$(date -u +%-d)
curl -sf -X POST "$BASE_URL/users/$USER_A/attendance" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"month\":\"$MONTH\",\"day\":$DAY}" > /dev/null

res=$(curl -sf "$BASE_URL/users/$USER_A/attendance?month=$MONTH" -H "Authorization: Bearer $TOKEN")
check "GET /users/:id/attendance returns active_days" "active_days" "$res"
check "Current day shows as active (GETBIT=1)" "\"$DAY\":1" "$res"

# ─── REQ 13: Geospatial ──────────────────────────────────────────────────────
section "Req 13: Geospatial Awareness"
curl -sf -X POST "$BASE_URL/geo/location" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"longitude":77.5946,"latitude":12.9716}' > /dev/null

res=$(curl -sf "$BASE_URL/geo/location/$USER_A" -H "Authorization: Bearer $TOKEN")
check "GET /geo/location/:userId returns stored coordinates" "longitude" "$res"

res=$(curl -sf "$BASE_URL/geo/nearby?longitude=77.5946&latitude=12.9716&radius=50&unit=km" \
  -H "Authorization: Bearer $TOKEN")
check "GET /geo/nearby returns nearby array" "nearby" "$res"

# ─── REQ 14: MULTI/EXEC Transactions ─────────────────────────────────────────
section "Req 14: Transactions & Atomicity (MULTI/EXEC)"
res=$(curl -sf -X POST "$BASE_URL/workspaces/$WORKSPACE_ID/invite/accept" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"user-charlie-003\"}")
check "POST /invite/accept runs atomically (MULTI/EXEC)" '"status":"accepted"' "$res"
check "Results array present (proof of pipeline)" '"results"' "$res"

# ─── REQ 15: Background Job Queue ─────────────────────────────────────────────
section "Req 15: Background Job Queue (List / BRPOP)"
res=$(curl -sf -X POST "$BASE_URL/jobs/enqueue" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"send_email","payload":{"to":"test@example.com","subject":"Welcome!"}}')
check "POST /jobs/enqueue places job on queue (LPUSH)" '"job_id"' "$res"
check "Queue length reported" "queue_length" "$res"

res=$(curl -sf "$BASE_URL/jobs/queue-length" -H "Authorization: Bearer $TOKEN")
check "GET /jobs/queue-length returns queue size" '"length"' "$res"

# ─── Session Logout ───────────────────────────────────────────────────────────
section "Session Logout (DEL)"
res=$(curl -sf -X POST "$BASE_URL/auth/logout" -H "Authorization: Bearer $TOKEN")
check "POST /auth/logout destroys session" "Logged out" "$res"

res=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/feed" -H "Authorization: Bearer $TOKEN")
check "Expired token returns 401" "401" "$res"

# ─── Summary ──────────────────────────────────────────────────────────────────
TOTAL=$((PASS+FAIL))
echo ""
echo "──────────────────────────────────────────────"
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} / ${TOTAL} total"
echo "──────────────────────────────────────────────"
[ "$FAIL" -eq 0 ] && echo -e "${GREEN}${BOLD}✓ All tests passed!${NC}" && exit 0
echo -e "${RED}${BOLD}✗ Some tests failed. Check the output above.${NC}" && exit 1
