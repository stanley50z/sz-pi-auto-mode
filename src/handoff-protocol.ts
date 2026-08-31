export const AUTOMODE_RETURN_TO_NORMAL_MESSAGE = Object.freeze({
  type: "automode:return-to-normal",
});

export function isAutomodeReturnToNormalMessage(message: unknown): boolean {
  return Boolean(
    message
    && typeof message === "object"
    && (message as { type?: unknown }).type === AUTOMODE_RETURN_TO_NORMAL_MESSAGE.type,
  );
}

/**
 * Tells the waiting normal Pi process to resume after Automode finishes draining.
 */
export function requestReturnToNormalPi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("The original normal Pi session is unavailable"));
      return;
    }
    process.send(AUTOMODE_RETURN_TO_NORMAL_MESSAGE, (error: Error | null) => {
      if (error) reject(new Error("Could not request a return to normal Pi", { cause: error }));
      else resolve();
    });
  });
}
