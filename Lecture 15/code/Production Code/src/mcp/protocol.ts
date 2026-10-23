import { ProtocolError } from "@modelcontextprotocol/server";
import { jsonRpcCodeFor, type AppError } from "../core/errors.js";

/**
 * The server-side half of the wire adapter.
 *
 * A refusal raised by a handler has to survive a process boundary to be useful,
 * and on the way out it loses everything except what the protocol carries. So the
 * failure's **class** is encoded in the JSON-RPC error code — the one field the
 * wire preserves — and its **recovery sentence** goes into `data`.
 *
 * Why this matters more than it looks: without it, a missing prompt argument and
 * a crashed backend are indistinguishable to the host. Both arrive as an
 * unclassified error, both get answered `503`, and the caller is invited to retry
 * something that no number of retries can fix. Notes Ch07 §7.4 asks for failures
 * that *"fail loudly on an unknown prompt, a missing argument or an empty message
 * list"* — this is what makes "loudly" survive the trip.
 *
 * The numeric codes themselves live in `core/errors.ts`, not here, because they
 * are fixed by the JSON-RPC and MCP specifications rather than by this SDK. This
 * module's only job is to wrap them in the class the transport understands.
 */
export function toProtocolError(error: AppError): Error {
  return new ProtocolError(jsonRpcCodeFor(error.code), error.message, {
    // `data` is carried verbatim, so the host can hand the caller the *specific*
    // instruction the server wrote rather than a generic one it invented.
    recovery: error.recovery,
    failureCode: error.code,
    origin: error.origin,
    retryable: error.retryable,
  });
}
