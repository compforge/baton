import type { ContextProvider } from "@qiankun01/baton-plugin";

const LOCAL_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REFERENCE_PATTERN =
  /@([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9][A-Za-z0-9._-]*)/g;

interface RegisteredProvider {
  readonly kind: string;
  readonly referencePrefix: string;
  readonly provider: ContextProvider;
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
      `ContextProvider ${kind} reference id must contain only letters, digits, dot, underscore, or hyphen`,
    );
  }
}

function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Shared registry for Baton-owned and Plugin-provided explicit context.
 * The caller's namespace scopes kind identity; providers never construct or
 * parse the stable mention token themselves.
 */
export class ContextProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly referencePrefixes = new Map<string, RegisteredProvider>();

  registerContextProvider(
    provider: ContextProvider,
    namespace?: string,
  ): () => void {
    assertLocalKind("ContextProvider kind", provider.kind);
    if (namespace) assertLocalKind("ContextProvider namespace", namespace);
    const kind = namespace ? `${namespace}@${provider.kind}` : provider.kind;
    if (this.providers.has(kind)) {
      throw new Error(`ContextProvider already registered: ${kind}`);
    }

    // Mentions use one leading @. The runtime-only dot encoding keeps Plugin
    // ownership readable without exposing a second @ to chat-tui's trigger.
    const referencePrefix = kind.replace("@", ".");
    if (this.referencePrefixes.has(referencePrefix)) {
      throw new Error(
        `ContextProvider reference prefix already registered: ${referencePrefix}`,
      );
    }
    const registration = Object.freeze({
      kind,
      referencePrefix,
      provider,
    });
    this.providers.set(kind, registration);
    this.referencePrefixes.set(referencePrefix, registration);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.providers.get(kind) === registration) {
        this.providers.delete(kind);
      }
      if (this.referencePrefixes.get(referencePrefix) === registration) {
        this.referencePrefixes.delete(referencePrefix);
      }
    };
  }

  candidates(query: string): Array<{
    readonly group: string;
    readonly insert: string;
    readonly label: string;
    readonly detail: string;
  }> {
    const candidates: Array<{
      readonly group: string;
      readonly insert: string;
      readonly label: string;
      readonly detail: string;
    }> = [];
    for (const registration of this.providers.values()) {
      for (const candidate of registration.provider.search(query)) {
        assertReferenceId(registration.kind, candidate.id);
        if (!candidate.label.trim()) {
          throw new Error(
            `ContextProvider ${registration.kind} candidate label must not be empty`,
          );
        }
        candidates.push({
          group: registration.kind,
          insert: `@${registration.referencePrefix}:${candidate.id}`,
          label: candidate.label,
          detail: candidate.detail ?? "",
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

  async provide(
    input: string,
    maxChars: number,
  ): Promise<readonly string[]> {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      throw new Error("ContextProvider maxChars must be a positive integer");
    }
    const references = new Map<string, {
      readonly provider: RegisteredProvider;
      readonly id: string;
    }>();
    for (const match of input.matchAll(REFERENCE_PATTERN)) {
      const registration = this.referencePrefixes.get(match[1] as string);
      if (!registration) continue;
      const id = match[2] as string;
      references.set(`${registration.kind}:${id}`, {
        provider: registration,
        id,
      });
    }
    if (references.size === 0) return [];

    const perReferenceBudget = Math.max(
      1,
      Math.floor(maxChars / references.size),
    );
    const contexts = await Promise.all(
      [...references.values()].map(async ({ provider, id }) => {
        const text = await provider.provider.provide(id, {
          maxChars: perReferenceBudget,
        });
        if (!text?.trim()) return undefined;
        return bounded(text, perReferenceBudget);
      }),
    );
    return contexts.filter((text): text is string => text !== undefined);
  }
}
