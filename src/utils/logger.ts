/**
 * Logger interface and implementation
 * Simply logs to the console with customizable log level
 * 
 * In the future we could extend this to write .log files to IndexedDB or cache storage
 */

export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export const LOG_LEVEL = {
  DEBUG: 0, // Most verbose
  INFO: 1,
  WARN: 2,
  ERROR: 3
}

export class WavedashLogger implements Logger {
  constructor(private logLevel = LOG_LEVEL.WARN) {}

  setLogLevel(level: number): void {
    this.logLevel = level;
  }

  debug(message: string, ...args: any[]): void {
    if (this.logLevel <= LOG_LEVEL.DEBUG) {
      console.log(`[WavedashJS] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.logLevel <= LOG_LEVEL.INFO) {
      console.log(`[WavedashJS] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.logLevel <= LOG_LEVEL.WARN) {
      console.warn(`[WavedashJS] ${message}`, ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.logLevel <= LOG_LEVEL.ERROR) {
      console.error(`[WavedashJS] ${message}`, ...args);
    }
  }
}
