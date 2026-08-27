/** A described figure, ready to be handed to the script writer. */
export interface FigureDescription {
  page: number;
  /** Captions found on the page, e.g. "Figure 3:", "Table 1:". */
  captions: string[];
  /**
   * What the figure shows, in the vision model's words.
   *
   * Model-generated, not quoted from the paper. Everything downstream treats it
   * as derived evidence for exactly that reason.
   */
  description: string;
}

export interface VisionProvider {
  readonly name: string;
  readonly model: string;
  /** Describe the figures and tables on one rendered page. */
  describePage(png: Buffer, captions: string[]): Promise<string>;
}
