/**
 * Finishing an episode that stopped early.
 *
 * The risks are structural rather than editorial: a continuation that opens on
 * the wrong speaker breaks an error-level check, and one that restarts leaves
 * the listener hearing a second greeting. Both are tested here; whether the
 * prose is good is the judge's problem, not this file's.
 */
import { describe, it, expect } from "vitest";
import { FAITHFULNESS, NO_HYPE } from "./promptShared";
import {
  appendTurns,
  buildContinuationRequest,
  continueEpisode,
  nextSpeaker,
} from "./continueEpisode";
import { generateEpisode } from "./generateEpisode";
import type { Episode } from "./schema";
import type { PaperStructure } from "../pdf/extract";
import type { LLMProvider, StructuredRequest, StructuredResult } from "./types";

const PAPER: PaperStructure = {
  title: "A Test Paper",
  abstract: "We test things.",
  sections: [{ heading: "Introduction", content: "Testing is good." }],
  wordCount: 6,
};

/**
 * Roughly `chars` characters of plausible speech.
 *
 * Length is judged in characters now, so a fixture of "w0 w1 w2" would imply a
 * duration nothing like the word count suggests — which is the exact confusion
 * these tests exist to pin down.
 */
const speech = (chars: number, tag = "research") => {
  let out = "";
  while (out.length < chars) out += `${tag} attention models trained `;
  return out.slice(0, chars).trim();
};

const dialogue: Episode = {
  summary: "s",
  keyPoints: ["k"],
  turns: [
    { speaker: "host", text: speech(140) },
    { speaker: "guest", text: speech(140) },
  ],
};

const solo: Episode = {
  summary: "s",
  keyPoints: ["k"],
  turns: [{ speaker: "narrator", text: speech(280) }],
};

/** Answers the first call with `first`, and every later call with `rest`. */
class ScriptedProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  readonly requests: StructuredRequest<unknown>[] = [];
  constructor(
    private readonly first: unknown,
    private readonly rest: unknown[] = [],
  ) {}
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const i = this.requests.length;
    this.requests.push(req as StructuredRequest<unknown>);
    const body = i === 0 ? this.first : (this.rest[i - 1] ?? { turns: [] });
    return {
      data: req.schema.parse(body),
      usage: { inputTokens: 10, outputTokens: 20 },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

describe("nextSpeaker", () => {
  it("alternates a dialogue and never moves a monologue off narrator", () => {
    expect(nextSpeaker(dialogue, "dialogue")).toBe("host");
    expect(nextSpeaker({ ...dialogue, turns: [dialogue.turns[0]!] }, "dialogue")).toBe(
      "guest",
    );
    expect(nextSpeaker(solo, "solo")).toBe("narrator");
    expect(nextSpeaker(dialogue, "eli5")).toBe("narrator");
  });
});

describe("buildContinuationRequest", () => {
  it("tells the model where to pick up and what voice to use", () => {
    const req = buildContinuationRequest({
      episode: dialogue,
      wordsWanted: 400,
      turnsWanted: 8,
      format: "dialogue",
      nextSpeaker: "host",
    });
    expect(req).toContain("400 words longer");
    expect(req).toContain("8 more turns");
    expect(req).toContain('speaker "host"');
    // The seam is the thing to design against, so the instruction is explicit.
    expect(req).toMatch(/do not greet the listener/i);
    expect(req).toMatch(/end the episode properly/i);
  });

  it("shows the tail rather than the whole script", () => {
    const long: Episode = {
      ...solo,
      turns: Array.from({ length: 20 }, (_, i) => ({
        speaker: "narrator" as const,
        text: `turn number ${i}`,
      })),
    };
    const req = buildContinuationRequest({
      episode: long,
      wordsWanted: 100,
      turnsWanted: 2,
      format: "solo",
      nextSpeaker: "narrator",
    });
    expect(req).toContain("turn number 19");
    expect(req).not.toContain("turn number 5");
  });
});

describe("appendTurns", () => {
  it("keeps a continuation that alternates correctly", () => {
    const got = appendTurns(
      dialogue,
      [
        { speaker: "host", text: "a" },
        { speaker: "guest", text: "b" },
      ],
      "dialogue",
    );
    expect(got.turns.map((t) => t.speaker)).toEqual(["host", "guest", "host", "guest"]);
  });

  it("drops a turn on the wrong voice rather than breaking alternation", () => {
    // Trading a length failure for a structural one is not a fix: strict
    // alternation is an error-level check where length is a warning.
    const got = appendTurns(
      dialogue,
      [
        { speaker: "guest", text: "wrong" },
        { speaker: "host", text: "right" },
      ],
      "dialogue",
    );
    expect(got.turns).toHaveLength(3);
    expect(got.turns.at(-1)!.text).toBe("right");
  });

  it("refuses a second voice in a monologue", () => {
    const got = appendTurns(
      solo,
      [
        { speaker: "host", text: "wrong" },
        { speaker: "narrator", text: "right" },
      ],
      "solo",
    );
    expect(got.turns).toHaveLength(2);
    expect(got.turns.every((t) => t.speaker === "narrator")).toBe(true);
  });

  it("leaves the summary and key points alone", () => {
    const got = appendTurns(solo, [{ speaker: "narrator", text: "more" }], "solo");
    expect(got.summary).toBe(solo.summary);
    expect(got.keyPoints).toEqual(solo.keyPoints);
  });
});

describe("continueEpisode", () => {
  it("asks only for turns, and holds the continuation to the same faithfulness rules", async () => {
    const provider = new ScriptedProvider({
      turns: [{ speaker: "narrator", text: "x" }],
    });
    await continueEpisode(PAPER, solo, {
      provider,
      wordsWanted: 300,
      turnsWanted: 5,
      format: "solo",
    });
    const req = provider.requests[0]!;
    expect(req.schemaName).toBe("continuation");
    expect(req.system.toLowerCase()).toContain("use only");
    // The paper rides in the cacheable slot, so a provider that caches the
    // prefix pays for it once across both calls.
    expect(req.cacheableContext).toContain("A Test Paper");
  });
});

describe("generateEpisode, when the first call comes back short", () => {
  it("continues, and reports that it did", async () => {
    const short = {
      summary: "s",
      keyPoints: ["k"],
      turns: [{ speaker: "narrator", text: speech(1_000) }],
    };
    const rest = { turns: [{ speaker: "narrator", text: speech(4_000, "further") }] };
    const provider = new ScriptedProvider(short, [rest]);

    const got = await generateEpisode(PAPER, { provider, minutes: 5, format: "solo" });

    expect(provider.requests).toHaveLength(2);
    expect(got.continuations).toBe(1);
    expect(got.episode.turns).toHaveLength(2);
    expect(got.length.short).toBe(false);
    // One bill across both calls, or the reported cost understates the run.
    expect(got.usage.outputTokens).toBe(40);
  });

  it("does not continue an episode that already hit its target", async () => {
    const full = {
      summary: "s",
      keyPoints: ["k"],
      turns: [{ speaker: "narrator", text: speech(5_200) }],
    };
    const provider = new ScriptedProvider(full);
    const got = await generateEpisode(PAPER, { provider, minutes: 5, format: "solo" });
    expect(provider.requests).toHaveLength(1);
    expect(got.continuations).toBe(0);
    expect(got.length.short).toBe(false);
  });

  it("delivers a still-short episode rather than looping, and says it is short", async () => {
    const short = {
      summary: "s",
      keyPoints: ["k"],
      turns: [{ speaker: "narrator", text: speech(500) }],
    };
    const provider = new ScriptedProvider(short, [
      { turns: [{ speaker: "narrator", text: speech(500, "further") }] },
    ]);
    const got = await generateEpisode(PAPER, { provider, minutes: 5, format: "solo" });
    expect(provider.requests).toHaveLength(2);
    expect(got.length.short).toBe(true);
    expect(got.episode.turns).toHaveLength(2);
  });

  it("stops asking when a continuation adds nothing", async () => {
    // A pass that returns no usable turns has said it has nothing more; asking
    // again spends money to be told so twice.
    const short = {
      summary: "s",
      keyPoints: ["k"],
      turns: [{ speaker: "narrator", text: speech(500) }],
    };
    const provider = new ScriptedProvider(short, [{ turns: [] }, { turns: [] }]);
    const got = await generateEpisode(PAPER, {
      provider,
      minutes: 5,
      format: "solo",
      maxContinuations: 3,
    });
    expect(provider.requests).toHaveLength(2);
    expect(got.length.short).toBe(true);
  });

  it("can be switched off", async () => {
    const short = {
      summary: "s",
      keyPoints: ["k"],
      turns: [{ speaker: "narrator", text: speech(500) }],
    };
    const provider = new ScriptedProvider(short);
    const got = await generateEpisode(PAPER, {
      provider,
      minutes: 5,
      format: "solo",
      maxContinuations: 0,
    });
    expect(provider.requests).toHaveLength(1);
    expect(got.length.short).toBe(true);
  });
});

describe("the continuation is held to the writer's standard", () => {
  it("carries the rules that are shared rather than a paraphrase of them", async () => {
    const provider = new ScriptedProvider({
      turns: [{ speaker: "narrator", text: "x" }],
    });
    await continueEpisode(PAPER, solo, {
      provider,
      wordsWanted: 300,
      turnsWanted: 5,
      format: "solo",
    });
    // Byte-identical, not similar: a second copy of these rules is a second
    // standard however carefully it is worded. The first real continuation run
    // was written without the second of these and closed the episode by calling
    // the paper "a paradigm shift".
    const system = provider.requests[0]!.system;
    expect(system).toContain(FAITHFULNESS);
    expect(system).toContain(NO_HYPE);
  });
});
