# Chapter 15: End-to-End Verification and HTTP Testing

## 1. Overview & File Metadata
- **Target File Path**: `Lecture 05/code/test-requests.http`
- **Format**: RFC 7230 / RFC 2616 HTTP Request Specification (VS Code REST Client / JetBrains HTTP Client)
- **Key Responsibilities**:
  1. Provides a comprehensive suite of 9 integration test requests covering every operational scenario taught in Lecture 05.
  2. Verifies service health, sequential multi-tool chaining, parallel tool dispatch, autonomous website generation, and Human-in-the-Loop approval workflows.
  3. Can be executed directly from IDEs (VS Code with REST Client extension or JetBrains IDEs) or translated into equivalent `curl` commands.

### Terminal Verification (Running the HTTP Server)
Before testing requests, start the server in a terminal:
```bash
# Start server on port 8080 (or PORT configured in .env)
npm run dev
```

---

## 2. Complete Source Code

```http
### Variables
@baseUrl = http://localhost:8080

### 1. Health Check
GET {{baseUrl}}/health
Accept: application/json

### 2. Multi-Tool Chat: Sequential Chaining (USD to INR then Divide)
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "message": "Convert $120 into Indian rupees and then divide that amount equally among 6 people."
}

### 3. Multi-Tool Chat: Parallel Dispatch (Delhi Weather + USD Currency Conversion)
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "message": "I am travelling to Delhi. What is the current weather there, and how much is $500 in Indian rupees?"
}

### 4. Autonomous Website Builder: BrewLab Coffee Shop
POST {{baseUrl}}/api/generate-site
Content-Type: application/json

{
  "prompt": "Create a premium landing page for a coffee shop called BrewLab. Use a dark elegant design with a hero section, featured coffees, customer testimonials and a contact section."
}

### 5. Autonomous Website Builder: NeuralForge AI Robotics
POST {{baseUrl}}/api/generate-site
Content-Type: application/json

{
  "prompt": "Create a futuristic landing page for a company called NeuralForge that builds AI robots. Use a dark space-like design with glowing cards and subtle animations."
}

### 6. Critical Action Tool: High-Value Refund (Triggers HITL Pause)
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "message": "Please process a refund of ₹50,000 for customer order ORD-50001 due to late shipment."
}

### 7. Inspect Pending Human Approvals Queue
GET {{baseUrl}}/api/approvals
Accept: application/json

### 8. Webhook: Approve Pending Refund Ticket
POST {{baseUrl}}/api/agent/resume
Content-Type: application/json

{
  "ticketId": "TICK-XXXXXX",
  "action": "approve",
  "reviewedBy": "Support Manager John Doe",
  "rejectionReason": ""
}

### 9. Webhook: Reject Pending Refund Ticket
POST {{baseUrl}}/api/agent/resume
Content-Type: application/json

{
  "ticketId": "TICK-XXXXXX",
  "action": "reject",
  "reviewedBy": "Compliance Officer Alice",
  "rejectionReason": "Refund requested 60 days past policy return window."
}
```

---

## 3. Block-by-Block Request Explanation

### Request 1: Health Check (`GET /health`)
```http
### 1. Health Check
GET {{baseUrl}}/health
Accept: application/json
```
- **What this request does**:
  - Pings the liveness endpoint to confirm that Express is running, ports are listening, and environment variables are active.
- **Expected Response**:
```json
{
  "status": "healthy",
  "timestamp": "2026-10-12T08:00:00.000Z",
  "service": "Lecture 05 Autonomous AI Agent Service",
  "model": "gpt-4o",
  "workspace": "./generated-sites"
}
```
- **Equivalent `curl` Command**:
```bash
curl -X GET http://localhost:8080/health -H "Accept: application/json"
```

---

### Request 2: Multi-Tool Sequential Dependency Chaining
```http
### 2. Multi-Tool Chat: Sequential Chaining (USD to INR then Divide)
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "message": "Convert $120 into Indian rupees and then divide that amount equally among 6 people."
}
```
- **What this request does**:
  - Tests the agent's ability to recognize data dependencies across multi-turn reasoning loops.
- **How it works**:
  - The model realizes it cannot divide until it knows the rupee value of $120.
  - Step 1: Dispatches `convertCurrency({ amount: 120, from: 'USD', to: 'INR' })` $\rightarrow$ Result: `11,400 INR`.
  - Step 2: Dispatches `calculate({ operation: 'divide', a: 11400, b: 6 })` $\rightarrow$ Result: `1,900 INR`.
  - Step 3: Returns final synthesis to the user.
- **Equivalent `curl` Command**:
```bash
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Convert $120 into Indian rupees and then divide that amount equally among 6 people."}'
```

---

### Request 3: Parallel Tool Dispatch
```http
### 3. Multi-Tool Chat: Parallel Dispatch (Delhi Weather + USD Currency Conversion)
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "message": "I am travelling to Delhi. What is the current weather there, and how much is $500 in Indian rupees?"
}
```
- **What this request does**:
  - Verifies that the agent can emit multiple tool calls in a single assistant message when the operations are independent.
- **How it works**:
  - In Step 1, the LLM emits two parallel tool calls:
    1. `getCurrentWeather({ city: "Delhi" })`
    2. `convertCurrency({ amount: 500, from: "USD", to: "INR" })`
  - The execution engine executes both concurrently, appends both observation messages, and receives the final synthesized summary on turn 2.
- **Equivalent `curl` Command**:
```bash
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "I am travelling to Delhi. What is the current weather there, and how much is $500 in Indian rupees?"}'
```

---

### Requests 4 & 5: Autonomous Website Builder
```http
### 4. Autonomous Website Builder: BrewLab Coffee Shop
POST {{baseUrl}}/api/generate-site
Content-Type: application/json

{
  "prompt": "Create a premium landing page for a coffee shop called BrewLab. Use a dark elegant design with a hero section, featured coffees, customer testimonials and a contact section."
}

### 5. Autonomous Website Builder: NeuralForge AI Robotics
POST {{baseUrl}}/api/generate-site
Content-Type: application/json

{
  "prompt": "Create a futuristic landing page for a company called NeuralForge that builds AI robots. Use a dark space-like design with glowing cards and subtle animations."
}
```
- **What these requests do**:
  - Triggers the isolated `WebsiteBuilderService` to autonomously author complete, multi-file websites in the sandboxed filesystem.
- **How it works**:
  - The agent creates `./generated-sites/<sitename>`, followed by `index.html`, `style.css`, and `script.js`.
  - Once generated, you can open `http://localhost:8080/sites/brewlab/index.html` or `http://localhost:8080/sites/neuralforge/index.html` in Chrome/Firefox to view the live site.
- **Equivalent `curl` Command**:
```bash
curl -X POST http://localhost:8080/api/generate-site \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a premium landing page for a coffee shop called BrewLab. Use a dark elegant design with a hero section, featured coffees, customer testimonials and a contact section."}'
```

---

### Request 6: Critical Action Tool Triggering HITL Pause
```http
### 6. Critical Action Tool: High-Value Refund (Triggers HITL Pause)
POST {{baseUrl}}/api/chat
Content-Type: application/json

{
  "message": "Please process a refund of ₹50,000 for customer order ORD-50001 due to late shipment."
}
```
- **What this request does**:
  - Triggers the Tier 3 financial tool `refundCustomer` with an amount of ₹50,000 (exceeding the threshold).
- **How it works**:
  - The agent halts execution, creates an approval ticket, and returns HTTP 200 with `status: "paused_for_approval"` and `pendingApprovalTicketId: "TICK-XXXXXX"`.
- **Equivalent `curl` Command**:
```bash
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Please process a refund of ₹50,000 for customer order ORD-50001 due to late shipment."}'
```

---

### Request 7: Inspect Pending Human Approvals Queue
```http
### 7. Inspect Pending Human Approvals Queue
GET {{baseUrl}}/api/approvals
Accept: application/json
```
- **What this request does**:
  - Fetches the active list of approval tickets awaiting supervisory sign-off.
- **How it works**:
  - Allows human operators, security admins, or Slack bots to retrieve the generated `ticketId`.
- **Equivalent `curl` Command**:
```bash
curl -X GET http://localhost:8080/api/approvals -H "Accept: application/json"
```

---

### Requests 8 & 9: Supervisory Webhook Resumption (Approve / Reject)
```http
### 8. Webhook: Approve Pending Refund Ticket
POST {{baseUrl}}/api/agent/resume
Content-Type: application/json

{
  "ticketId": "TICK-XXXXXX",
  "action": "approve",
  "reviewedBy": "Support Manager John Doe",
  "rejectionReason": ""
}

### 9. Webhook: Reject Pending Refund Ticket
POST {{baseUrl}}/api/agent/resume
Content-Type: application/json

{
  "ticketId": "TICK-XXXXXX",
  "action": "reject",
  "reviewedBy": "Compliance Officer Alice",
  "rejectionReason": "Refund requested 60 days past policy return window."
}
```
- **What these requests do**:
  - Demonstrates asynchronous resumption of paused agent execution.
- **How it works**:
  - Replacing `TICK-XXXXXX` with the real ticket ID returned in Request 6 or 7 invokes `engine.resume()`.
  - If approved: the tool executes, the refund transaction is stamped, and the agent responds confirming payment reversal.
  - If rejected: the agent receives the supervisor's rejection rationale and explains the denial to the customer.
- **Equivalent `curl` Command**:
```bash
curl -X POST http://localhost:8080/api/agent/resume \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "TICK-XXXXXX", "action": "approve", "reviewedBy": "Support Manager John Doe"}'
```
