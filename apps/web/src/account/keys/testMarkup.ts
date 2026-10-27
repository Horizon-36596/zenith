/**
 * What the key screens' tests share: sample codes and times, and small readers of the markup that
 * React's server renderer writes, so the screens can be checked without a browser. The components
 * without state are also called directly, and their buttons' callbacks read from the tree they return.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** A verification or safety code: five groups of four digits. */
export const CODE = "0417 2958 3361 7720 5164";
/** An approval code as a waiting device shows it: 18 Crockford base32 characters in groups of six. */
export const APPROVAL = "7K2QXD-M9A1RT-4ZC8PW";
export const RECOVERY = "ZNTH-ABCDE-FGHJK-MNPQR-STVWX-YZ2345";
export const MADE = new Date(2026, 8, 28, 12, 0, 0);
export const NOW_MS = new Date(2026, 8, 28, 12, 5, 0).getTime();
export const nothing = () => undefined;

export function html(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** The text a screen shows, with the markup taken out and the entities that React writes put back. */
export function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The opening tag of the element with this test id. */
export function tagOf(markup: string, testId: string): string {
  const match = new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(markup);
  if (match === null) throw new Error(`nothing has data-testid="${testId}"`);
  return match[0];
}

/**
 * The element with this test id in a tree a component returned, without rendering the components
 * inside it. Used for the components that hold no state, so their buttons' callbacks can be called.
 */
export function elementWithTestId(node: ReactNode, testId: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const found = elementWithTestId(child, testId);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.props["testId"] === testId || node.props["data-testid"] === testId) return node;
  return elementWithTestId(node.props["children"] as ReactNode, testId);
}

export function click(tree: ReactNode, testId: string): void {
  const element = elementWithTestId(tree, testId);
  if (element === null) throw new Error(`nothing has test id ${testId}`);
  (element.props["onClick"] as () => void)();
}
