import { Request, Response } from "express";
import { database } from "../config/database";

export async function getHealth(_request: Request, response: Response): Promise<void> {
  try {
    await database.query("SELECT 1");
    response.json({
      server: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("Database health check failed:", error);
    response.status(503).json({
      server: "ok",
      database: "disconnected",
    });
  }
}
