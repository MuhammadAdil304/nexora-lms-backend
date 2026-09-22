import "dotenv/config";
import { createApp } from "./app";
import { database } from "./config/database";
import { connectRedis, disconnectRedis } from "./config/redis";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { cleanupExpiredTokens } from "./utils/tokens";

async function start(): Promise<void> {
  // Connect to Redis once at startup. Token helpers treat Redis as an
  // optional fast-path cache (the database is authoritative), so a failure
  // here must not prevent the API from booting — ioredis keeps retrying.
  try {
    await connectRedis();
  } catch (err) {
    logger.warn({ err }, "Redis unavailable at startup; retrying in background");
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(`LMS backend listening on port ${env.port}`);
  });

  // Periodically purge expired refresh tokens
  const cleanupTimer = setInterval(() => {
    cleanupExpiredTokens().catch((err) => logger.warn({ err }, "Token cleanup failed"));
  }, 6 * 60 * 60 * 1000);
  cleanupTimer.unref();

  async function shutdown(signal: string): Promise<void> {
    logger.info(`${signal} received. Shutting down...`);

    server.close();
    await database.end();
    await disconnectRedis();
    process.exit(0);
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
