/**
 * The vocabulary of relations between concepts.
 *
 * Its own module, with no imports, because the concept graph renders in the
 * browser and needs these names, and `./extract` reaches the PDF parser — which
 * needs `fs` and cannot be bundled for a browser.
 */

/** How one concept relates to another. Read as "source <type> target". */
export const RELATION_TYPES = [
  "builds-on",
  "is-a",
  "part-of",
  "used-for",
  "contrasts-with",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
