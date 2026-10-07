/**
 * Server-side operational logging. These messages go to the server's stderr
 * for the human watching the process; request failures are additionally
 * reported to clients through their HTTP responses.
 */
export function logServerError(message: string, detail?: unknown): void {
  console.error(detail === undefined ? message : `${message}:`, detail);
}
