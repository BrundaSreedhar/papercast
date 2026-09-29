/**
 * Concepts are only useful if they are about the paper. Most of these check
 * what is *excluded* — the presenter's framing, generic academic filler, and
 * four spellings of one idea — because a busy map says less than a sparse one.
 */
import { describe, it, expect } from "vitest";
import {
  acronymExpansions,
  buildConceptMap,
  conceptKey,
  conceptsFor,
  sharedConcepts,
  type Concept,
  type ConceptRelationInput,
} from "./index";
import type { EpisodeSummary } from "../library/types";

/*
 * A bare word has to be something the paper dwells on, so this repeats its
 * terms the way a real paper does. A fixture that named the Transformer once
 * would be testing a document nobody wrote.
 */
const PAPER = `
  The Transformer is a sequence transduction model based entirely on attention.
  Attention lets the Transformer relate positions of a sequence. We use attention
  in place of recurrence. The attention mechanism scales to long sequences, and
  attention is cheaper than recurrence. Recurrence prevents parallelisation.
  The Transformer trains faster than architectures built on recurrence. Our
  Transformer results on the translation task improve over prior work, and the
  Transformer generalises to other tasks. The Transformer uses attention alone.
`;

describe("conceptsFor", () => {
  it("finds what the episode is about", () => {
    const terms = conceptsFor(
      ["The Transformer relies entirely on attention rather than recurrence."],
      "A model built on attention.",
      PAPER,
    ).map((c) => c.term);
    expect(terms).toContain("attention");
    expect(terms.some((t) => t.includes("transformer"))).toBe(true);
  });

  it("drops a phrase the presenter used that the paper never does", () => {
    // The whole point of checking against the paper: framing is not a concept.
    const terms = conceptsFor(
      ["This groundbreaking breakthrough reshapes the whole field."],
      "",
      PAPER,
    ).map((c) => c.term);
    expect(terms).not.toContain("groundbreaking breakthrough");
    expect(terms).not.toContain("whole field");
  });

  it("keeps one term per family rather than four spellings of one idea", () => {
    const terms = conceptsFor(
      ["The attention mechanism replaces recurrence.", "The attention mechanism scales."],
      "Attention, and the attention mechanism.",
      PAPER,
    ).map((c) => c.term);
    const family = terms.filter((t) => t.includes("attention"));
    expect(family).toHaveLength(1);
  });

  it("ignores words that would describe any paper in any field", () => {
    const terms = conceptsFor(
      ["The results of this approach show significant performance improvements."],
      "",
      PAPER,
    ).map((c) => c.term);
    for (const generic of ["results", "approach", "performance", "paper"]) {
      expect(terms).not.toContain(generic);
    }
  });

  it("does not break a phrase across a conjunction", () => {
    const terms = conceptsFor(
      ["It is cheaper and faster than recurrence."],
      "",
      PAPER,
    ).map((c) => c.term);
    expect(terms.every((t) => !t.includes(" and "))).toBe(true);
  });

  it("ignores how the work was measured", () => {
    // "state-of-the-art bleu score" and "wmt" are what a paper scored, not what
    // it is about, and they say nothing about how two papers relate.
    const terms = conceptsFor(
      ["It reaches a state-of-the-art BLEU score on the WMT benchmark."],
      "",
      PAPER + " We report a state-of-the-art BLEU score on the WMT benchmark dataset.",
    ).map((c) => c.term);
    for (const measured of [
      "bleu",
      "wmt",
      "state-of-the-art bleu score",
      "wmt benchmark",
    ]) {
      expect(terms).not.toContain(measured);
    }
  });

  it("ignores a language pair, which names the run and not the idea", () => {
    const terms = conceptsFor(
      ["It was evaluated on english-to-french translation."],
      "",
      PAPER + " We evaluate on english-to-french translation.",
    ).map((c) => c.term);
    expect(terms.every((t) => !t.includes("english-to-french"))).toBe(true);
  });

  it("rejects a clause that happens to have nouns at both ends", () => {
    const terms = conceptsFor(["Attention allows the model to scale."], "", PAPER).map(
      (c) => c.term,
    );
    expect(terms).not.toContain("attention allows the model");
  });

  it("prefers what the paper gave a section to", () => {
    const withHeadings = conceptsFor(
      ["The model uses attention over recurrence for translation."],
      "",
      PAPER,
      ["3.2 Multi-Head Attention", "3.3 Position-wise Feed-Forward Networks"],
    );
    // A heading is the paper naming its own idea, so it outranks a passing
    // mention of something else.
    expect(withHeadings[0]!.term).toContain("attention");
  });

  it("merges every family a bridging term touches, not just the first", () => {
    // Regression: "crash" and "recovery" each started a family before "crash
    // recovery" arrived, and joining whichever it met first left the other
    // standing as a separate idea.
    const paper =
      "Crash recovery is fast. Crash recovery runs in the storage tier. " +
      "Recovery is continuous, and crash recovery avoids a redo pass. " +
      "The crash recovery path is parallel. Recovery happens on every node.";
    const terms = conceptsFor(
      [
        "Crash recovery is fast.",
        "Recovery is continuous.",
        "Crash recovery is parallel.",
      ],
      "",
      paper,
    ).map((c) => c.term);
    const family = terms.filter((t) => t.includes("crash") || t.includes("recovery"));
    expect(family).toHaveLength(1);
  });

  it("folds an acronym into what it stands for", () => {
    // An acronym shares no words with its expansion, so grouping by overlap
    // could never see that these are one idea, and the map carried both.
    const paper =
      "We take the position that small language models (SLMs) are the future. " +
      "SLMs are sufficiently powerful. SLMs are cheaper to run. SLMs are flexible. " +
      "Small language models suit agentic subtasks, and SLMs are easy to fine-tune.";
    const terms = conceptsFor(
      ["SLMs are sufficiently powerful.", "Small language models suit agentic subtasks."],
      "",
      paper,
    ).map((c) => c.term);
    expect(terms).toContain("small language models");
    expect(terms).not.toContain("slms");
  });

  it("checks the initials rather than trusting anything in brackets", () => {
    // Table extraction produces things like "Model BLEUTraining Cost (FLOPs)",
    // which defines nothing.
    const map = acronymExpansions(
      "Model BLEUTraining Cost (FLOPs) and Amazon Web Services (AWS)",
    );
    expect(map.get("flop")).toBeUndefined();
    expect(map.get("aws")).toBe("amazon web services");
  });

  it("counts one initial per part of a hyphenated word", () => {
    // "Retrieval-Augmented Generation" is RAG, not RG, and missing it left
    // both "rag" and its expansion on the map as separate ideas.
    const map = acronymExpansions(
      "We use Retrieval-Augmented Generation (RAG) for context.",
    );
    expect(map.get("rag")).toBe("retrieval-augmented generation");
  });

  it("knows the plural acronym, which is how prose writes it", () => {
    const map = acronymExpansions("small language models (SLMs) are useful");
    expect(map.get("slm")).toBe("small language models");
    expect(map.get("slms")).toBe("small language models");
  });

  it("returns nothing rather than noise when there is nothing to find", () => {
    expect(conceptsFor([], "", PAPER)).toEqual([]);
    expect(conceptsFor(["Totally unrelated wording here."], "", PAPER)).toEqual([]);
  });

  it("ranks the strongest concept first and normalises to it", () => {
    const concepts = conceptsFor(
      ["Attention, attention, and more attention.", "Also the translation task."],
      "",
      PAPER,
    );
    expect(concepts[0]!.weight).toBe(1);
    for (const c of concepts) expect(c.weight).toBeLessThanOrEqual(1);
  });
});

const episode = (
  id: string,
  terms: (string | Partial<Concept>)[],
  paperTitle = id,
): EpisodeSummary & { concepts: Concept[] } =>
  ({
    id,
    createdAt: 1,
    paperTitle,
    minutes: 4,
    format: "dialogue",
    turnCount: 1,
    hasAudio: false,
    summary: "",
    keyPoints: [],
    concepts: terms.map((t, i) => ({
      weight: 1 - i * 0.1,
      context: "",
      ...(typeof t === "string" ? { term: t } : t),
    })),
  }) as never;

const rel = (
  source: string,
  type: ConceptRelationInput["type"],
  target: string,
): ConceptRelationInput => ({
  source,
  type,
  target,
  explanation: `${source} ${type} ${target}`,
  evidence: { text: "quote" },
});

describe("buildConceptMap", () => {
  it("links two concepts that an episode covers together", () => {
    const map = buildConceptMap([episode("a", ["attention", "transformer"])]);
    expect(map.edges).toHaveLength(1);
    expect(map.edges[0]).toMatchObject({
      a: "attention",
      b: "transformer",
      episodes: ["a"],
    });
  });

  it("records every episode that covers a concept", () => {
    const map = buildConceptMap([
      episode("a", ["attention", "transformer"]),
      episode("b", ["attention", "quorum"]),
    ]);
    expect(map.concepts.find((c) => c.term === "attention")!.episodes).toEqual([
      "a",
      "b",
    ]);
  });

  it("puts the most widely shared concept first", () => {
    const map = buildConceptMap([
      episode("a", ["attention", "transformer"]),
      episode("b", ["attention", "quorum"]),
    ]);
    expect(map.concepts[0]!.term).toBe("attention");
  });

  it("names only the concepts that actually join episodes", () => {
    const map = buildConceptMap([
      episode("a", ["attention", "transformer"]),
      episode("b", ["attention", "quorum"]),
    ]);
    expect(sharedConcepts(map).map((c) => c.term)).toEqual(["attention"]);
  });

  it("does not call two episodes of one paper a connection", () => {
    // Regenerating a paper made it share every concept with itself.
    const map = buildConceptMap([
      episode("a", ["attention", "transformer"], "Attention Is All You Need"),
      episode("b", ["attention", "transformer"], "Attention is all you need"),
    ]);
    expect(sharedConcepts(map)).toEqual([]);
    expect(map.concepts.find((c) => c.term === "attention")!.episodes).toEqual([
      "a",
      "b",
    ]);
  });

  it("joins two papers that call one idea by different names", () => {
    const map = buildConceptMap([
      episode("a", [
        { term: "large language model", label: "large language model", aliases: ["LLM"] },
      ]),
      episode("b", [{ term: "llms", label: "LLMs" }]),
    ]);
    expect(map.concepts).toHaveLength(1);
    expect(sharedConcepts(map).map((c) => c.term)).toEqual(["large language model"]);
  });

  it("joins spellings that differ only in case, hyphens, plurals or a leading 'the'", () => {
    const map = buildConceptMap([
      episode("a", [{ term: "the transformer", label: "Transformer" }, "self-attention"]),
      episode("b", ["transformers", "self attention"]),
    ]);
    expect(
      sharedConcepts(map)
        .map((c) => c.term)
        .sort(),
    ).toEqual(["self attention", "transformer"]);
    expect(map.concepts.find((c) => c.term === "transformer")!.label).toBe("Transformer");
  });

  it("carries a definition onto the node", () => {
    const map = buildConceptMap([
      episode("a", [
        { term: "transformer", definition: "A model built only on attention." },
      ]),
    ]);
    expect(map.concepts[0]!.definition).toBe("A model built only on attention.");
  });

  it("names a relation's ends the way it names the concepts", () => {
    const map = buildConceptMap([
      {
        ...episode("a", [
          { term: "the transformer", label: "Transformer" },
          { term: "large language model", aliases: ["LLM"] },
        ]),
        relations: [rel("large language model", "is-a", "the transformer")],
      },
      episode("b", ["llms"]),
    ]);
    expect(map.relations).toHaveLength(1);
    expect(map.relations[0]).toMatchObject({
      source: "large language model",
      type: "is-a",
      target: "transformer",
      episodes: ["a"],
    });
  });

  it("counts one relation stated by two papers once, with both papers", () => {
    const map = buildConceptMap([
      {
        ...episode("a", ["transformer", "self attention"]),
        relations: [rel("self attention", "part-of", "transformer")],
      },
      {
        ...episode("b", ["transformers", "self-attention"]),
        relations: [rel("self-attention", "part-of", "transformers")],
      },
    ]);
    expect(map.relations).toHaveLength(1);
    expect(map.relations[0]!.papers).toHaveLength(2);
  });

  it("drops a relation to a concept the episode does not have", () => {
    const map = buildConceptMap([
      {
        ...episode("a", ["transformer"]),
        relations: [rel("recurrence", "contrasts-with", "transformer")],
      },
    ]);
    expect(map.relations).toEqual([]);
  });

  it("copes with a library of one, which is where everyone starts", () => {
    const map = buildConceptMap([episode("a", ["attention"])]);
    expect(map.concepts).toHaveLength(1);
    expect(map.edges).toEqual([]);
    expect(sharedConcepts(map)).toEqual([]);
  });
});

describe("conceptKey", () => {
  it("normalizes the ways one idea gets spelt", () => {
    expect(conceptKey("The Transformer")).toBe("transformer");
    expect(conceptKey("Self-Attention")).toBe("self attention");
    expect(conceptKey("Large Language Models")).toBe("large language model");
    expect(conceptKey("LLMs")).toBe("llm");
    expect(conceptKey("dependencies")).toBe("dependency");
  });

  it("leaves words that only look plural", () => {
    expect(conceptKey("consensus")).toBe("consensus");
    expect(conceptKey("analysis")).toBe("analysis");
    expect(conceptKey("loss")).toBe("loss");
  });
});
