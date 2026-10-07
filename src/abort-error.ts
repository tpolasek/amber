/**
 * Tools reject with DOM-style AbortError objects (name "AbortError") so abort
 * handling can recognize them uniformly across every tool implementation.
 */
export function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw abortError(message);
}
