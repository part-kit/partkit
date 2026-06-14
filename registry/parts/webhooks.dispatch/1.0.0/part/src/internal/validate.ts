import { DispatchError } from "./errors";
import type { DispatchInput, RegisterEndpointInput } from "./types";

const MAX_FIELD = 512;
const MAX_URL = 2048;
const MAX_EVENT_TYPE = 256;
const MAX_EVENT_TYPES = 64;
const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB — bound what we sign/store/send

function badInput(detail: string): DispatchError {
  return new DispatchError("invalid_payload", detail);
}

export interface ValidatedRegister {
  ownerId: string;
  url: string;
  eventTypes: string[] | null;
}

/** Validate registerEndpoint input shape. The URL's scheme + SSRF check is async
 *  and runs in the store; here we only check it is a bounded parseable string. */
export function validateRegister(input: RegisterEndpointInput): ValidatedRegister {
  if (input === null || typeof input !== "object") {
    throw badInput("registerEndpoint requires an input object");
  }
  if (typeof input.ownerId !== "string" || input.ownerId.trim() === "") {
    throw badInput("ownerId is required and must be a non-empty string");
  }
  if (input.ownerId.length > MAX_FIELD) throw badInput(`ownerId exceeds ${MAX_FIELD} characters`);

  if (typeof input.url !== "string" || input.url.trim() === "") {
    throw new DispatchError("invalid_url", "url is required and must be a non-empty string");
  }
  if (input.url.length > MAX_URL) {
    throw new DispatchError("invalid_url", `url exceeds ${MAX_URL} characters`);
  }

  let eventTypes: string[] | null = null;
  if (input.eventTypes !== undefined && input.eventTypes !== null) {
    if (!Array.isArray(input.eventTypes)) throw badInput("eventTypes must be an array of strings");
    if (input.eventTypes.length > MAX_EVENT_TYPES) {
      throw badInput(`eventTypes may not exceed ${MAX_EVENT_TYPES} entries`);
    }
    const seen = new Set<string>();
    for (const t of input.eventTypes) {
      if (typeof t !== "string" || t.trim() === "") throw badInput("each eventType must be a non-empty string");
      if (t.length > MAX_EVENT_TYPE) throw badInput(`an eventType exceeds ${MAX_EVENT_TYPE} characters`);
      seen.add(t);
    }
    eventTypes = [...seen].sort();
  }

  return { ownerId: input.ownerId, url: input.url, eventTypes };
}

export interface ValidatedDispatch {
  endpointId: string;
  eventType: string;
  payloadJson: string;
  idempotencyKey: string | null;
}

/** Validate dispatch input and serialize the payload to the EXACT bytes we sign. */
export function validateDispatch(input: DispatchInput): ValidatedDispatch {
  if (input === null || typeof input !== "object") {
    throw badInput("dispatch requires an input object");
  }
  if (typeof input.endpointId !== "string" || input.endpointId.trim() === "") {
    throw badInput("endpointId is required and must be a non-empty string");
  }
  if (input.endpointId.length > MAX_FIELD) throw badInput("endpointId is not a valid id");

  if (typeof input.eventType !== "string" || input.eventType.trim() === "") {
    throw badInput("eventType is required and must be a non-empty string");
  }
  if (input.eventType.length > MAX_EVENT_TYPE) throw badInput(`eventType exceeds ${MAX_EVENT_TYPE} characters`);

  if (input.payload === undefined) throw badInput("payload is required");
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(input.payload);
  } catch (e) {
    throw badInput(`payload is not JSON-serializable: ${e instanceof Error ? e.message : "?"}`);
  }
  if (payloadJson === undefined) throw badInput("payload is not JSON-serializable");
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw badInput(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes when serialized`);
  }

  let idempotencyKey: string | null = null;
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "") {
      throw badInput("idempotencyKey must be a non-empty string when provided");
    }
    if (input.idempotencyKey.length > MAX_FIELD) throw badInput("idempotencyKey is too long");
    idempotencyKey = input.idempotencyKey;
  }

  return { endpointId: input.endpointId, eventType: input.eventType, payloadJson, idempotencyKey };
}

/** A messageId for listAttempts — bounded, non-empty. */
export function validateMessageId(messageId: unknown): string {
  if (typeof messageId !== "string" || messageId.trim() === "") {
    throw badInput("messageId is required and must be a non-empty string");
  }
  if (messageId.length > MAX_FIELD) throw badInput("messageId is not a valid id");
  return messageId;
}
