function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function numericEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`${name} must be a valid number`);
  }

  return parsedValue;
}

function parseCorsOrigins(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

export const env = {
  port: numericEnv("PORT", 5000),
  jwtSecret: requiredEnv("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "7d",
  corsOrigin: parseCorsOrigins(process.env.CORS_ORIGIN ?? "http://localhost:3000,http://127.0.0.1:3000"),
  database: {
    host: requiredEnv("DB_HOST"),
    port: numericEnv("DB_PORT", 3306),
    user: requiredEnv("DB_USERNAME"),
    password: requiredEnv("DB_PASSWORD"),
    name: requiredEnv("DB_DATABASE"),
    connectionLimit: numericEnv("DB_CONNECTION_LIMIT", 10),
    ssl: process.env.DB_SSL === "false" ? undefined : {},
  },
  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: numericEnv("REDIS_PORT", 6379),
    password: process.env.REDIS_PASSWORD ?? undefined,
    db: numericEnv("REDIS_DB", 0),
  },
};
