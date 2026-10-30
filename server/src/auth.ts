import type { RequestHandler, Response } from "express";
import { ApiError } from "./errors.js";

/**
 * Resolves `Authorization: Bearer <token>` to a customer id from a static map.
 * Everything downstream scopes data by res.locals.customerId, so swapping this
 * for real JWT/session verification touches only this file.
 */
export function requireCustomer(tokens: Record<string, string>): RequestHandler {
  return (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
    const customerId = match ? tokens[match[1]!] : undefined;
    if (!customerId) {
      res.set("WWW-Authenticate", 'Bearer realm="checkout"');
      throw new ApiError(401, "unauthorized", "Missing or invalid bearer token");
    }
    res.locals.customerId = customerId;
    next();
  };
}

export function customerIdOf(res: Response): string {
  return res.locals.customerId as string;
}
