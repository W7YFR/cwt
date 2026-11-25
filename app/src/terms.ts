/* The terms of use, and whether this browser agreed to them.
 *
 * Only the rag chew asks: it downloads a model and shows what a model wrote,
 * so it runs only once you accept the terms. The terms have a version of
 * their own, apart from the app's. A change to `app/public/terms.html` raises
 * it, in the same change. A test holds the page's hash for each version, so
 * an edit without a raise fails it. Agreeing records the terms version and
 * the app version it was given on. An agreement to an older terms version is
 * no agreement: the rag chew asks again.
 */

/** The terms' version. Raise it with each change to `app/public/terms.html`. */
export const TERMS_VERSION = 1;

const KEY = "cwt:terms";

/** What agreeing records: the terms version agreed to, and the app version it was given on. */
export interface Agreement {
  readonly terms: number;
  readonly app: string;
}

/** Whether this browser agreed to the current terms. Storage that cannot be read holds no agreement. */
export function agreed(): boolean {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Agreement> | null;
    return typeof a?.terms === "number" && a.terms >= TERMS_VERSION;
  } catch {
    return false;
  }
}

/** Record agreement to the current terms, given on app version `app`. */
export function agree(app: string): void {
  const a: Agreement = { terms: TERMS_VERSION, app };
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* storage blocked: the rag chew asks again next time */
  }
}
