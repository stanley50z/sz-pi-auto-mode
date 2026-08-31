/** Builds the exact prompt used for Ticket Session dispatch and dashboard inspection. */
export function createCanonicalTicketSessionPrompt(skillName: string, itemUrl: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error(`Invalid canonical skill name: ${skillName}`);
  }
  if (/\s/.test(itemUrl)) throw new Error("Ticket item URL must not contain whitespace");
  let parsed: URL;
  try {
    parsed = new URL(itemUrl);
  } catch (error) {
    throw new Error(`Invalid ticket item URL: ${itemUrl}`, { cause: error });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Ticket item URL must use HTTP or HTTPS: ${itemUrl}`);
  }
  return `/skill:${skillName} ${itemUrl}`;
}
