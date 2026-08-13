/**
 * A session-scoped reference users can explicitly attach to one Harness turn
 * with `@`. Mention owns discovery and resolution; Core owns parsing, budgets,
 * delivery, and the resulting Harness context.
 */
export interface Mention {
  /** Stable namespace used in `@namespace/id`. */
  readonly namespace: string;
  search(query: string): Promise<
    readonly {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
    }[]
  >;
  resolve(
    id: string,
    options: { readonly maxChars: number },
  ): Promise<string | undefined>;
}
