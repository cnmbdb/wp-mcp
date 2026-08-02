import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { AppConfig } from "./types.js";
import { Logger } from "./logger.js";
import { createMcpServer } from "./mcp-server.js";

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function hostAllowed(req: IncomingMessage, allowedHosts: string[]): boolean {
  const raw = req.headers.host;
  if (!raw) return false;
  try {
    const hostname = new URL(`http://${raw}`).hostname.toLowerCase();
    return allowedHosts.includes(hostname);
  } catch {
    return false;
  }
}

function apiKeyAllowed(req: IncomingMessage, expected?: string): boolean {
  if (!expected) return true;
  const authorization = req.headers.authorization ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLength = Number.parseInt(req.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("request_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startHttpServer(config: AppConfig, logger: Logger): Promise<Server> {
  const requestLimit = Math.ceil(config.wordpress.maxMediaBytes * 1.4) + 1024 * 1024;

  const httpServer = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (!hostAllowed(req, config.server.allowedHosts)) {
      sendJson(res, 403, { error: "host_not_allowed" });
      return;
    }

    if (path === "/health" && req.method === "GET") {
      sendJson(res, 200, { status: "ok", service: "wordpress-mcp-server", version: "1.0.0" });
      return;
    }

    if (path !== config.server.mcpPath) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (!apiKeyAllowed(req, config.server.apiKey)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed in stateless mode" },
        id: null,
      });
      return;
    }

    const mcp = createMcpServer(config);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });

    try {
      const body = await readJsonBody(req, requestLimit);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error("MCP request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        const tooLarge = error instanceof Error && error.message === "request_too_large";
        sendJson(res, tooLarge ? 413 : 500, {
          jsonrpc: "2.0",
          error: { code: tooLarge ? -32001 : -32603, message: tooLarge ? "Request too large" : "Internal server error" },
          id: null,
        });
      }
    }
  });

  return await new Promise<Server>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(config.server.port, config.server.host, () => {
      httpServer.off("error", onError);
      httpServer.on("error", (error) => logger.error("HTTP server error", { error: error.message }));
      logger.info("WordPress MCP Server listening", {
        transport: "streamable-http",
        host: config.server.host,
        port: config.server.port,
        path: config.server.mcpPath,
        mcpAuth: config.server.apiKey ? "bearer" : "none",
        wpAuth: config.wordpress.authMethod,
      });
      resolve(httpServer);
    });
  });
}
