export interface ParsedCommand {
  command: string;
  args: readonly string[];
}

export function parseShellLikeCommand(raw: string): ParsedCommand | null {
  const parts = raw
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const command = parts[0];
  if (command === undefined || command.length === 0) return null;
  return { command, args: parts.slice(1) };
}
