import { NextFunction, Request, Response } from "express";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function sendSuccess(
  response: Response,
  data: unknown,
  statusCode = 200,
  message?: string,
): void {
  response.status(statusCode).json({
    success: true,
    ...(message ? { message } : {}),
    data,
  });
}

export function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => void | Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function parsePositiveId(value: string | string[] | undefined, name = "id"): number {
  const scalar = Array.isArray(value) ? value[0] : value;
  const parsed = Number(scalar);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(`${name} must be a positive integer`, 400, "INVALID_ID");
  }
  return parsed;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}
