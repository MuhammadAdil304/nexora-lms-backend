import { createApp } from "./app";
import { connectRedis } from "./config/redis";
import { logger } from "./utils/logger";

// Vercel/serverless entry point. Unlike server.ts this must NOT call
// app.listen() — the platform invokes the exported Express app per request.
// Redis stays an optional fast-path cache (the database is authoritative),
// so we kick off a background connect and never block a request on it.
void connectRedis().catch(() => {
  logger.warn("Redis unavailable in serverless runtime; falling back to DB checks");
});

const app = createApp();

export default app;
