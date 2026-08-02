#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import "dotenv/config";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http-server.js";
import { Logger } from "./logger.js";
import { createMcpServer } from "./mcp-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.server.logLevel);

  if (config.server.transport === "stdio") {
    const server = createMcpServer(config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("WordPress MCP Server connected", { transport: "stdio", wpAuth: config.wordpress.authMethod });
    return;
  }

  const httpServer = await startHttpServer(config, logger);
  const shutdown = (signal: string) => {
    logger.info("Shutting down", { signal });
    httpServer.close((error) => {
      if (error) {
        logger.error("Shutdown failed", { error: error.message });
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    message: "Startup failed",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
