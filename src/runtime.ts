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

export function setWebexRuntime(next: WebexRuntime): void {
  runtime = next ?? {};
}

export function getWebexRuntime(): WebexRuntime {
  return runtime;
}
