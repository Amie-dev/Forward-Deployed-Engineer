# Chapter 2: LLM API Architecture & The Postman Protocol

> **Chapter Goal:** Demystify LLM communication by treating it as standard client-server HTTP networking, master the four invariant components of every LLM API request (Endpoint, Auth, Model, Input), analyze our first enterprise Forward Deployed Engineering case study (Support Ticket Triage), and construct a verified Postman prototype before writing code.

---

## 2.1 Demystifying LLM Communication: Standard HTTP Architecture

To newcomers, Artificial Intelligence often feels surrounded by mystery. When interacting with LLMs, many developers assume that communicating with a model requires esoteric protocols, low-level binary streams, or specialized hardware connections.

The reality of modern cloud AI is far simpler:

> **At the infrastructure and transport level, communicating with an LLM is simply an HTTP POST request.**

Whether you are using OpenAI, Anthropic, Google Gemini, Mistral, or a self-hosted open-weights model running on vLLM:
- You send an **HTTP request** carrying a JSON payload over TLS.
- The provider's server authenticates your request, routes it to an inference cluster, and executes a forward pass through the transformer weights.
- The server serializes the generated tokens into a **JSON response** and sends it back over HTTP.

```mermaid
sequenceDiagram
    autonumber
    participant Client as Application / Postman
    participant Gateway as Model Provider Gateway
    participant Inference as LLM Inference Cluster (GPUs)

    Client->>Gateway: HTTPS POST /v1/responses (Headers + JSON Body)
    Note over Gateway: 1. Validate API Key<br/>2. Check Rate Limits & Credits<br/>3. Route to Model Cluster
    Gateway->>Inference: Forward Request Payload (Token IDs)
    Note over Inference: 4. Autoregressive Forward Pass<br/>5. Generate Output Tokens
    Inference-->>Gateway: Output Token Stream
    Gateway-->>Client: HTTPS 200 OK (JSON Body with Generated Text + Metadata)
```

There is no difference in network architecture between an e-commerce microservice posting a payment (`POST /api/v1/payments`) and an application querying an LLM (`POST /v1/responses`). Recognizing this fundamental simplicity transforms GenAI from an intimidating black box into a standard software engineering domain.

---

## 2.2 The Four Invariant Components of an LLM API Request

From first principles, every API call made to an LLM provider—regardless of the vendor or SDK—must supply four essential pieces of information:

```mermaid
flowchart TD
    Req["HTTP REQUEST"]
    
    Req -->|"1. Endpoint"| C1["WHERE is the request going?"]
    Req -->|"2. API Key / Auth"| C2["WHO is making the request?"]
    Req -->|"3. Model"| C3["WHICH engine should process it?"]
    Req -->|"4. Input"| C4["WHAT should the engine process?"]

    C1 --- V1["URL: https://api.openai.com/v1/responses"]
    C2 --- V2["Header: Authorization: Bearer sk-..."]
    C3 --- V3["JSON Field: 'model': 'gpt-5-mini'"]
    C4 --- V4["JSON Field: 'input': 'Summarize ticket...'"]
```

### 1. Endpoint (Where?)
The network address identifying the specific service and API version.
- **Example:** `https://api.openai.com/v1/responses` or `https://api.openai.com/v1/chat/completions`
- The endpoint tells the cloud router which service pipeline will handle the incoming payload.

### 2. Authentication (Who?)
Inference on large models requires tens of gigabytes of high-bandwidth GPU memory (H100/A100 clusters) and immense electrical power. Providers cannot offer anonymous access; they must identify the tenant, verify billing status, and enforce rate limits.
- **Example:** HTTP Header: `Authorization: Bearer <API_KEY>`
- **Security Rule:** API credentials must be treated like production database passwords. Never hard-code them in source code or commit them to version control.

### 3. Model Identifier (Which Engine?)
Foundation model vendors do not offer a single monolithic model. They maintain a fleet of models optimized across different Pareto frontiers:

| Model Tier | Primary Optimizations | Typical Use Cases | Trade-offs |
| :--- | :--- | :--- | :--- |
| **Flagship / Reasoning** (e.g., GPT-5, Claude 3.5 Sonnet, o1) | Maximum reasoning, complex logic, multi-step problem solving | Architecture design, complex code debugging, legal document synthesis | Higher cost per token, higher latency |
| **Mini / Efficient** (e.g., GPT-5-mini, Claude 3.5 Haiku, Gemini Flash) | High throughput, ultra-low latency, budget efficiency | Support ticket summarization, classification, entity extraction, data tagging | Reduced reasoning depth on complex math/logic |

Your request must explicitly specify which model name to instantiate for the job:
```json
{
  "model": "gpt-5-mini"
}
```

### 4. Input Payload (What to Process?)
The text, prompt instructions, and context supplied to the model.
```json
{
  "input": "Summarize this support ticket in two sentences..."
}
```
This raw string is ingested by the model's tokenizer, converted into numerical token vectors, and passed into the transformer's attention layers.

---

## 2.3 The First FDE Problem: Enterprise Support Ticket Triage

To ground these concepts in realistic engineering, we examine an authentic enterprise problem introduced in the lecture:

### The Business Scenario
You are deployed as a **Forward Deployed Engineer (FDE)** to a high-growth B2B SaaS enterprise. The customer support engineering queue is overwhelmed. Hundreds of verbose, panic-driven incident reports arrive daily from enterprise clients. 

Triage engineers waste 5–10 minutes reading through each lengthy ticket simply to figure out which microservice team to page.

Consider an incoming support ticket submitted by an enterprise customer:

```text
Hi team,

Our production deployment has failed three times since yesterday.
It looks like the payment-service container keeps restarting.
Customers are occasionally getting 502 errors during checkout.

We already tried restarting the deployment manually but the issue
returned after approximately twenty minutes.
Can someone investigate urgently?
```

### The FDE Solution Objective
Build an automated ingestion microservice that intercepts new support tickets, submits them to an LLM, generates an exact **two-line executive summary**, and attaches it to the engineering Slack alert:

```text
Desired Output:
"Production payment-service is repeatedly restarting and causing intermittent 502 errors. 
Manual restarts only temporarily resolve the issue."
```

Before writing any Java, Spring, or microservice code, an experienced FDE always validates the raw API interaction using **Postman**.

---

## 2.4 Talking to the Model Using Postman

Postman is an industry-standard API client that allows engineers to inspect raw HTTP requests and responses without framework overhead.

```mermaid
flowchart LR
    PM["Postman Client\n(Headers + Bearer Auth + JSON Payload)"] 
    -->|"HTTPS POST /v1/responses"| API["OpenAI API Gateway"]
    API -->|"Tokenized Prompt"| LLM["Transformer Inference"]
    LLM -->|"Generated Tokens"| API
    API -->|"HTTP 200 OK (JSON)"| PM
```

### Step 1: Obtain API Key
Generate a secret developer API key from the provider's developer console (e.g., `platform.openai.com/api-keys`). Store this key securely in a local password manager or local environment variable.

### Step 2: Create the HTTP Request in Postman
1. Open Postman $\rightarrow$ Click **New** $\rightarrow$ **HTTP Request**.
2. Select HTTP Method: **`POST`**.
3. Enter the Request URL:
   ```
   https://api.openai.com/v1/responses
   ```

### Step 3: Configure Authentication
1. Click the **Authorization** tab.
2. Select **Type: Bearer Token**.
3. Paste your secret key into the **Token** field.

Under the hood, Postman injects the standard HTTP header:
```http
Authorization: Bearer sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Step 4: Configure Headers & Content-Type
In the **Headers** tab, ensure the content type is declared:
```http
Content-Type: application/json
```

### Step 5: Construct the JSON Request Body
1. Select the **Body** tab.
2. Choose **raw** and set the format to **JSON**.
3. Enter the request payload:

```json
{
  "model": "gpt-5-mini",
  "input": "Summarize this support ticket in two sentences:\n\nOur production deployment has failed three times since yesterday. It looks like the payment-service container keeps restarting. Customers are occasionally getting 502 errors. We already tried restarting the deployment manually but the issue returned after approximately twenty minutes. Can someone investigate urgently?"
}
```

### The Equivalent `curl` Command
If executing from a terminal, this corresponds to:

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-5-mini",
    "input": "Summarize this support ticket in two sentences: Our production deployment has failed three times since yesterday..."
  }'
```

---

## 2.5 Request Lifecycle: What Happens After You Click Send?

When you press **Send** in Postman, an intricate chain of distributed systems executes across the public cloud:

```mermaid
flowchart TD
    A["1. Postman formats HTTP POST Request"] --> B["2. TLS Handshake & HTTPS Transit"]
    B --> C["3. Provider API Gateway / Reverse Proxy"]
    
    subgraph GatewayChecks["Gateway Validation"]
        C --> D1["Validate Bearer Token & Organization ID"]
        D1 --> D2["Verify Account Quota & Rate Limit (RPM / TPM)"]
        D2 --> D3["Check Payload JSON Schema & Model Availability"]
    end

    D3 --> E["4. Dispatch to Inference Cluster Routing Layer"]
    
    subgraph ModelExecution["Model GPU Inference"]
        E --> F1["Tokenization: Raw Text -> Input Token IDs"]
        F1 --> F2["Prompt Evaluation (Parallel Matrix Multiplication)"]
        F2 --> F3["Autoregressive Generation (Iterative Next-Token Prediction)"]
        F3 --> F4["Stop Condition Met (<|endoftext|> or max_tokens reached)"]
        F4 --> F5["Detokenization: Output Token IDs -> UTF-8 String"]
    end

    F5 --> G["5. Serialize JSON Response (Content + Metadata + Token Usage)"]
    G --> H["6. HTTP 200 OK returned to Postman"]
```

### Detailed Execution Steps:
1. **Serialization & Transport:** Postman serializes the JSON string and transmits it over an encrypted TCP/TLS socket to the provider's IP address.
2. **Gateway Authentication:** The cloud edge proxy verifies the cryptographic signature of the Bearer token and checks if the developer account has sufficient credit balance.
3. **Rate Limiting:** The gateway checks whether the current request exceeds Requests Per Minute (RPM) or Tokens Per Minute (TPM) quotas.
4. **Model Cluster Routing:** The request is queued and dispatched to an inference node containing the loaded model weights in GPU VRAM.
5. **Tokenization:** The input text string is converted into discrete numerical token IDs using a subword tokenizer (such as Byte-Pair Encoding).
6. **Transformer Forward Pass:** The model processes all input tokens in parallel to generate the initial KV cache.
7. **Autoregressive Decoding:** The model iteratively predicts next tokens one by one until a stop token is sampled.
8. **JSON Assembly:** The generated text is packaged alongside operational metadata and returned as an HTTP `200 OK` response.

By validating this entire flow in Postman, we have proven that our input prompt produces the desired 2-line summary. In the next chapter, we inspect the JSON response structure and analyze the engineering implications of token metrics.
