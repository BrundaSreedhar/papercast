/**
 * Naming the ideas a paper is about, with a model.
 *
 * The lexical extractor could only choose among phrases the episode's key
 * points happened to use, so "Attention Is All You Need" produced "english
 * constituency parsing" and "executed operations" and never once the
 * Transformer — the word is on every page and in no key point. Deciding what a
 * paper is *about* is a judgement, and it is the one thing the model that just
 * read the paper to write the episode is good at.
 *
 * The same discipline applies here as everywhere else a model speaks:
 *
 * - The names are asked for in the form the field uses, so two papers that
 *   discuss one idea name it the same way and meet on the map.
 * - Every concept carries a quote from the paper, and a concept that can be
 *   found neither by name nor by its quote is dropped. A model naming an idea
 *   the paper never discusses is the concept map's version of a fabricated
 *   citation.
 *
 * The same call names how the concepts relate, from a small fixed vocabulary —
 * one part is *part of* another, one idea *builds on* another — because an
 * untyped line says only that two ideas came up together, and every pair in a
 * paper did. A relation is a claim about the paper, so it is held to a stricter
 * bar than a concept: both ends must be concepts that survived, and its quote
 * must be found.
 *
 * The call is bounded: the model sees the title, abstract, every heading and
 * the opening of each section rather than the whole paper. A paper introduces
 * its ideas where it names them, and this keeps the extra call to a few
 * thousand tokens on any provider.
 */
import { z } from "zod";
import { PaperLocator } from "../pdf/locate";
import { flatten, mentions } from "./moments";
import { paperToText, type PaperStructure } from "../pdf/extract";
import type { LLMProvider, Usage } from "../llm/types";
import type { Concept, ConceptRelationInput } from "./index";

import { RELATION_TYPES, type RelationType } from "./relations";

export { RELATION_TYPES, type RelationType };

/** Strict-mode safe: every field required, no numeric bounds. */
export const ConceptExtractionSchema = z.object({
  concepts: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "The idea's canonical name, as the field writes it and as another paper would also call it: 'Transformer', 'self-attention', 'residual learning', 'retrieval-augmented generation'. Singular. Capitalise only proper names and acronyms. Never a sentence fragment, never a result, never the paper's title.",
          ),
        aliases: z
          .array(z.string())
          .describe(
            "Other names for exactly this idea used in the paper: its acronym, or its spelled-out form ('RAG' for retrieval-augmented generation). Never a broader or narrower idea. Empty when there are none.",
          ),
        definition: z
          .string()
          .describe(
            "What it is, in one plain sentence of at most 25 words, as this paper uses it.",
          ),
        importance: z
          .enum(["core", "supporting", "background"])
          .describe(
            "'core': what the paper proposes or is centrally about. 'supporting': a component or technique the paper develops or relies on substantively. 'background': prior work the paper builds on or argues against.",
          ),
        evidence: z
          .string()
          .describe(
            "A verbatim quote of 8 to 30 words from the paper text given, where the idea is introduced or used. Copy it exactly.",
          ),
      }),
    )
    .describe("Five to eight concepts, the most central first."),
  relations: z
    .array(
      z.object({
        source: z.string().describe("A concept's name, exactly as given in `concepts`."),
        type: z
          .enum(RELATION_TYPES)
          .describe(
            "How source relates to target, read as 'source <type> target'. 'builds-on': source extends, improves or is derived from target. 'is-a': source is a kind of target. 'part-of': source is a component of target. 'used-for': source is the means by which target is done or achieved. 'contrasts-with': the paper presents source as an alternative to target.",
          ),
        target: z
          .string()
          .describe("A different concept's name, exactly as given in `concepts`."),
        explanation: z
          .string()
          .describe(
            "Why, in one plain sentence of at most 25 words that names both concepts.",
          ),
        evidence: z
          .string()
          .describe(
            "A verbatim quote of 8 to 30 words from the paper text given that states or shows this relation. Copy it exactly.",
          ),
      }),
    )
    .describe(
      "Three to ten relations between the concepts above that the paper states or directly shows. Leave out any you cannot quote.",
    ),
});

export type ConceptExtraction = z.infer<typeof ConceptExtractionSchema>;

/** A relation between two of a paper's concepts, as stored on an episode record. */
export interface PaperRelation {
  /** Concept names, as they appear in the same record's `concepts`. */
  source: string;
  target: string;
  type: RelationType;
  explanation: string;
  /** Where the paper says it. Always present: an unquotable relation is dropped. */
  evidence: {
    text: string;
    page?: number;
    heading?: string;
  };
}

/** A concept as stored on an episode record. */
export interface PaperConcept {
  name: string;
  aliases: string[];
  definition: string;
  importance: "core" | "supporting" | "background";
  /** Where the paper says it, when the quote could be found. */
  evidence?: {
    text: string;
    page?: number;
    heading?: string;
  };
}

export const CONCEPT_SYSTEM = `You pick out the key concepts of a research paper for a map of ideas that joins papers a listener has studied.

A concept is a named idea: an architecture, a method, a mechanism, a theory, a problem framing. Two papers about the same idea must end up with the same name, so use the name the field uses, not this paper's phrasing of it.

Include:
- What the paper proposes or is centrally about. If the paper introduces a named method or architecture, it is the first concept.
- The components and techniques the paper develops or depends on substantively.
- Established ideas the paper builds on or argues against, when it discusses them rather than merely mentions them.

Exclude:
- Datasets, benchmarks, metrics, scores, hardware, training budgets and numerical results.
- Experimental settings such as a language pair or a task split.
- Words that describe any paper: model, method, approach, data, performance, results, framework.
- Opinions and claims ("more efficient training"), and fragments of sentences.
- The paper's own title.

Only name ideas the paper actually discusses. Quote the paper exactly for every one.

Then say how the concepts relate, using only the names you gave them. A relation must be something the paper states or directly shows, not something you know from elsewhere, and it needs its own quote. Fewer well-quoted relations are better than many guessed ones.

Every relation reads as a sentence, "source <type> target", and the sentence must be true. Read it back before you give it. The types:
- is-a: every source is a kind of target. "LSTM is-a recurrent neural network". A component is never a kind of the whole it belongs to.
- part-of: source is a component of target. "encoder part-of sequence-to-sequence model".
- used-for: source is a means to target, where target is a goal, task or capability. "dropout used-for regularization". If target is the thing source sits inside, it is part-of instead.
- builds-on: source extends, improves or is derived from target. "GPT-2 builds-on GPT". The newer or derived idea is always the source.
- contrasts-with: the paper presents the two as alternatives. "convolution contrasts-with recurrence".`;

/** Characters of each section's opening sent to the model. */
const SECTION_OPENING = 700;
/** Overall cap on the digest, so a long paper cannot run up the call. */
const MAX_DIGEST_CHARS = 16_000;

/**
 * The parts of a paper where it names its ideas.
 *
 * Title, abstract, the full list of headings — a paper names its components in
 * them — and the opening of each section, where each is introduced.
 */
export function paperDigest(paper: PaperStructure): string {
  const parts = [`TITLE: ${paper.title}`];
  if (paper.abstract) parts.push(`ABSTRACT:\n${paper.abstract}`);
  if (paper.sections.length) {
    parts.push(
      `SECTION HEADINGS:\n${paper.sections.map((s) => `- ${s.heading}`).join("\n")}`,
    );
  }
  const openings: string[] = [];
  let used = parts.join("\n\n").length;
  for (const s of paper.sections) {
    const opening = s.content.slice(0, SECTION_OPENING).trim();
    const block = `## ${s.heading}\n${opening}${s.content.length > SECTION_OPENING ? " …" : ""}`;
    if (used + block.length > MAX_DIGEST_CHARS) break;
    openings.push(block);
    used += block.length;
  }
  if (openings.length) parts.push(`SECTION OPENINGS:\n\n${openings.join("\n\n")}`);
  return parts.join("\n\n");
}

/**
 * Find a model's quote in the paper, with a page when the paper has one.
 *
 * Without page provenance the locator cannot cite, but the quote can still be
 * checked against the text itself.
 */
function findQuote(
  locator: PaperLocator,
  flat: string,
  quote: string,
): { text: string; page?: number; heading?: string } | undefined {
  const located = locator.find(quote);
  if (located)
    return { text: located.text, page: located.page, heading: located.heading };
  const q = flatten(quote);
  if (!locator.canCite && q.length > 0 && flat.includes(q)) return { text: quote.trim() };
  return undefined;
}

/**
 * Keep the concepts the paper supports, and say where it does.
 *
 * A concept survives when the paper uses its name or an alias, or when its
 * quote can be found. Either shows the model was reading this paper. Neither
 * means it was not, and the concept goes.
 */
export function groundConcepts(
  paper: PaperStructure,
  extracted: ConceptExtraction["concepts"],
): PaperConcept[] {
  const locator = new PaperLocator(paper);
  const flat = flatten(paperToText(paper));
  const title = paper.title.toLowerCase().trim();

  const out: PaperConcept[] = [];
  const seen = new Set<string>();
  for (const c of extracted) {
    const name = c.name.trim();
    if (!name || name.toLowerCase() === title) continue;
    if (seen.has(name.toLowerCase())) continue;

    const aliases = c.aliases
      .map((a) => a.trim())
      .filter((a) => a && a.toLowerCase() !== name.toLowerCase());
    const named = [name, ...aliases].some((n) => mentions(flat, n));

    const evidence = findQuote(locator, flat, c.evidence);
    if (!named && !evidence) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      aliases,
      definition: c.definition.trim(),
      importance: c.importance,
      ...(evidence ? { evidence } : {}),
    });
  }
  return out;
}

/**
 * Keep the relations the paper supports.
 *
 * Both ends must be concepts that survived grounding, found by name or alias,
 * so a relation can never bring back an idea that was dropped. And the quote
 * must be found: a concept can be vouched for by its name appearing in the
 * paper, but a relation is a claim about how two ideas connect, and only a
 * passage saying so supports it.
 */
export function groundRelations(
  paper: PaperStructure,
  concepts: PaperConcept[],
  extracted: ConceptExtraction["relations"],
): PaperRelation[] {
  const locator = new PaperLocator(paper);
  const flat = flatten(paperToText(paper));

  const byName = new Map<string, string>();
  for (const c of concepts) {
    for (const n of [c.name, ...c.aliases]) {
      if (!byName.has(flatten(n))) byName.set(flatten(n), c.name);
    }
  }

  const out: PaperRelation[] = [];
  const seen = new Set<string>();
  for (const r of extracted) {
    const source = byName.get(flatten(r.source));
    const target = byName.get(flatten(r.target));
    if (!source || !target || source === target) continue;

    // "A contrasts with B" and "B contrasts with A" are one relation.
    const key =
      r.type === "contrasts-with"
        ? `${r.type}|${[source, target].sort().join("|")}`
        : `${source}|${r.type}|${target}`;
    if (seen.has(key)) continue;

    const evidence = findQuote(locator, flat, r.evidence);
    if (!evidence) continue;

    seen.add(key);
    out.push({
      source,
      target,
      type: r.type,
      explanation: r.explanation.trim(),
      evidence,
    });
  }
  return out;
}

export interface ExtractConceptsResult {
  concepts: PaperConcept[];
  relations: PaperRelation[];
  /** Concepts the model named that the paper could not support. */
  dropped: string[];
  /** Relations the model proposed that could not be grounded. */
  droppedRelations: number;
  usage: Usage;
  model: string;
}

/** Ask the provider for the paper's key concepts, and ground them. */
export async function extractConcepts(
  paper: PaperStructure,
  provider: LLMProvider,
): Promise<ExtractConceptsResult> {
  const result = await provider.generateStructured({
    system: CONCEPT_SYSTEM,
    user: `${paperDigest(paper)}\n\nName this paper's key concepts.`,
    schema: ConceptExtractionSchema,
    schemaName: "concepts",
    schemaDescription: "The key concepts of a research paper, each grounded in a quote.",
    maxTokens: 4000,
    temperature: 0,
  });
  const concepts = groundConcepts(paper, result.data.concepts);
  const relations = groundRelations(paper, concepts, result.data.relations);
  const kept = new Set(concepts.map((c) => c.name));
  return {
    concepts,
    relations,
    dropped: result.data.concepts.map((c) => c.name).filter((n) => !kept.has(n.trim())),
    droppedRelations: result.data.relations.length - relations.length,
    usage: result.usage,
    model: result.model,
  };
}

const WEIGHT: Record<PaperConcept["importance"], number> = {
  core: 1,
  supporting: 0.6,
  background: 0.35,
};

/** Stored concepts in the shape the map is built from. */
export function toMapConcepts(concepts: PaperConcept[]): Concept[] {
  return concepts.map((c) => ({
    term: c.name.toLowerCase(),
    label: c.name,
    aliases: c.aliases,
    definition: c.definition,
    weight: WEIGHT[c.importance],
    // The definition, not the quote, is what similarity embeds: it says what
    // the idea is, where a quote says only where it came up.
    context: c.definition,
  }));
}

/** Stored relations in the shape the map is built from. */
export function toMapRelations(relations: PaperRelation[]): ConceptRelationInput[] {
  return relations.map((r) => ({
    source: r.source.toLowerCase(),
    target: r.target.toLowerCase(),
    type: r.type,
    explanation: r.explanation,
    evidence: r.evidence,
  }));
}
