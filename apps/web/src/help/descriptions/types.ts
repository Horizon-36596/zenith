/**
 * The shape of one description (issue #238, UI_GUIDE section 9.13). It lives apart from `index.ts`
 * so each surface's table can import it without importing the others.
 */
export interface Description {
  /** The label the row shows. It is not drawn from here; the lint checks that the brief does not repeat it. */
  label: string;
  /**
   * A fragment of 48 characters or fewer, with no full stop, drawn on one line under the label only
   * when Descriptions is "With descriptions".
   */
  brief?: string;
  /** One or two plain sentences of 160 characters or fewer. It is never drawn inline: it is the hint. */
  more?: string;
}
