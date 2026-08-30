export class AutomodeRestartRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomodeRestartRequiredError";
  }
}
