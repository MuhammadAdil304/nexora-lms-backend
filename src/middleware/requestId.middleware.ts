import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { logger, createChildLogger } from "../utils/logger";

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: ReturnType<typeof createChildLogger>;
    }
  }
}

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  const requestId = (request.headers["x-request-id"] as string) ?? uuidv4();
  request.id = requestId;
  request.log = createChildLogger({ requestId, method: request.method, path: request.path });

  response.setHeader("X-Request-ID", requestId);

  const startTime = Date.now();
  response.on("finish", () => {
    const duration = Date.now() - startTime;
    request.log.info(
      { statusCode: response.statusCode, durationMs: duration },
      "Request completed"
    );
  });

  next();
}

export function errorLoggingMiddleware(
  error: Error,
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  request.log?.error({ err: error, stack: error.stack }, "Unhandled error");
  next(error);
}