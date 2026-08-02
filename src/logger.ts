import type { AppConfig } from "./types.js";

const priorities = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export class Logger {
  constructor(private readonly level: AppConfig["server"]["logLevel"]) {}

  private write(level: keyof typeof priorities, message: string, details?: Record<string, unknown>): void {
    if (priorities[level] < priorities[this.level]) return;
    const record = { timestamp: new Date().toISOString(), level, message, ...details };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }

  debug(message: string, details?: Record<string, unknown>): void { this.write("debug", message, details); }
  info(message: string, details?: Record<string, unknown>): void { this.write("info", message, details); }
  warn(message: string, details?: Record<string, unknown>): void { this.write("warn", message, details); }
  error(message: string, details?: Record<string, unknown>): void { this.write("error", message, details); }
}
