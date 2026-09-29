/**
 * Running a paper through the whole pipeline as a job.
 *
 * The stages already existed as separate commands; what this adds is a single
 * flow that reports where it is. Generation and synthesis each take tens of
 * seconds, and a minute of silence is indistinguishable from a hang, so every
 * step publishes progress as it goes.
 *
 * Framework-agnostic on purpose: it takes a store and emits into it, so an
 * Express route, a Next.js handler, or a test can all drive the same code.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extractPaper } from "../pdf/extract";
import { generateEpisode } from "../llm/generateEpisode";
import { describeShortfall } from "../llm/length";
import { annotate, capturePayloads, truncate } from "../trace/tracer";
import { metadata, tags } from "../trace/langsmith";
import { getProvider } from "../llm/index";
import type { ProviderName } from "../config/env";
import {
  resolveFallbackTTS,
  resolveTTSProvider,
  synthesizeEpisode,
  type TTSProviderName,
} from "../tts/index";
import { sliceWav } from "../tts/wav";
import { runAudioChecks } from "../eval/audioChecks";
import { WhisperCppProvider, whisperAvailable } from "../asr/index";
import { verifyPerTurn } from "../eval/transcriptFidelity";
import { estimateCost } from "../eval/report";
import { toJobError } from "./errors";
import { refineEpisode } from "../refine/index";
import { groundTurns } from "../ground/index";
import { extractConcepts } from "../concepts/extract";
import { saveEpisode } from "../library/store";
import type { EpisodeRecord } from "../library/types";
import type { EpisodeFormat } from "../llm/generateEpisode";
import { withSpan } from "../trace/tracer";
import * as TA from "../trace/attributes";
import { addUsage } from "../llm/usage";
import { loadLedger, recordEpisode, saveLedger } from "../learning/index";
import {
  activeStages,
  overallPercent,
  type JobError,
  type JobReview,
  type JobStage,
} from "./types";
import type { JobPatch, JobStore } from "./store";

export interface RunJobInput {
  pdf: Buffer;
  minutes: number;
  provider?: ProviderName;
  ttsProvider?: TTSProviderName;
  verify: boolean;
  /**
   * Fact-check the script and rewrite the turns that fail. Off by default: it
   * costs two judge passes plus a revision, roughly doubling the LLM bill.
   */
  revise?: boolean;
  /** Revision rounds to attempt when `revise` is on. */
  reviseRounds?: number;
  /** Identifier the study ledger files this paper under. */
  paperId?: string;
  /** Authoritative title, when the caller knows it better than extraction can. */
  paperTitle?: string;
  /** Where to write the finished audio, when audio is wanted. */
  audioPath?: string;
  /** Two voices, one voice, or one voice explaining to a child. */
  format?: EpisodeFormat;
}

/**
 * Root span for the whole job, so every model call below lands in one trace.
 *
 * Delegating rather than indenting the body keeps this addition from touching a
 * line of the pipeline itself, and leaves the exported signature identical.
 */
export async function runJob(
  store: JobStore,
  jobId: string,
  input: RunJobInput,
): Promise<void> {
  return withSpan(
    "invoke_workflow paper-to-podcast",
    {
      [TA.GEN_AI_OPERATION_NAME]: "invoke_workflow",
      [TA.GEN_AI_WORKFLOW_NAME]: "paper-to-podcast",
      ...tags(
        "episode",
        input.format ?? "dialogue",
        input.provider,
        input.revise && "revise",
        input.verify && "verify",
        input.audioPath ? "audio" : "transcript-only",
      ),
      ...metadata({
        job_id: jobId,
        paper_id: input.paperId,
        minutes: input.minutes,
        format: input.format ?? "dialogue",
      }),
      [TA.PAPERCAST_JOB_ID]: jobId,
      [TA.PAPERCAST_MINUTES]: input.minutes,
      [TA.PAPERCAST_REVISE]: input.revise === true,
      [TA.PAPERCAST_VERIFY]: input.verify,
    },
    () => runJobStages(store, jobId, input),
  );
}

/**
 * Put a finished episode on the shelf.
 *
 * Best-effort, like the study ledger: an episode that was produced and can be
 * listened to right now must not be turned into a failure because a disk write
 * did not work. It simply will not be there tomorrow, and the log says why.
 */
async function shelve(record: EpisodeRecord): Promise<void> {
  try {
    await saveEpisode(record);
  } catch (err) {
    console.warn(`[job ${record.id}] could not save the episode to the library:`, err);
  }
}

/** Anchor turns to the paper, or return nothing. Never throws. */
function ground(
  episode: Parameters<typeof groundTurns>[0],
  paper: Parameters<typeof groundTurns>[1],
) {
  try {
    return groundTurns(episode, paper);
  } catch (err) {
    console.warn("[job] could not anchor turns to the paper:", err);
    return undefined;
  }
}

/**
 * Name the paper's key concepts for the concept map, or return nothing.
 *
 * A model call, so it can fail the way review can; an episode that was produced
 * must not be lost to it. Without stored concepts the map falls back to the
 * lexical ones for this episode.
 */
async function mapConcepts(
  jobId: string,
  paper: Parameters<typeof extractConcepts>[0],
  provider?: ProviderName,
) {
  try {
    return await extractConcepts(paper, provider ? getProvider(provider) : getProvider());
  } catch (err) {
    console.warn(`[job ${jobId}] could not extract concepts:`, err);
    return undefined;
  }
}

async function runJobStages(
  store: JobStore,
  jobId: string,
  input: RunJobInput,
): Promise<void> {
  // Percentages are normalized over the stages this particular run will pass
  // through, so skipping review or verification does not jump the bar.
  const stages = activeStages({
    revise: input.revise === true,
    audio: Boolean(input.audioPath),
    verify: input.verify,
  });
  /**
   * The stage the job is in right now.
   *
   * The terminal update overwrites `stage` with "error", so by the time a
   * failure is recorded the one fact anybody wants — where did it break — has
   * already been thrown away. Every write goes through `update`, so this stays
   * current without each call site having to remember.
   */
  let current: JobStage = "queued";
  const update = (patch: JobPatch) => {
    if (patch.stage) current = patch.stage;
    return store.update(jobId, patch);
  };

  const step = (
    stage: Parameters<typeof overallPercent>[0],
    within: number,
    message: string,
  ) =>
    update({
      stage,
      percent: overallPercent(stage, within, stages),
      message,
    });

  /**
   * Progress reported from inside another module's `onProgress` callback, which
   * is synchronous by contract and cannot await a store write. These are started
   * and not waited on: losing a progress tick is no reason to fail an episode
   * that is otherwise fine. Keeping concurrent writes in order is the store's
   * problem — a Map has no ordering to lose, and a networked store serializes
   * per job.
   */
  const emit = (patch: JobPatch) => {
    void update(patch).catch((err) => {
      console.warn(`[job ${jobId}] could not record progress:`, err);
    });
  };

  try {
    await step("parsing", 0, "Reading the paper");
    // Extraction takes the first block of text on page one for the title, which
    // is right for most papers and wrong for the ones that open with a
    // publisher's notice — arXiv's copy of the transformer paper begins with
    // Google's permission to reproduce its figures. A caller that knows the
    // title for certain, as the demo shelf does, says so rather than letting a
    // legal footer travel into the prompt as the subject of the episode.
    const extracted = await extractPaper(input.pdf);
    const paper = input.paperTitle
      ? { ...extracted, title: input.paperTitle }
      : extracted;
    await update({
      paperTitle: paper.title,
      percent: overallPercent("parsing", 1, stages),
      message: `Parsed ${paper.sections.length} sections, ${paper.wordCount} words`,
    });

    await step("scripting", 0, "Writing the episode");
    const generated = await generateEpisode(paper, {
      minutes: input.minutes,
      provider: input.provider ? getProvider(input.provider) : undefined,
      format: input.format,
      // A continuation is a second model call, so it is worth saying why the
      // wait got longer rather than letting the bar sit still.
      onContinuation: () =>
        emit({
          percent: overallPercent("scripting", 0.7, stages),
          message: "The episode came back short — asking for the rest",
        }),
    });
    // LLM spend accumulates across scripting and review; the store replaces cost
    // fields rather than adding to them, so the running total lives here. It
    // rides along with a real progress update — a cost-only update would emit an
    // event with nothing to say.
    let llmUsage = generated.usage;
    const costSoFar = () => ({
      llmInputTokens: llmUsage.inputTokens ?? 0,
      llmOutputTokens: llmUsage.outputTokens ?? 0,
      llmCachedTokens: llmUsage.cacheReadTokens ?? 0,
      usd: estimateCost(generated.model, llmUsage),
    });

    // Length used to be invisible: the only check on it lives in the eval
    // harness, which an ordinary run never touches, so an episode that came
    // back at a third of its length reached the listener with nothing anywhere
    // saying so. It is reported here whether or not it is a problem, because a
    // number a person can compare to what they asked for is the whole fix.
    const { length } = generated;
    const shortfall = describeShortfall(length);
    // The script and its measurements go on the run itself. The transcript is
    // the thing the whole pipeline exists to produce, so it rides only with
    // payload capture on — the same rule the prompts follow.
    annotate({
      [TA.PAPERCAST_WORDS]: length.words,
      [TA.PAPERCAST_CHARS]: length.chars,
      [TA.PAPERCAST_ESTIMATED_MINUTES]: Number(length.estimatedMinutes.toFixed(2)),
      [TA.PAPERCAST_LENGTH_RATIO]: Number(length.ratio.toFixed(3)),
      [TA.PAPERCAST_CONTINUATIONS]: generated.continuations,
      ...(capturePayloads()
        ? {
            [TA.PAPERCAST_TRANSCRIPT]: truncate(
              generated.episode.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n\n"),
            ),
            [TA.PAPERCAST_SUMMARY]: truncate(generated.episode.summary, 1_000),
            [TA.PAPERCAST_KEY_POINTS]: generated.episode.keyPoints.join(" · "),
          }
        : {}),
    });
    await update({
      percent: overallPercent("scripting", 1, stages),
      message:
        `Wrote ${length.turns} turns · ${length.words} words (~${length.estimatedMinutes.toFixed(1)} min)` +
        (generated.continuations > 0 ? ", after a continuation" : "") +
        (shortfall ? ` — still short: ${shortfall}` : ""),
      cost: costSoFar(),
    });

    // The script the rest of the pipeline works from. Review may replace it.
    let episode = generated.episode;
    let review: JobReview | undefined;
    let reviewError: JobError | undefined;

    // Review is an enhancement on top of a script that is already finished, so
    // it is best-effort in the same way the study ledger is: a judge that fails
    // — a small local model that cannot hold the claims schema, say — must not
    // destroy an episode that was generated successfully. The failure is
    // reported rather than swallowed, because an absent review must not be
    // mistaken for a clean one.
    if (input.revise) {
      try {
        const provider = input.provider ? getProvider(input.provider) : getProvider();
        const refined = await refineEpisode(episode, paper, {
          provider,
          maxRounds: input.reviseRounds,
          onProgress: (round, of, message) =>
            emit({
              stage: "reviewing",
              // Round 0 is the first fact-check; each round after it is a repair
              // plus a re-check, so progress is measured over rounds + 1 steps.
              percent: overallPercent("reviewing", round / (of + 1), stages),
              message,
            }),
        });

        const before = refined.rounds[0]!;
        const kept = refined.rounds.find((r) => r.round === refined.bestRound) ?? before;
        episode = refined.episode;
        llmUsage = addUsage(llmUsage, refined.usage);
        review = {
          faithfulnessBefore: before.faithfulness.faithfulness,
          faithfulnessAfter: kept.faithfulness.faithfulness,
          failuresBefore: before.failures,
          failuresAfter: kept.failures,
          revisedTurns: kept.revisedTurns,
          rounds: refined.rounds.length - 1,
          improved: refined.improved,
        };

        await update({
          percent: overallPercent("reviewing", 1, stages),
          message: review.improved
            ? `Repaired ${review.revisedTurns.length} turns · ${review.failuresBefore} → ${review.failuresAfter} unsupported claims`
            : review.failuresBefore === 0
              ? "Every claim checks out against the paper"
              : `Kept the original: no rewrite improved on ${review.failuresBefore} unsupported claims`,
          cost: costSoFar(),
        });
      } catch (err) {
        console.warn(`[job ${jobId}] the fact-check did not complete:`, err);
        reviewError = toJobError(err);
        await update({
          stage: "reviewing",
          percent: overallPercent("reviewing", 1, stages),
          message: "Could not fact-check the script — delivering it unchecked",
          cost: costSoFar(),
        });
      }
    }

    // Anchoring is lexical and local: no model, no key, no judge. It runs after
    // review because review may have rewritten the turns, and a reference must
    // describe the script that was actually kept. Best-effort like the ledger —
    // a failure to place turns must never cost an episode that was produced.
    const citations = ground(episode, paper);
    annotate({
      [TA.PAPERCAST_CITED_TURNS]: citations?.length ?? 0,
      [TA.PAPERCAST_UNCITED_TURNS]: episode.turns.length - (citations?.length ?? 0),
    });

    const concepts = await mapConcepts(jobId, paper, input.provider);
    if (concepts) llmUsage = addUsage(llmUsage, concepts.usage);

    if (!input.audioPath) {
      await shelve({
        id: jobId,
        createdAt: Date.now(),
        paperTitle: paper.title,
        paperId: input.paperId,
        minutes: input.minutes,
        format: input.format ?? "dialogue",
        provider: generated.provider,
        model: generated.model,
        turnCount: episode.turns.length,
        summary: episode.summary,
        keyPoints: episode.keyPoints,
        hasAudio: false,
        review,
        // No synthesis happened on this path, so the call count is honestly zero
        // rather than absent.
        cost: { ...costSoFar(), ttsCalls: 0 },
        episode,
        citations,
        paper,
        concepts: concepts?.concepts,
        relations: concepts?.relations,
      });
      await update({
        stage: "done",
        percent: 100,
        message: "Transcript ready",
        result: { episode, review, reviewError, citations },
      });
      return;
    }

    await step("synthesizing", 0, "Recording the episode");
    const tts = await resolveTTSProvider(input.ttsProvider);
    // A hosted voice can be busy or down in a way a local one cannot, and by
    // this point the episode has already cost model calls. Losing it to a
    // preview endpoint under load is the worse outcome, so a local backend
    // remakes it rather than the job failing.
    const backupTts = await resolveFallbackTTS(tts);
    const audio = await synthesizeEpisode(episode, {
      provider: tts,
      fallback: backupTts,
      onFallback: (err, to) =>
        emit({
          percent: overallPercent("synthesizing", 0, stages),
          message: `${tts.name} could not record this — starting again with ${to.name}`,
        }),
      onProgress: (done, total) =>
        emit({
          percent: overallPercent("synthesizing", done / total, stages),
          message: `Recording turn ${done} of ${total}`,
        }),
    });
    await writeFile(input.audioPath, audio.audio);
    annotate({
      [TA.PAPERCAST_TTS_PROVIDER]: audio.provider,
      [TA.PAPERCAST_VOICES]: audio.voices,
      [TA.PAPERCAST_TTS_CALLS]: audio.calls,
      ...(audio.fellBackFrom
        ? { [TA.PAPERCAST_TTS_FELL_BACK_FROM]: audio.fellBackFrom }
        : {}),
    });

    const checks = runAudioChecks({
      episode,
      audio,
      targetMinutes: input.minutes,
    });
    await update({
      percent: overallPercent("synthesizing", 1, stages),
      message:
        `Recorded ${(audio.totalMs / 1000 / 60).toFixed(1)} minutes · ${checks.errors} audio errors` +
        (audio.fellBackFrom
          ? ` · ${audio.fellBackFrom} was unavailable, ${audio.provider} recorded it`
          : ""),
      cost: { ttsCalls: audio.calls },
    });

    let transcriptRecall: number | undefined;
    if (input.verify && (await whisperAvailable())) {
      await step("verifying", 0, "Checking the audio against the script");
      const fidelity = await verifyPerTurn(
        episode,
        audio,
        new WhisperCppProvider(),
        sliceWav,
        (done, total) =>
          emit({
            percent: overallPercent("verifying", done / total, stages),
            message: `Verifying turn ${done} of ${total}`,
          }),
      );
      transcriptRecall = fidelity.episodeRecall;
    }

    // Recording is best-effort: a study history is a nice-to-have, and failing
    // to write it must never fail an episode that was produced successfully.
    try {
      await saveLedger(
        recordEpisode(await loadLedger(), {
          paperId: input.paperId ?? "paper",
          paper,
          episode,
          provider: generated.provider,
          model: generated.model,
          minutes: input.minutes,
          timings: audio.timings,
          audioPath: input.audioPath,
          transcriptRecall,
        }),
      );
    } catch (err) {
      console.warn(`[job ${jobId}] could not update the study ledger:`, err);
    }

    await shelve({
      id: jobId,
      createdAt: Date.now(),
      paperTitle: paper.title,
      paperId: input.paperId,
      minutes: input.minutes,
      format: input.format ?? "dialogue",
      provider: generated.provider,
      model: generated.model,
      turnCount: episode.turns.length,
      summary: episode.summary,
      keyPoints: episode.keyPoints,
      totalMs: audio.totalMs,
      hasAudio: true,
      // What actually voiced it, which is not always what was configured: a
      // hosted backend may have failed and the local one remade the episode.
      ttsProvider: audio.provider,
      voices: audio.voices,
      transcriptRecall,
      review,
      cost: { ...costSoFar(), ttsCalls: audio.calls },
      episode,
      citations,
      timings: audio.timings,
      paper,
      concepts: concepts?.concepts,
      relations: concepts?.relations,
    });

    await update({
      stage: "done",
      percent: 100,
      message: "Episode ready",
      result: {
        episode,
        review,
        reviewError,
        citations,
        audioPath: input.audioPath,
        timings: audio.timings,
        totalMs: audio.totalMs,
        transcriptRecall,
      },
    });
  } catch (err) {
    // The full error stays in the server log; the client gets a safe summary.
    // The reference is what connects the two: without it "something went
    // wrong" is unfindable, and with it a person greps the log for one short id.
    const ref = randomUUID().slice(0, 8);
    console.error(`[job ${jobId}] [ref ${ref}] failed during "${current}":`, err);
    await update({
      stage: "error",
      percent: 100,
      message: `Failed during ${current}`,
      error: { ...toJobError(err), failedStage: current, ref },
    });
  }
}
