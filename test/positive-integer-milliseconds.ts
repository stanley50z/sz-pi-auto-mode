export function parsePositiveIntegerMilliseconds(
  value: number | string,
  contract: string,
): number {
  const milliseconds = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds < 1) {
    throw new Error(`${contract} must be a positive integer`);
  }
  return milliseconds;
}
