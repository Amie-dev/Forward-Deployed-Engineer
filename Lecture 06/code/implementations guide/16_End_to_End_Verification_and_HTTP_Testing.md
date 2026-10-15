# Chapter 16: End-to-End Verification, HTTP Testing & Production Checklist

> **Chapter Goal:** Verify the deployed pipeline the way production breaks it: real headers, real proxies, curl -N, browser HUD, and the hardening checklist from section 10.2.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `test-requests.http` | 147 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `test-requests.http` (146 lines)

```http
### ============================================================================
### Lecture 06 — AI Streaming Microservice · REST Client collection
### Use with the VS Code "REST Client" extension, or copy the curl equivalents.
### Start the server first:  npm run dev   (default http://localhost:8090)
### ============================================================================

@baseUrl = http://localhost:8090
@conversationId = conv_demo_001

### 1. Health + active provider (simulator unless an API key is configured)
GET {{baseUrl}}/health
Accept: application/json

### 2. Streaming health, latency percentiles and alerts (the streaming dashboard)
GET {{baseUrl}}/api/observability
Accept: application/json

### 3. Prometheus exposition (scrape target: TTFT, ITL, chunks, aborts, in-band errors)
GET {{baseUrl}}/metrics
Accept: text/plain

### 4. ❌ BUFFERED baseline — one JSON body, TTFT is internal only
# Note the timings in the response: the client waited for totalMs, not ttftMs.
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "message": "Explain AI streaming in detail.",
  "conversationId": "{{conversationId}}",
  "granularity": "sentence"
}

### 5. ✅ STREAMING over NDJSON (one JSON envelope per line)
# In VS Code REST Client this appears progressively; curl equivalent below.
POST {{baseUrl}}/api/chat/stream?transport=ndjson
Content-Type: application/json

{
  "message": "Explain AI streaming in detail.",
  "conversationId": "{{conversationId}}",
  "granularity": "sentence"
}

### 6. ✅ STREAMING over SSE (named events, ids, heartbeats)
POST {{baseUrl}}/api/chat/events
Content-Type: application/json

{
  "message": "Explain the difference between TTFT and total latency.",
  "conversationId": "conv_demo_sse",
  "granularity": "sentence"
}

### 7. ✅ STREAMING as RAW text/plain (the PDF/Tomato pattern — no framing at all)
POST {{baseUrl}}/api/chat/stream?transport=text
Content-Type: application/json

{
  "message": "Explain why streaming does not require SSE.",
  "conversationId": "conv_demo_text"
}

### 8. Coalescing granularity: token (provider cadence, many small chunks)
POST {{baseUrl}}/api/chat/stream?transport=ndjson
Content-Type: application/json

{
  "message": "Explain token coalescing.",
  "conversationId": "conv_demo_granularity",
  "granularity": "token"
}

### 9. Chaos: mid-stream provider failure ⇒ IN-BAND `error` frame + partial text kept
POST {{baseUrl}}/api/chat/events
Content-Type: application/json

{
  "message": "This answer will be cut off mid-stream.",
  "conversationId": "conv_demo_error",
  "chaos": { "failAfterDeltas": 3, "failCode": "provider_error" }
}

### 10. Chaos: silent provider ⇒ idle watchdog (`upstream_stall`) + heartbeats
POST {{baseUrl}}/api/chat/events
Content-Type: application/json

{
  "message": "This answer will stall.",
  "conversationId": "conv_demo_stall",
  "chaos": { "stallAfterDeltas": 2, "stallMs": 40000 }
}

### 11. Live in-flight streams (cancellation + catch-up inventory)
GET {{baseUrl}}/api/chat/streams
Accept: application/json

### 12. Cancel a stream by requestId (paste one from response 11)
POST {{baseUrl}}/api/chat/streams/req_PASTE_REQUEST_ID/cancel
Content-Type: application/json

{ "reason": "Supervisor cancelled this generation." }

### 13. Catch-up after a socket loss: frames the client has not seen yet
GET {{baseUrl}}/api/chat/streams/req_PASTE_REQUEST_ID/catch-up?fromSeq=0
Accept: application/json

### 14. Conversation transcript — ONE assistant message per turn, with status
GET {{baseUrl}}/api/conversations/{{conversationId}}
Accept: application/json

### 15. What the NEXT prompt will actually contain (context budget + annotation)
GET {{baseUrl}}/api/conversations/{{conversationId}}/budget
Accept: application/json

### 16. Report the TTFT the user felt ⇒ drives the p95 TTFT-gap alert
POST {{baseUrl}}/api/observability/client-ttft
Content-Type: application/json

{
  "serverTtftMs": 380,
  "clientTtftMs": 460
}

### 17. Reset metrics/state (disabled when NODE_ENV=production)
POST {{baseUrl}}/api/observability/reset

### 18. GDPR-style purge of a transcript
DELETE {{baseUrl}}/api/conversations/{{conversationId}}

### ============================================================================
### curl equivalents — the diagnostics used in Chapter 16 of the guide
### ============================================================================
### Watch the wire live, byte by byte (bypasses browsers AND proxies):
# curl -N -X POST 'http://localhost:8090/api/chat/stream?transport=text' \
#   -H 'Content-Type: application/json' -d '{"message":"hi"}'
#
### Prove the response is chunked and NOT content-length framed:
# curl -sD - -o /dev/null -X POST 'http://localhost:8090/api/chat/stream?transport=ndjson' \
#   -H 'Content-Type: application/json' -d '{"message":"hi"}'
#
### Count how many network reads a single answer produced (expect ≫ 1):
# curl -sN -X POST 'http://localhost:8090/api/chat/stream?transport=sse' \
#   -H 'Content-Type: application/json' -d '{"message":"hi"}' | grep -c '^event: delta'
#
### Watch cancellation propagate: Ctrl+C mid-answer, then check the server log for
### a `stream.aborted` telemetry line with finishReason "client_abort".
```


---

## 3. Block-by-Block Explanation

### Part A: Reading `test-requests.http` as a test plan

#### Block 1: The collection is ordered like a story

```http
### 4. ❌ BUFFERED baseline — one JSON body, TTFT is internal only
POST {{baseUrl}}/api/chat

### 5. ✅ STREAMING over NDJSON (one JSON envelope per line)
POST {{baseUrl}}/api/chat/stream?transport=ndjson

### 6. ✅ STREAMING over SSE (named events, ids, heartbeats)
POST {{baseUrl}}/api/chat/events

### 7. ✅ STREAMING as RAW text/plain (the PDF/Tomato pattern — no framing at all)
POST {{baseUrl}}/api/chat/stream?transport=text
```

- **What it does:** walks the reader from the buffered baseline through all three progressive transports.
- **How it works:** the ordering is deliberate. Case 4 shows the "everything at once" experience (and the response reports the internal TTFT so the difference is provable); cases 5–7 show the same pipeline over three wire formats. Cases 8–10 then vary *granularity* and inject *chaos*, and cases 11–18 exercise the control plane (cancel, catch-up, transcripts, budget, telemetry, purge).

#### Block 2: The chaos cases are the valuable ones

```http
### 9. Chaos: mid-stream provider failure ⇒ IN-BAND `error` frame + partial text kept
{ "message": "This answer will be cut off mid-stream.",
  "conversationId": "conv_demo_error",
  "chaos": { "failAfterDeltas": 3, "failCode": "provider_error" } }

### 10. Chaos: silent provider ⇒ idle watchdog (`upstream_stall`) + heartbeats
{ "message": "This answer will stall.",
  "conversationId": "conv_demo_stall",
  "chaos": { "stallAfterDeltas": 2, "stallMs": 40000 } }
```

- **What it does:** lets anyone reproduce the two hardest production failures in one request.
- **How it works:** case 9 makes the provider fail *after* three deltas — the status line is already `200`, so the failure must arrive as an `event: error` frame followed by `done{status:"interrupted"}`, and the partial text must be persisted. Case 10 makes the provider go silent for 40 s while the idle watchdog (30 s default) closes the stream with `upstream_stall`, emitting heartbeats in the meantime.

---

### Part B: The curl diagnostics (bypassing the browser)

#### Block 3: Watch the wire

```bash
curl -N -X POST 'http://localhost:8090/api/chat/stream?transport=text' \
  -H 'Content-Type: application/json' -d '{"message":"hi"}'
```

- **What it does:** shows the raw bytes as they arrive, with no buffering client in the way.
- **How it works:** `-N` disables curl's own output buffering. This is the first diagnostic from §6.3: it validates "the backend forwards" (invariant 1) and "the response flushes per chunk" (invariant 2). It cannot validate the proxy, the browser or the renderer — which is exactly the notes' point about "it works in my terminal".

#### Block 4: Prove it is chunked, not content-length framed

```bash
curl -sD - -o /dev/null -X POST 'http://localhost:8090/api/chat/stream?transport=ndjson' \
  -H 'Content-Type: application/json' -d '{"message":"hi"}'
```

- **What it does:** dumps the response headers without downloading the body.
- **How it works:** the expected output includes `Transfer-Encoding: chunked`, **no `Content-Length`**, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` and `Content-Encoding: identity`. If `Content-Length` is present, something on the path buffered the response — the single most useful five-second check in streaming operations.

#### Block 5: Count the frames, then watch cancellation propagate

```bash
curl -sN -X POST 'http://localhost:8090/api/chat/stream?transport=sse' \
  -H 'Content-Type: application/json' -d '{"message":"hi"}' | grep -c '^event: delta'
```

- **What it does:** counts how many deltas a single answer produced.
- **How it works:** a result of `1` means buffering; a healthy answer reports double digits at the default granularity. Piping into `head` (as the smoke test does) also demonstrates cancellation: closing the pipe closes the socket, and the server logs a `stream.aborted` telemetry line with `finishReason: "client_abort"` — visible proof that cancellation reaches the provider.

---

### Part C: The production checklist (from §10.2)

| # | Requirement | Verified by |
| :--- | :--- | :--- |
| 1 | Proxy buffering disabled | `X-Accel-Buffering: no` in the header dump; staging test with the real proxy |
| 2 | Compression excluded from the stream | `Content-Encoding: identity`; no compression middleware in `app.ts` |
| 3 | Idle timeout > longest gap between chunks | `STREAM_IDLE_TIMEOUT_MS` > provider p99 ITL; heartbeat cadence below it |
| 4 | Heartbeats every 10–15 s | Chaos case 10 shows heartbeats during a stall |
| 5 | Correct headers | `curl -sD -` output above |
| 6 | Backend returns a stream type, not `String` | `StreamProvider.stream(): Promise<AsyncIterable<…>>` |
| 7 | No collector operators on the streaming path | the `chunkCount > 2` assertion |
| 8 | Cancellation propagates | `test:cancel` + the `stream_aborts_total` metric |
| 9 | Per-request buffer + persist on completion | `test:cancel` asserts exactly one message |
| 10 | Partial failures persisted as `interrupted` | `test:cancel` asserts status + finish reason |
| 11 | Conversation-scoped state + lock | 409 on a concurrent turn; `inflight_streams` drains to 0 |
| 12 | Rate limits per user/conversation | `MAX_CONCURRENT_STREAMS_*` → 409/429 |
| 13 | Output caps | `AI_MAX_OUTPUT_TOKENS` |
| 14 | Retries only before the first token | `openProviderStream` runs before `writeHead` |
| 15 | Provider failover slot | `providers/index.ts` |
| 16 | Payload limits before dispatch | `HISTORY_TOKEN_BUDGET` → 413 |
| 17 | Secrets server-side only | keys never reach the client; two-tier log redaction |
| 18 | Observability: TTFT, ITL, chunks, aborts, in-band errors | `/metrics` + `/api/observability` |
| 19 | The TTFT-gap alert | `p95(clientTTFT − serverTTFT) > TTFT_GAP_ALERT_MS` |
| 20 | Fragmentation-invariance test in CI | `test:invariants` section 3 |

---

### Part D: The five-minute acceptance run

```bash
# 1. Build and unit-level checks
npm install && npm run build && npm run test:utf8

# 2. Boot and confirm the surface
npm run dev &
curl -s localhost:8090/health
curl -s localhost:8090/ | grep -o '<title>.*</title>'

# 3. Prove progressive delivery on the wire
curl -sN -X POST 'localhost:8090/api/chat/stream?transport=ndjson' \
  -H 'Content-Type: application/json' -d '{"message":"Explain streaming"}' | head -6
curl -sN -X POST 'localhost:8090/api/chat/stream?transport=sse' \
  -H 'Content-Type: application/json' -d '{"message":"Explain streaming"}' | grep -c '^event: delta'

# 4. Prove the headers
curl -sD - -o /dev/null -X POST 'localhost:8090/api/chat/stream?transport=ndjson' \
  -H 'Content-Type: application/json' -d '{"message":"hi"}' \
  | grep -iE 'transfer-encoding|content-length|x-accel|cache-control'

# 5. Prove the failure semantics
npm run test:invariants && npm run test:cancel

# 6. Open the UI, tick ❌ anti-pattern mode, and watch client TTFT become the total time.
```

- **What it does:** is the ordered acceptance run for this codebase, from unit checks to the browser.
- **How it works:** steps 3–4 verify the delivery path without a browser; step 5 verifies failure semantics; step 6 verifies the experience. If step 3 returns a single chunk, or step 4 shows `Content-Length`, stop and fix the delivery path — nothing else matters until that is right.

---

### Part E: Troubleshooting matrix

| Symptom | Most likely cause | Check |
| :--- | :--- | :--- |
| Everything appears at once | `await response.text()` in the client, or a buffering middleware/proxy | client code; `curl -sD -` for `Content-Length`; `X-Accel-Buffering` |
| Works locally, fails in staging | proxy buffering or compression re-enabled | `proxy_buffering off`; exclude `text/event-stream` from gzip/brotli |
| Stream dies at a suspiciously round time | an intermediary idle timeout shorter than the heartbeat cadence | `STREAM_HEARTBEAT_MS` < every timeout in the path |
| `` characters appear in the text | a new `TextDecoder` per chunk, or no final flush | exactly one decoder with `{ stream: true }` |
| SSE events never fire in the browser | missing blank line between events, or a missing `data:` line | `curl -N` and compare with the grammar in Chapter 05 |
| A duplicated sentence mid-answer | a retry happened *after* the first token | retry must live before `writeHead` |
| Provider bill exceeds session counts | cancellation not propagated (zombie generations) | `stream.aborted` log lines; `stream_aborts_total` |
| A conversation becomes permanently unusable | a leaked lock after a crash | lock release in `finally`; `inflight_streams` at idle |
| History grows faster than expected | fragments stored as messages | one assistant message per turn in the transcript |
| Cost dashboard disagrees with reality | chunk counts used as token counts | provider usage (`include_usage: true`) |

---

**Previous:** [Chapter 15 — Verification Scripts & Testing](./15_Verification_Scripts_and_Testing.md) · **Next:** [Consolidated Master Guide](./Complete_Implementation_Guide.md)



---

**Previous:**  · **Next:** [Consolidated Master Guide](./Complete_Implementation_Guide.md)
