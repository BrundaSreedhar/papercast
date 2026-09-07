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
      items: { str: string; transform: number[] }[];
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

  function pdf(data: Buffer | Uint8Array, options?: PdfParseOptions): Promise<PdfParseResult>;
  export default pdf;
}
