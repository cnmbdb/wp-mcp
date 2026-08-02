import type { AppConfig, AuthMethod, TransportMode } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WP_URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/(wp-json\/?|)+$/, "").replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseContentTypes(): string[] {
  const values = (process.env.WP_CONTENT_TYPES ?? "posts,pages")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error("WP_CONTENT_TYPES cannot be empty");
  for (const value of values) {
    if (!/^[a-z0-9_-]+$/i.test(value)) {
      throw new Error(`Invalid WordPress content type: ${value}`);
    }
  }
  return [...new Set(values)];
}

export function loadConfig(): AppConfig {
  const authMethod = (process.env.WP_AUTH_METHOD ?? "application_password") as AuthMethod;
  if (!(["application_password", "jwt"] as const).includes(authMethod)) {
    throw new Error("WP_AUTH_METHOD must be application_password or jwt");
  }

  const transport = (process.env.TRANSPORT ?? "http") as TransportMode;
  if (!(["http", "stdio"] as const).includes(transport)) {
    throw new Error("TRANSPORT must be http or stdio");
  }

  const mcpPath = process.env.MCP_PATH?.trim() || "/mcp";
  if (!mcpPath.startsWith("/") || mcpPath.includes("?")) {
    throw new Error("MCP_PATH must be an absolute URL path");
  }

  const logLevel = process.env.LOG_LEVEL?.trim() || "info";
  if (!(["debug", "info", "warn", "error"] as const).includes(logLevel as AppConfig["server"]["logLevel"])) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  const wordpress: AppConfig["wordpress"] = {
    baseUrl: normalizeBaseUrl(required("WP_URL")),
    authMethod,
    contentTypes: parseContentTypes(),
    requestTimeoutMs: parsePositiveInt("REQUEST_TIMEOUT_MS", 30_000),
    maxMediaBytes: parsePositiveInt("MAX_MEDIA_BYTES", 10 * 1024 * 1024),
  };

  if (authMethod === "application_password") {
    wordpress.username = required("WP_USERNAME");
    wordpress.applicationPassword = required("WP_APPLICATION_PASSWORD");
  } else {
    wordpress.jwtToken = required("WP_JWT_TOKEN");
  }

  const server: AppConfig["server"] = {
    transport,
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInt("PORT", 3000),
    mcpPath,
    allowedHosts: (process.env.ALLOWED_HOSTS ?? "localhost,127.0.0.1")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    logLevel: logLevel as AppConfig["server"]["logLevel"],
  };

  const apiKey = process.env.MCP_API_KEY?.trim();
  if (apiKey) server.apiKey = apiKey;

  return { wordpress, server };
}
