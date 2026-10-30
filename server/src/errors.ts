import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

/** Every non-2xx response has the shape { error: { code, message, details? } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_error",
        message: "Request body is invalid",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }
  // body-parser marks malformed JSON with type 'entity.parse.failed'
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "malformed_json", message: "Body is not valid JSON" } });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: { code: "payload_too_large", message: "Body too large" } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
};
