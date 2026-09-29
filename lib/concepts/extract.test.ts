/**
 * A model names the concepts; these check what is done with what it names.
 * Mostly what is *refused* — an idea the paper never discusses, the paper's own
 * title — because a concept map is only worth reading if every node on it is
 * something the paper is actually about.
 */
import { describe, it, expect } from "vitest";
import {
  ConceptExtractionSchema,
  extractConcepts,
  groundConcepts,
  groundRelations,
  paperDigest,
  toMapConcepts,
  toMapRelations,
  type ConceptExtraction,
  type PaperConcept,
} from "./extract";
import type { PaperStructure } from "../pdf/extract";
import type { LLMProvider, StructuredRequest, StructuredResult } from "../llm/types";

const PAPER: PaperStructure = {
  title: "Attention Is All You Need",
  abstract:
    "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
  sections: [
    {
      heading: "3.2 Attention",
      content:
        "An attention function can be described as mapping a query and a set of key-value pairs to an output. Self-attention relates different positions of a single sequence.",
    },
    {
      heading: "3.2.2 Multi-Head Attention",
      content:
        "Multi-head attention allows the model to jointly attend to information from different representation subspaces at different positions.",
    },
  ],
  wordCount: 60,
};

type Extracted = ConceptExtraction["concepts"][number];
type ExtractedRelation = ConceptExtraction["relations"][number];

const relation = (over: Partial<ExtractedRelation>): ExtractedRelation => ({
  source: "multi-head attention",
  type: "part-of",
  target: "Transformer",
  explanation: "Multi-head attention is a component of the Transformer.",
  evidence:
    "Multi-head attention allows the model to jointly attend to information from different representation subspaces",
  ...over,
});

const KEPT: PaperConcept[] = [
  { name: "Transformer", aliases: [], definition: "d", importance: "core" },
  {
    name: "multi-head attention",
    aliases: ["MHA"],
    definition: "d",
    importance: "supporting",
  },
  { name: "self-attention", aliases: [], definition: "d", importance: "supporting" },
];

const concept = (over: Partial<Extracted>): Extracted => ({
  name: "Transformer",
  aliases: [],
  definition: "A sequence model built only from attention.",
  importance: "core",
  evidence: "We propose a new simple network architecture, the Transformer",
  ...over,
});

/** Returns whatever concepts it is constructed with, recording the request. */
class StubProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  last?: StructuredRequest<unknown>;
  constructor(
    private concepts: Extracted[],
    private relations: ExtractedRelation[] = [],
  ) {}
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.last = req as StructuredRequest<unknown>;
    return {
      data: req.schema.parse({ concepts: this.concepts, relations: this.relations }),
      usage: { inputTokens: 900, outputTokens: 300 },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

describe("groundConcepts", () => {
  it("keeps the Transformer, which the lexical extractor never found", () => {
    const kept = groundConcepts(PAPER, [concept({})]);
    expect(kept.map((c) => c.name)).toEqual(["Transformer"]);
  });

  it("drops an idea the paper never discusses", () => {
    // The concept map's version of a fabricated citation.
    const kept = groundConcepts(PAPER, [
      concept({
        name: "Reinforcement learning from human feedback",
        evidence:
          "We fine-tune the policy with a learned reward model from human preferences",
      }),
    ]);
    expect(kept).toEqual([]);
  });

  it("keeps a canonical name the paper spells differently, when its quote is found", () => {
    const kept = groundConcepts(PAPER, [
      concept({
        name: "Scaled key-value retrieval",
        evidence:
          "An attention function can be described as mapping a query and a set of key-value pairs to an output",
      }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.evidence?.text).toContain("mapping a query");
  });

  it("accepts a name the paper only uses through its alias", () => {
    const paper: PaperStructure = {
      ...PAPER,
      abstract: "We study RAG pipelines for tutoring, where RAG supplies the context.",
    };
    const kept = groundConcepts(paper, [
      concept({
        name: "retrieval-augmented generation",
        aliases: ["RAG"],
        evidence: "a quote the model paraphrased beyond recognition entirely",
      }),
    ]);
    expect(kept.map((c) => c.name)).toEqual(["retrieval-augmented generation"]);
  });

  it("finds a name through a plural or a hyphen", () => {
    const kept = groundConcepts(PAPER, [
      concept({
        name: "self attention",
        evidence: "not a real quote from this paper at all",
      }),
      concept({
        name: "attention mechanism",
        evidence: "not a real quote from this paper either",
      }),
    ]);
    expect(kept.map((c) => c.name)).toEqual(["self attention", "attention mechanism"]);
  });

  it("refuses the paper's own title as a concept", () => {
    const kept = groundConcepts(PAPER, [
      concept({
        name: "Attention Is All You Need",
        evidence: "Attention Is All You Need",
      }),
    ]);
    expect(kept).toEqual([]);
  });

  it("keeps the first of two concepts with the same name", () => {
    const kept = groundConcepts(PAPER, [
      concept({}),
      concept({ definition: "A second, worse definition." }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.definition).toBe("A sequence model built only from attention.");
  });

  it("drops an alias that only repeats the name", () => {
    const kept = groundConcepts(PAPER, [concept({ aliases: ["transformer", " "] })]);
    expect(kept[0]!.aliases).toEqual([]);
  });
});

describe("groundRelations", () => {
  it("keeps a relation between two kept concepts whose quote is found", () => {
    const kept = groundRelations(PAPER, KEPT, [relation({})]);
    expect(kept).toEqual([
      expect.objectContaining({
        source: "multi-head attention",
        type: "part-of",
        target: "Transformer",
      }),
    ]);
    expect(kept[0]!.evidence.text).toContain("jointly attend");
  });

  it("drops a relation whose quote cannot be found", () => {
    // A concept can be vouched for by its name; a relation only by a passage.
    const kept = groundRelations(PAPER, KEPT, [
      relation({
        evidence:
          "The Transformer is composed of several multi-head attention blocks stacked",
      }),
    ]);
    expect(kept).toEqual([]);
  });

  it("drops a relation to a concept that did not survive grounding", () => {
    const kept = groundRelations(PAPER, KEPT, [relation({ target: "Protein folding" })]);
    expect(kept).toEqual([]);
  });

  it("resolves an end given by alias, case or hyphenation to the concept's name", () => {
    const kept = groundRelations(PAPER, KEPT, [
      relation({ source: "MHA", target: "transformer" }),
      relation({
        source: "Self Attention",
        type: "used-for",
        target: "multi-head attention",
      }),
    ]);
    expect(kept.map((r) => [r.source, r.target])).toEqual([
      ["multi-head attention", "Transformer"],
      ["self-attention", "multi-head attention"],
    ]);
  });

  it("drops a concept related to itself", () => {
    const kept = groundRelations(PAPER, KEPT, [
      relation({ source: "MHA", type: "is-a", target: "multi-head attention" }),
    ]);
    expect(kept).toEqual([]);
  });

  it("treats a contrast in either direction as one relation", () => {
    const contrast = { type: "contrasts-with" as const };
    const kept = groundRelations(PAPER, KEPT, [
      relation({ ...contrast, source: "Transformer", target: "self-attention" }),
      relation({ ...contrast, source: "self-attention", target: "Transformer" }),
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe("paperDigest", () => {
  it("carries the title, abstract and every heading", () => {
    const digest = paperDigest(PAPER);
    expect(digest).toContain("TITLE: Attention Is All You Need");
    expect(digest).toContain("the Transformer, based solely on attention");
    expect(digest).toContain("- 3.2.2 Multi-Head Attention");
  });

  it("stays bounded however long the paper is", () => {
    const long: PaperStructure = {
      ...PAPER,
      sections: Array.from({ length: 200 }, (_, i) => ({
        heading: `Section ${i}`,
        content: "word ".repeat(2000),
      })),
    };
    // Headings are always included; the openings are what the cap trims.
    expect(paperDigest(long).length).toBeLessThan(16_000 + 200 * 20);
  });
});

describe("extractConcepts", () => {
  it("returns grounded concepts and names the ones it dropped", async () => {
    const provider = new StubProvider([
      concept({}),
      concept({
        name: "Protein folding",
        evidence: "We predict the structure of proteins from sequence",
      }),
    ]);
    const result = await extractConcepts(PAPER, provider);
    expect(result.concepts.map((c) => c.name)).toEqual(["Transformer"]);
    expect(result.dropped).toEqual(["Protein folding"]);
    expect(result.relations).toEqual([]);
    expect(result.usage.outputTokens).toBe(300);
  });

  it("grounds relations against the concepts it kept", async () => {
    const provider = new StubProvider(
      [concept({}), concept({ name: "multi-head attention", importance: "supporting" })],
      [relation({}), relation({ source: "Protein folding" })],
    );
    const result = await extractConcepts(PAPER, provider);
    expect(result.relations.map((r) => `${r.source} ${r.type} ${r.target}`)).toEqual([
      "multi-head attention part-of Transformer",
    ]);
    expect(result.droppedRelations).toBe(1);
  });

  it("sends the digest, not the whole paper", async () => {
    const provider = new StubProvider([]);
    await extractConcepts(PAPER, provider);
    expect(provider.last!.user).toContain("SECTION HEADINGS:");
    expect(provider.last!.schemaName).toBe("concepts");
  });

  it("uses a schema any provider's strict mode accepts", () => {
    // Every field required: OpenAI strict json_schema rejects optional ones.
    for (const list of [
      ConceptExtractionSchema.shape.concepts,
      ConceptExtractionSchema.shape.relations,
    ]) {
      for (const field of Object.values(list.element.shape)) {
        expect(field.isOptional()).toBe(false);
      }
    }
  });
});

describe("toMapConcepts", () => {
  it("keeps the display name and weights by importance", () => {
    const [core, background] = toMapConcepts([
      { name: "Transformer", aliases: [], definition: "d", importance: "core" },
      { name: "RNN", aliases: [], definition: "d", importance: "background" },
    ]);
    expect(core).toMatchObject({ term: "transformer", label: "Transformer", weight: 1 });
    expect(background!.weight).toBeLessThan(core!.weight);
  });
});

describe("toMapRelations", () => {
  it("keys the ends the way the map keys concepts", () => {
    const [r] = toMapRelations([
      {
        source: "Multi-Head Attention",
        target: "Transformer",
        type: "part-of",
        explanation: "e",
        evidence: { text: "q", page: 5 },
      },
    ]);
    expect(r).toMatchObject({
      source: "multi-head attention",
      target: "transformer",
      type: "part-of",
    });
    expect(r!.evidence.page).toBe(5);
  });
});
