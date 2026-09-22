import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/http";
import { logger } from "../utils/logger";

export function notFoundHandler(
  request: Request,
  response: Response,
): void {
  logger.warn({ method: request.method, path: request.originalUrl }, "Route not found");
  response.status(404).json({
    success: false,
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `Route not found: ${request.method} ${request.originalUrl}`,
    },
  });
}

export function errorHandler(
  error: Error,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  // body-parser / express raise plain SyntaxErrors (and typed errors) for bad
  // request bodies. These are client errors (4xx), not server faults, so they
  // must not collapse into a 500.
  const raw = error as Error & {
    status?: number;
    statusCode?: number;
    type?: string;
    expose?: boolean;
  };
  const upstreamStatus = raw.statusCode ?? raw.status;
  const isBodyParseError =
    error instanceof SyntaxError || raw.type === "entity.parse.failed";

  let statusCode: number;
  let code: string;
  let message: string;

  if (error instanceof AppError) {
    statusCode = error.statusCode;
    code = error.code;
    message = error.message;
  } else if (isBodyParseError) {
    statusCode = 400;
    code = "INVALID_JSON_BODY";
    message = "Request body must be valid JSON";
  } else if (typeof upstreamStatus === "number" && upstreamStatus >= 400 && upstreamStatus < 500) {
    // Honour explicit client statuses (e.g. 413 payload too large).
    statusCode = upstreamStatus;
    code = raw.type && raw.type !== "entity.too.large" ? "BAD_REQUEST" : "REQUEST_ERROR";
    message = statusCode === 413 ? "Request payload is too large" : "Malformed or invalid request";
  } else {
    statusCode = 500;
    code = "INTERNAL_ERROR";
    message = "Internal server error";
  }

  const logData = {
    err: error,
    stack: error.stack,
    statusCode,
    code,
    path: request.path,
    method: request.method,
    requestId: request.id,
  };

  if (statusCode >= 500) {
    logger.error(logData, "Server error");
  } else if (statusCode >= 400) {
    logger.warn(logData, "Client error");
  }

  response.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
    },
  });
}
