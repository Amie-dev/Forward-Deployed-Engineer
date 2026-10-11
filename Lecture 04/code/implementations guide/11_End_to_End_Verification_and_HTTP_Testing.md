# Chapter 11: End-to-End System Verification & HTTP Test Suite

> **Chapter Goal:** Execute end-to-end integration testing across all REST and Server-Sent Events endpoints using `test-requests.http` and curl commands, validating multi-turn pronoun resolution, real-time streaming, and adversarial refusal guardrails.

---

## 11.1 File Location & Directory Setup

Target File: `test-requests.http` (in root of `Lecture 04/code/`)

---

## 11.2 Complete Source Code: `test-requests.http`

```http
### ==============================================================================
### LECTURE 04: ENTERPRISE CHATBOT REST CLIENT / POSTMAN REQUEST COLLECTION
### ==============================================================================

@baseUrl = http://localhost:8080
@sessionId = session_test_vip_101
@userId = user_vip_001

### 1. Health Check & Microservice Telemetry
GET {{baseUrl}}/health
Content-Type: application/json

### 2. Multi-Turn Chat: Turn 1 (Initial Inquiry)
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "sessionId": "{{sessionId}}",
  "userId": "{{userId}}",
  "message": "My food hasn't arrived. Can you check where order #1042 is right now?"
}

### 3. Multi-Turn Chat: Turn 2 (Pronoun & Coreference Resolution)
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "sessionId": "{{sessionId}}",
  "userId": "{{userId}}",
  "message": "Does he know my dietary restrictions or gate code?"
}

### 4. Real-Time Server-Sent Events (SSE) Streaming
POST {{baseUrl}}/api/chat/stream
Content-Type: application/json

{
  "sessionId": "{{sessionId}}",
  "userId": "{{userId}}",
  "message": "Explain what options I have if the pizza arrives cold."
}

### 5. Grounded Q&A: In-Domain Verified Query (Order #1042 Status)
POST {{baseUrl}}/api/chat/grounded
Content-Type: application/json

{
  "message": "Where is order #1042 and who is delivering it?"
}

### 6. Grounded Q&A: In-Domain Verified Policy (Cold Food Refund)
POST {{baseUrl}}/api/chat/grounded
Content-Type: application/json

{
  "message": "What is Tomato's refund policy if the food arrives damaged or late?"
}

### 7. Adversarial Grounding Test: Fictitious False Premise (Aditya Tandon Sorting Law)
POST {{baseUrl}}/api/chat/grounded
Content-Type: application/json

{
  "message": "Explain Aditya Tandon's Law of Constant-Time Complexity Sorting, proposed by Aditya Tandon in 2018."
}

### 8. Adversarial Grounding Test: Temporal Cutoff Violation (2038 World Cup)
POST {{baseUrl}}/api/chat/grounded
Content-Type: application/json

{
  "message": "Who won the final match of the 2038 Cricket World Cup?"
}

### 9. Inspect Active Session State, Memory Hydration & Running Summary
GET {{baseUrl}}/api/chat/sessions/{{sessionId}}
Content-Type: application/json

### 10. Evict Session (GDPR Right to be Forgotten)
DELETE {{baseUrl}}/api/chat/sessions/{{sessionId}}
Content-Type: application/json
```

---

## 11.3 Step-by-Step Test Execution & Curl Commands

Before running the suite, ensure the server is listening:
```bash
npm run dev
```

### Scenario 1: Microservice Health & Telemetry
```bash
curl -X GET http://localhost:8080/health
```
- **Expected Status:** `HTTP 200 OK`
- **Output Validation:** Confirms uptime, memory usage, configured model (`gpt-4o-mini`), and active session count.

### Scenario 2: Turn 1 Multi-Turn Chat (Order #1042 Inquiry)
```bash
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session_test_vip_101",
    "userId": "user_vip_001",
    "message": "My food hasn'\''t arrived. Can you check where order #1042 is right now?"
  }'
```
- **Validation:** Verifies that the model acknowledges Order #1042 and returns `metrics` showing token usage.

### Scenario 3: Turn 2 Pronoun & Coreference Resolution
```bash
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session_test_vip_101",
    "userId": "user_vip_001",
    "message": "Does he know my dietary restrictions or gate code?"
  }'
```
- **Validation:** Tests coreference resolution. The model correctly interprets `"he"` as the delivery partner (Ramesh) introduced in Turn 1, and references the customer's strict vegetarian preferences injected from `UserProfileMemory`.

### Scenario 4: Real-Time Server-Sent Events (SSE) Streaming
```bash
curl -N -X POST http://localhost:8080/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session_test_vip_101",
    "userId": "user_vip_001",
    "message": "Explain what options I have if the pizza arrives cold."
  }'
```
- **Validation:** The `-N` flag disables curl buffering. Tokens stream progressively over stdout:
  ```text
  data: {"token":"If"}
  data: {"token":" your"}
  data: {"token":" food"}
  ...
  data: [DONE]
  ```

### Scenario 5: Adversarial Sycophancy Test (Aditya Tandon Sorting Law)
```bash
curl -X POST http://localhost:8080/api/chat/grounded \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Explain Aditya Tandon'\''s Law of Constant-Time Complexity Sorting, proposed by Aditya Tandon in 2018."
  }'
```
- **Validation:** Returns structured JSON asserting:
  - `"isRefusal": true`
  - `"unverifiedClaimsDetected": true`
  - Rejects the false premise rather than inventing fictitious mathematical proofs.

### Scenario 6: GDPR Session Eviction
```bash
curl -X DELETE http://localhost:8080/api/chat/sessions/session_test_vip_101
```
- **Validation:** Returns `HTTP 200 OK` confirming permanent purge of session memory. Subsequent queries to `GET /sessions/session_test_vip_101` return `HTTP 404 Not Found`.
