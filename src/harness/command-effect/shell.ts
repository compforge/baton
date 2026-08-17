import { readFile } from "node:fs/promises";

import bashWasmUrl from "@lumis-sh/wasm-bash";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

export type ReadOnlyCommandRule = (args: readonly string[]) => boolean;
export type ReadOnlyCommandRules = ReadonlyMap<string, ReadOnlyCommandRule>;

interface Analysis {
  readOnly: boolean;
  commandCount: number;
}

type StaticEnvironment = ReadonlyMap<string, string>;

const MAX_STATIC_LOOP_VALUES = 128;
const STATIC_EXPANSION_VALUE = /^[A-Za-z0-9_./:@%+=,-]+$/;
const DYNAMIC_WORD_SYNTAX = /[\\*?[\]{}]/;

await Parser.init();
const bashLanguage = await Language.load(await readFile(bashWasmUrl));
const bashParser = new Parser().setLanguage(bashLanguage);

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function fieldChildren(node: SyntaxNode, field: string): SyntaxNode[] {
  return node.childrenForFieldName(field).filter((child): child is SyntaxNode => child !== null);
}

function staticExpansion(node: SyntaxNode, environment: StaticEnvironment): string | undefined {
  const variable = namedChildren(node).find((child) => child.type === "variable_name");
  if (!variable || !environment.has(variable.text)) return undefined;

  const value = environment.get(variable.text)!;
  return STATIC_EXPANSION_VALUE.test(value) ? value : undefined;
}

/** Resolve only shell words whose runtime value is fully known. */
function staticWord(node: SyntaxNode, environment: StaticEnvironment): string | undefined {
  switch (node.type) {
    case "command_name": {
      const child = node.firstNamedChild;
      return child ? staticWord(child, environment) : undefined;
    }
    case "word":
    case "number":
      return DYNAMIC_WORD_SYNTAX.test(node.text) ? undefined : node.text;
    case "raw_string":
      return node.text.length >= 2 ? node.text.slice(1, -1) : undefined;
    case "string_content":
      // In double quotes Bash preserves backslashes before ordinary regex
      // characters (for example `\|`) but interprets these special escapes.
      return /\\[$`"\\\n]/.test(node.text) ? undefined : node.text;
    case "simple_expansion":
      return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(node.text)
        ? staticExpansion(node, environment)
        : undefined;
    case "expansion":
      return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(node.text)
        ? staticExpansion(node, environment)
        : undefined;
    case "string":
    case "concatenation": {
      let value = "";
      for (const child of namedChildren(node)) {
        const part = staticWord(child, environment);
        if (part === undefined) return undefined;
        value += part;
      }
      return value;
    }
    default:
      return undefined;
  }
}

function hasUnquotedEscape(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\" && quote !== "'") {
      if (quote !== '"') return true;
      index += 1;
      continue;
    }
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? undefined : character;
    }
  }
  return false;
}

function analyzeCommand(
  node: SyntaxNode,
  rules: ReadOnlyCommandRules,
  environment: StaticEnvironment,
): Analysis {
  // Prefix assignments can change a reader's behavior, for example by
  // enabling Git external diff helpers. Keep them outside the proof boundary.
  if (namedChildren(node).some((child) => child.type === "variable_assignment")) {
    return { readOnly: false, commandCount: 0 };
  }

  const nameNode = node.childForFieldName("name");
  const executablePath = nameNode ? staticWord(nameNode, environment) : undefined;
  const executable = executablePath?.split("/").pop();
  if (!executable) return { readOnly: false, commandCount: 0 };

  const args: string[] = [];
  for (const argument of fieldChildren(node, "argument")) {
    const value = staticWord(argument, environment);
    if (value === undefined) return { readOnly: false, commandCount: 0 };
    args.push(value);
  }

  return {
    readOnly: rules.get(executable)?.(args) === true,
    commandCount: 1,
  };
}

function redirectIsReadOnly(node: SyntaxNode, environment: StaticEnvironment): boolean {
  if (node.type !== "file_redirect") return false;

  const operator = node.children.find((child) => child !== null && !child.isNamed)?.text;
  const destinationNode = node.childForFieldName("destination");
  const destination = destinationNode ? staticWord(destinationNode, environment) : undefined;
  if (!operator || destination === undefined) return false;

  if (operator === "<") return destination.length > 0;
  if (operator === "<&" || operator === ">&") return /^(?:\d+|-)$/.test(destination);

  // Discarding output is observationally neutral; every other output target
  // remains a write even when the wrapped executable is a reader.
  return [">", ">>", ">|", "&>", "&>>"].includes(operator)
    && destination === "/dev/null";
}

function analyzeChildren(
  node: SyntaxNode,
  rules: ReadOnlyCommandRules,
  environment: StaticEnvironment,
): Analysis {
  let commandCount = 0;
  for (const child of namedChildren(node)) {
    if (child.type === "comment") continue;
    const analysis = analyzeNode(child, rules, environment);
    if (!analysis.readOnly) return analysis;
    commandCount += analysis.commandCount;
  }
  return { readOnly: commandCount > 0, commandCount };
}

function analyzeForStatement(
  node: SyntaxNode,
  rules: ReadOnlyCommandRules,
  environment: StaticEnvironment,
): Analysis {
  const variable = node.childForFieldName("variable")?.text;
  const body = node.childForFieldName("body");
  const valueNodes = fieldChildren(node, "value");
  if (!variable || !body || valueNodes.length === 0 || valueNodes.length > MAX_STATIC_LOOP_VALUES) {
    return { readOnly: false, commandCount: 0 };
  }

  const values: string[] = [];
  for (const valueNode of valueNodes) {
    const value = staticWord(valueNode, environment);
    if (value === undefined) return { readOnly: false, commandCount: 0 };
    values.push(value);
  }

  let commandCount = 0;
  for (const value of values) {
    const iterationEnvironment = new Map(environment);
    iterationEnvironment.set(variable, value);
    const analysis = analyzeNode(body, rules, iterationEnvironment);
    if (!analysis.readOnly) return analysis;
    commandCount += analysis.commandCount;
  }
  return { readOnly: commandCount > 0, commandCount };
}

function analyzeNode(
  node: SyntaxNode,
  rules: ReadOnlyCommandRules,
  environment: StaticEnvironment,
): Analysis {
  switch (node.type) {
    case "command":
      return analyzeCommand(node, rules, environment);
    case "redirected_statement": {
      const body = node.childForFieldName("body");
      if (!body || !fieldChildren(node, "redirect").every((redirect) =>
        redirectIsReadOnly(redirect, environment))) {
        return { readOnly: false, commandCount: 0 };
      }
      return analyzeNode(body, rules, environment);
    }
    case "for_statement":
      return analyzeForStatement(node, rules, environment);
    case "negated_command": {
      const command = node.firstNamedChild;
      return command
        ? analyzeNode(command, rules, environment)
        : { readOnly: false, commandCount: 0 };
    }
    case "program":
      // Background jobs can escape the command lifetime, so `&` is not a
      // read-only composition operator even when each child is a reader.
      if (node.children.some((child) => child?.type === "&")) {
        return { readOnly: false, commandCount: 0 };
      }
      return analyzeChildren(node, rules, environment);
    case "list":
    case "pipeline":
    case "do_group":
    case "compound_statement":
    case "subshell":
    case "if_statement":
    case "else_clause":
    case "while_statement":
    case "until_statement":
      return analyzeChildren(node, rules, environment);
    default:
      return { readOnly: false, commandCount: 0 };
  }
}

/**
 * A shell command is read-only only when its Bash AST is fully supported and
 * every executable is accepted by its command-specific semantic rule.
 */
export function shellCommandIsReadOnly(
  command: string,
  rules: ReadOnlyCommandRules,
): boolean {
  // The Bash grammar can omit an escaped separator from the command node's
  // range. Quoted regex escapes are stable; unquoted escapes fail closed.
  if (hasUnquotedEscape(command)) return false;

  const tree = bashParser.parse(command);
  if (!tree) return false;

  try {
    if (tree.rootNode.hasError) return false;
    const analysis = analyzeNode(tree.rootNode, rules, new Map());
    return analysis.readOnly && analysis.commandCount > 0;
  } finally {
    tree.delete();
  }
}
