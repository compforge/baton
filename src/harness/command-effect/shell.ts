export type ReadOnlyCommandRule = (args: readonly string[]) => boolean;
export type ReadOnlyCommandRules = ReadonlyMap<string, ReadOnlyCommandRule>;

interface ParsedShellCommand {
  segments: string[][];
}

/**
 * Parse only the shell subset needed to prove reads. Unsupported syntax is not
 * an error: it deliberately returns undefined so the caller can fail closed.
 */
function parseShellCommand(command: string): ParsedShellCommand | undefined {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;

  const finishToken = () => {
    if (token.length === 0) return;
    tokens.push(token);
    token = "";
  };
  const finishSegment = () => {
    finishToken();
    if (tokens.length === 0) return false;
    segments.push(tokens);
    tokens = [];
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    // Substitution, redirection and escapes require a real shell parser. They
    // are intentionally outside this recognizer's proof boundary.
    if (char === "$" || char === "`" || char === "<" || char === ">" || char === "\\" || char === "\r") {
      return undefined;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char) && char !== "\n") {
      finishToken();
      continue;
    }
    if (char === "\n" || char === ";" || char === "|") {
      if (!finishSegment()) return undefined;
      if (char === "|" && command[index + 1] === "|") index += 1;
      continue;
    }
    if (char === "&") {
      if (command[index + 1] !== "&" || !finishSegment()) return undefined;
      index += 1;
      continue;
    }
    token += char;
  }

  if (quote || !finishSegment()) return undefined;
  return { segments };
}

/**
 * A compound command is read-only only when its shell shape is supported and
 * every segment is accepted by the registered executable-specific rule.
 */
export function shellCommandIsReadOnly(
  command: string,
  rules: ReadOnlyCommandRules,
): boolean {
  const parsed = parseShellCommand(command);
  if (!parsed) return false;

  return parsed.segments.every(([executablePath, ...args]) => {
    const executable = executablePath?.split("/").pop();
    if (!executable) return false;
    return rules.get(executable)?.(args) === true;
  });
}
