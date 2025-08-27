export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export class WavedashLogger implements Logger {
  constructor(private debugEnabled: boolean = false) {}

  updateDebugMode(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  debug(message: string, ...args: any[]): void {
    if (this.debugEnabled) {
      console.log(`[WavedashJS] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    console.log(`[WavedashJS] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[WavedashJS] ${message}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`[WavedashJS] ${message}`, ...args);
  }
}
