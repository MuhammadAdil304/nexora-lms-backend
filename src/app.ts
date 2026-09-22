import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { requestIdMiddleware } from "./middleware/requestId.middleware";
import routes from "./routes/index.routes";

export function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet({
    // Pure JSON API: CSP is handled by the frontend app.
    contentSecurityPolicy: false,
  }));
  app.use(cors({
    origin: env.corsOrigin,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    optionsSuccessStatus: 204,
  }));
  // Raised from the 100kb default: thumbnails and assignment submissions are
  // uploaded as base64 data-URL links, which are inline in the JSON body.
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(morgan("dev"));
  app.use("/", routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
