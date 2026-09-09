/**
 * The library is the only surviving copy of something that cost minutes and
 * money to make, so the cases that matter are the damaged ones: a half-written
 * record, an id that arrived over HTTP, a directory that does not exist yet.
 *
 * These use a real temporary directory rather than a mocked filesystem. The
 * behaviour under test *is* the filesystem behaviour — atomic rename, ENOENT,
 * a directory listing — and mocking it would only assert that the mock works.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEpisode, listEpisodes, removeEpisode, saveEpisode } from "./store";
import { toSummary, type EpisodeRecord } from "./types";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "papercast-library-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = (id: string, over: Partial<EpisodeRecord> = {}): EpisodeRecord => ({
  id,
  createdAt: 1,
  paperTitle: "Amazon Aurora",
  minutes: 4,
  format: "dialogue",
  turnCount: 2,
  summary: "Aurora pushes redo processing into the storage tier.",
  keyPoints: ["The network is the bottleneck."],
  hasAudio: false,
  episode: { summary: "s", keyPoints: ["k"], turns: [{ speaker: "host", text: "hi" }] },
  paper: { title: "Amazon Aurora", abstract: "a", sections: [], wordCount: 2 },
  ...over,
});

describe("the library", () => {
  it("saves an episode and reads it back whole", async () => {
    await saveEpisode(record("a"), dir);
    const back = await getEpisode("a", dir);
    expect(back?.paperTitle).toBe("Amazon Aurora");
    // The paper travels with the record, which is what makes questions
    // answerable after the PDF that produced it is gone.
    expect(back?.paper.title).toBe("Amazon Aurora");
  });

  it("creates the directory rather than failing on the first episode", async () => {
    const fresh = join(dir, "nested", "deeper");
    await saveEpisode(record("a"), fresh);
    expect(await getEpisode("a", fresh)).toBeDefined();
  });

  it("returns undefined for an episode that is not there", async () => {
    expect(await getEpisode("missing", dir)).toBeUndefined();
  });

  it("reports an empty shelf rather than failing when nothing has been saved", async () => {
    expect(await listEpisodes(join(dir, "never-written"))).toEqual([]);
  });

  it("lists newest first", async () => {
    await saveEpisode(record("old", { createdAt: 100 }), dir);
    await saveEpisode(record("new", { createdAt: 200 }), dir);
    expect((await listEpisodes(dir)).map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("leaves the transcript and the paper out of the list", async () => {
    await saveEpisode(record("a"), dir);
    const [summary] = await listEpisodes(dir);
    expect(summary).toBeDefined();
    expect("episode" in summary!).toBe(false);
    expect("paper" in summary!).toBe(false);
    expect(summary!.turnCount).toBe(2);
  });

  it("skips a corrupt record instead of making the whole shelf unopenable", async () => {
    // A machine that lost power mid-write leaves one bad file. Losing every
    // other episode to it would be the worse failure.
    await saveEpisode(record("good"), dir);
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");
    expect((await listEpisodes(dir)).map((e) => e.id)).toEqual(["good"]);
  });

  it("leaves no temporary file behind after a save", async () => {
    await saveEpisode(record("a"), dir);
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses an id that would escape the directory", async () => {
    // Ids reach this from a URL path segment.
    await expect(getEpisode("../../etc/passwd", dir)).rejects.toThrow(
      /valid episode id/i,
    );
    await expect(getEpisode("a/b", dir)).rejects.toThrow(/valid episode id/i);
  });

  it("keeps the summary on the shelf without loading the transcript", async () => {
    await saveEpisode(record("a"), dir);
    const [summary] = await listEpisodes(dir);
    expect(summary!.summary).toContain("redo processing");
    expect(summary!.keyPoints).toHaveLength(1);
    expect("episode" in summary!).toBe(false);
  });

  it("finds the summary of an episode saved before it moved to the top level", async () => {
    // Older records carry it only on the episode. Reading it from there keeps
    // them showing a summary rather than needing a migration.
    const old = record("legacy");
    delete (old as Partial<EpisodeRecord>).summary;
    delete (old as Partial<EpisodeRecord>).keyPoints;
    old.episode.summary = "An older episode, summarised inside the episode.";
    old.episode.keyPoints = ["Still here."];
    await saveEpisode(old, dir);

    const [summary] = await listEpisodes(dir);
    expect(summary!.summary).toBe("An older episode, summarised inside the episode.");
    expect(summary!.keyPoints).toEqual(["Still here."]);
  });

  it("removes an episode, and stays quiet about one already gone", async () => {
    await saveEpisode(record("a"), dir);
    await removeEpisode("a", dir);
    expect(await getEpisode("a", dir)).toBeUndefined();
    await expect(removeEpisode("a", dir)).resolves.toBeUndefined();
  });
});

describe("toSummary", () => {
  it("keeps what a list needs and drops what it does not", () => {
    const s = toSummary(record("a", { model: "qwen2:7b", totalMs: 1000 }));
    expect(s.model).toBe("qwen2:7b");
    expect(s.totalMs).toBe(1000);
    expect(Object.keys(s)).not.toContain("episode");
  });
});
