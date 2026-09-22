import Redis from "ioredis";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export const redis = new Redis({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
  db: env.redis.db,
  retryStrategy: (times) => {
    // Exponential-ish backoff capped at 30s. A tight retry loop (the old
    // times*50ms) hammered a downed Redis and flooded the logs.
    return Math.min(times * 500, 30_000);
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
});

// Redis is an optional fast-path cache (the database is authoritative). While
// it is down, ioredis emits an "error" event on every retry; we log the first
// one and stay quiet until the connection recovers so the logs stay readable.
let redisDownLogged = false;

redis.on("connect", () => {
  if (redisDownLogged) {
    logger.info("Redis reconnected");
  }
});

redis.on("ready", () => {
  redisDownLogged = false;
  logger.info("Redis ready");
});

redis.on("error", (err) => {
  if (redisDownLogged) {
    return;
  }
  redisDownLogged = true;
  logger.warn({ err }, "Redis connection error (continuing without cache)");
});

redis.on("close", () => {
  // Only meaningful once we've previously reported being down; silent otherwise.
});

/**
 * Connect to Redis once at startup. Safe to call again if the connection
 * dropped — ioredis rejects `connect()` when a connection already exists,
 * so the status check below is required to avoid duplicate-connection errors.
 */
export async function connectRedis(): Promise<void> {
  if (redis.status === "ready" || redis.status === "connecting") {
    return;
  }
  await redis.connect();
}

export function isRedisReady(): boolean {
  return redis.status === "ready";
}

export async function disconnectRedis(): Promise<void> {
  if (redis.status === "end" || redis.status === "close") {
    return;
  }
  await redis.quit();
}
