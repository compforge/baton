/**
 * A session-scoped source that users can explicitly add to one Harness turn.
 *
 * Candidate and result shapes stay inline intentionally: ContextProvider is
 * the extension concept; picker rows and rendered text are its wire values.
 */
export interface ContextProvider {
  /**
   * Stable local kind. Baton keeps built-ins bare and qualifies Plugin kinds
   * as `<pluginName>@<kind>`.
   */
  readonly kind: string;
  search(query: string): readonly {
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
  }[];
  provide(
    id: string,
    options: { readonly maxChars: number },
  ): Promise<string | undefined> | string | undefined;
}
