import mysql, { ExecuteValues, FieldPacket, PoolConnection, QueryResult, QueryValues } from "mysql2/promise";
import { env } from "./env";
import { logger } from "../utils/logger";

const pool = mysql.createPool({
  host: env.database.host,
  port: env.database.port,
  user: env.database.user,
  password: env.database.password,
  database: env.database.name,
  waitForConnections: true,
  connectionLimit: env.database.connectionLimit,
  ssl: env.database.ssl,
  // TiDB Cloud's gateway silently drops idle TCP connections. Without
  // keep-alive the pool hands out dead connections and the first query on
  // them fails with `read ECONNRESET` after a long stall.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  // TiDB stores DATETIME/TIMESTAMP in UTC. Without this, mysql2 parses the
  // returned strings in the server's local timezone, so every serialized
  // date is offset (e.g. notifications permanently showing "5h ago").
  timezone: "Z",
});

/** Errors that indicate the pooled connection died, not the query itself. */
function isStaleConnection(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  if (!err) return false;
  return (
    err.code === "PROTOCOL_CONNECTION_LOST" ||
    err.code === "ECONNRESET" ||
    err.code === "ETIMEDOUT" ||
    err.code === "ER_CONNECTION_KILLED" ||
    err.message === "Connection is closed."
  );
}

const SELECT_ONLY = /^\s*select\b/i;

/**
 * `pool.execute` with a single transparent retry for *read* queries that hit
 * a stale pooled connection. Writes are never retried because the server may
 * have applied them before the connection dropped.
 */
async function execute<T extends QueryResult>(
  sql: string,
  values?: ExecuteValues,
): Promise<[T, FieldPacket[]]> {
  try {
    return await pool.execute<T>(sql, values);
  } catch (error) {
    if (isStaleConnection(error) && SELECT_ONLY.test(sql)) {
      logger.warn("Query hit a stale database connection; retrying once");
      return pool.execute<T>(sql, values);
    }
    throw error;
  }
}

async function query<T extends QueryResult>(
  sql: string,
  values?: QueryValues,
): Promise<[T, FieldPacket[]]> {
  try {
    return await pool.query<T>(sql, values);
  } catch (error) {
    if (isStaleConnection(error) && SELECT_ONLY.test(sql)) {
      logger.warn("Query hit a stale database connection; retrying once");
      return pool.query<T>(sql, values);
    }
    throw error;
  }
}

export const database = {
  execute,
  query,
  getConnection: (): Promise<PoolConnection> => pool.getConnection(),
  end: () => pool.end(),
};
