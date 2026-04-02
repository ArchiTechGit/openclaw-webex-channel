import { sendFrameworkMessage, type WebexFrameworkRuntime } from "./framework-runtime.js";

export async function sendTextWebex(params: {
  frameworkRuntime: WebexFrameworkRuntime;
  to: string;
  text: string;
}): Promise<{ ok: true }> {
  const to = params.to.trim();
  if (!to) {
    throw new Error("Webex send requires target roomId or person:<id>.");
  }
  const text = params.text ?? "";
  if (!text.trim()) {
    throw new Error("Webex send requires non-empty text.");
  }

  await sendFrameworkMessage(params.frameworkRuntime.framework, to, text);
  return { ok: true };
}
