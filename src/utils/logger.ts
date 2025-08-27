export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export class WavedashLogger implements Logger {
  private logLevels = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  }
  constructor(private logLevel = this.logLevels.warn) {}

  setLogLevel(level: "debug" | "info" | "warn" | "error"): void {
    this.logLevel = this.logLevels[level];
  }

  debug(message: string, ...args: any[]): void {
    if (this.logLevel <= this.logLevels.debug) {
      console.log(`[WavedashJS] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.logLevel <= this.logLevels.info) {
      console.log(`[WavedashJS] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.logLevel <= this.logLevels.warn) {
      console.warn(`[WavedashJS] ${message}`, ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.logLevel <= this.logLevels.error) {
      console.error(`[WavedashJS] ${message}`, ...args);
    }
  }
}
