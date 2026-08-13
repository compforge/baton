import type { Mention } from "@compforge/baton-plugin";

const LOCAL_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REFERENCE_PATTERN =
  /@([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9][A-Za-z0-9._-]*)/g;

interface RegisteredMention {
  readonly namespace: string;
  readonly referencePrefix: string;
  readonly mention: Mention;
}

function assertLocalKind(name: string, value: string): void {
  if (!LOCAL_KIND.test(value)) {
    throw new Error(
      `${name} must contain only letters, digits, underscore, or hyphen`,
    );
  }
}

function assertReferenceId(kind: string, value: string): void {
  if (!REFERENCE_ID.test(value)) {
    throw new Error(
      `Mention ${kind} reference id must contain only letters, digits, dot, underscore, or hyphen`,
    );
  }
}

function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Shared registry for Baton-owned and Plugin-provided explicit mentions.
 * The caller's namespace scopes identity; mentions never construct or
 * parse the stable mention token themselves.
 */
export class MentionRegistry {
  private readonly mentions = new Map<string, RegisteredMention>();
  private readonly referencePrefixes = new Map<string, RegisteredMention>();

  registerMention(
    mention: Mention,
    ownerNamespace?: string,
  ): () => void {
    assertLocalKind("Mention namespace", mention.namespace);
    if (ownerNamespace) assertLocalKind("Mention owner namespace", ownerNamespace);
    const namespace = ownerNamespace
      ? `${ownerNamespace}@${mention.namespace}`
      : mention.namespace;
    if (this.mentions.has(namespace)) {
      throw new Error(`Mention already registered: ${namespace}`);
    }

    // Mentions use one leading @. The runtime-only dot encoding keeps Plugin
    // ownership readable without exposing a second @ to chat-tui's trigger.
    const referencePrefix = namespace.replace("@", ".");
    if (this.referencePrefixes.has(referencePrefix)) {
      throw new Error(
        `Mention reference prefix already registered: ${referencePrefix}`,
      );
    }
    const registration = Object.freeze({
      namespace,
      referencePrefix,
      mention,
    });
    this.mentions.set(namespace, registration);
    this.referencePrefixes.set(referencePrefix, registration);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.mentions.get(namespace) === registration) {
        this.mentions.delete(namespace);
      }
      if (this.referencePrefixes.get(referencePrefix) === registration) {
        this.referencePrefixes.delete(referencePrefix);
      }
    };
  }

  async candidates(query: string): Promise<Array<{
    readonly group: string;
    readonly insert: string;
    readonly label: string;
    readonly detail: string;
  }>> {
    const candidates: Array<{
      readonly group: string;
      readonly insert: string;
      readonly label: string;
      readonly detail: string;
    }> = [];
    for (const registration of this.mentions.values()) {
      for (const candidate of await registration.mention.search(query)) {
        assertReferenceId(registration.namespace, candidate.id);
        if (!candidate.label.trim()) {
          throw new Error(
            `Mention ${registration.namespace} candidate label must not be empty`,
          );
        }
        candidates.push({
          group: registration.namespace,
          insert: `@${registration.referencePrefix}:${candidate.id}`,
          label: candidate.label,
          detail: candidate.description ?? "",
        });
      }
    }
    return candidates;
  }

  hasReference(input: string): boolean {
    for (const match of input.matchAll(REFERENCE_PATTERN)) {
      if (this.referencePrefixes.has(match[1] as string)) return true;
    }
    return false;
  }

  async resolve(
    input: string,
    maxChars: number,
  ): Promise<readonly string[]> {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      throw new Error("Mention maxChars must be a positive integer");
    }
    const references = new Map<string, {
      readonly mention: RegisteredMention;
      readonly id: string;
    }>();
    for (const match of input.matchAll(REFERENCE_PATTERN)) {
      const registration = this.referencePrefixes.get(match[1] as string);
      if (!registration) continue;
      const id = match[2] as string;
      references.set(`${registration.namespace}:${id}`, {
        mention: registration,
        id,
      });
    }
    if (references.size === 0) return [];

    const perReferenceBudget = Math.max(
      1,
      Math.floor(maxChars / references.size),
    );
    const contexts = await Promise.all(
      [...references.values()].map(async ({ mention, id }) => {
        const text = await mention.mention.resolve(id, {
          maxChars: perReferenceBudget,
        });
        if (!text?.trim()) return undefined;
        return bounded(text, perReferenceBudget);
      }),
    );
    return contexts.filter((text): text is string => text !== undefined);
  }
}
