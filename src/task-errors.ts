export function taskNotFoundError(taskId: string): Error {
  return new Error(`No task found with ID: ${taskId}`);
}
