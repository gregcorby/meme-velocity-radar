import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { startGrpcWorker } from "./grpcStream";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Build a compact, sanitized summary instead of dumping the full JSON body
// into the log line. Big radar payloads can be 50–200KB and were spamming
// the Railway log pipeline; we now log only status + tiny summary fields.
function summarizeResponseBody(path: string, body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const obj = body as Record<string, unknown>;
  if (path.startsWith("/api/radar")) {
    const tokens = Array.isArray((obj as any).tokens) ? (obj as any).tokens.length : 0;
    const sources = Array.isArray((obj as any).sourceHealth) ? (obj as any).sourceHealth.length : 0;
    const grpc = (obj as any).grpc;
    const grpcSummary = grpc
      ? `grpc=${grpc.status}/${grpc.candidateCount ?? 0}c/${grpc.eventsPerMinute ?? 0}epm`
      : "";
    return `tokens=${tokens} sources=${sources}${grpcSummary ? ` ${grpcSummary}` : ""}`;
  }
  if (path.startsWith("/api/grpc/status")) {
    return `status=${(obj as any).status} candidates=${(obj as any).candidateCount ?? 0} epm=${(obj as any).eventsPerMinute ?? 0} events=${(obj as any).eventsReceived ?? 0}`;
  }
  if (path.startsWith("/api/svs/health")) {
    return `overall=${(obj as any).overall} api=${(obj as any).api?.status} rpc=${(obj as any).rpc?.status} grpc=${(obj as any).grpc?.status}`;
  }
  if (typeof (obj as any).message === "string") {
    const msg = String((obj as any).message);
    return `message=${msg.length > 120 ? msg.slice(0, 117) + "..." : msg}`;
  }
  return "";
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: unknown = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      const summary = summarizeResponseBody(path, capturedJsonResponse);
      if (summary) logLine += ` :: ${summary}`;
      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  // reusePort is not supported on macOS (ENOTSUP); only enable on Linux.
  const listenOpts: { port: number; host: string; reusePort?: boolean } = {
    port,
    host: "0.0.0.0",
  };
  if (process.platform === "linux") listenOpts.reusePort = true;
  httpServer.listen(
    listenOpts,
    () => {
      log(`serving on port ${port}`);
      try {
        const result = startGrpcWorker();
        if (result.started) {
          log("gRPC worker started", "grpc");
        } else {
          log(`gRPC worker not started: ${result.reason ?? "unknown"}`, "grpc");
        }
      } catch (error) {
        log(
          `gRPC worker failed to start: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "grpc",
        );
      }
    },
  );
})();
