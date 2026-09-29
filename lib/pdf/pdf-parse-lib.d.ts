// @types/pdf-parse only declares the package entrypoint, not the internal
// module we import to sidestep pdf-parse's debug-path behavior.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }

  /** One page, as pdf.js hands it to a renderer. */
  interface PdfPageData {
    getTextContent: (options: unknown) => Promise<{
      /**
       * `transform` is the text matrix: [4] and [5] are x and y, [0] and [1]
       * scale with the font size. `width` is the fragment's advance, in the
       * same units as x.
       */
      items: { str: string; transform: number[]; width?: number }[];
    }>;
  }

  /**
   * Only the options this project actually passes. `pagerender` is how a caller
   * sees each page separately, which is what makes page numbers recoverable.
   */
  interface PdfParseOptions {
    pagerender?: (page: PdfPageData) => Promise<string>;
    max?: number;
    version?: string;
  }

  function pdf(
    data: Buffer | Uint8Array,
    options?: PdfParseOptions,
  ): Promise<PdfParseResult>;
  export default pdf;
}
