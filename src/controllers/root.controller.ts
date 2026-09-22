import { Request, Response } from "express";

export function getRoot(_request: Request, response: Response): void {
  response.json({
    name: "LMS backend",
    status: "running",
  });
}
