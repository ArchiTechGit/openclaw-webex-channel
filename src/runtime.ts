type RuntimeLogger = {
  info?: (msg: string, data?: unknown) => void;
  debug?: (msg: string, data?: unknown) => void;
  error?: (msg: string, data?: unknown) => void;
};

export type WebexInboundEvent = {
  text: string;
  roomId: string;
  personId?: string;
  personEmail?: string;
  messageId?: string;
  raw?: unknown;
};

export type WebexRuntime = {
  log?: RuntimeLogger;
  onInboundMessage?: (event: WebexInboundEvent) => Promise<void> | void;
};

let runtime: WebexRuntime = {};

export function webexLogInfo(msg: string, data?: unknown): void {
  runtime.log?.info?.(msg, data);
}

export function webexLogDebug(msg: string, data?: unknown): void {
  runtime.log?.debug?.(msg, data);
}

export function webexLogError(msg: string, data?: unknown): void {
  runtime.log?.error?.(msg, data);
}

export function setWebexRuntime(next: WebexRuntime): void {
  runtime = next ?? {};
}

export function getWebexRuntime(): WebexRuntime {
  return runtime;
}
