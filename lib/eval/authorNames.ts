/**
 * Episodes do not name the paper's authors.
 *
 * A welcome that reads out fourteen names is a minute nobody listens to, and a
 * name is the one detail of a paper a listener needs least. The writer is told
 * to say "the authors", or where they work — "researchers at Google Brain" —
 * and this check holds it to that.
 *
 * Two ways a name gets in, so two tests:
 *
 * - One of this paper's authors, read off its title page (`frontMatter`): the
 *   full name anywhere, or a distinctive surname on its own ("Vaswani showed…").
 *   A surname is only counted when it is long enough to be distinctive and the
 *   paper never uses it as an ordinary lowercase word, so an author called Long
 *   or Young does not fail every episode that says "long" at a sentence start.
 * - Anyone introduced as an author, whether or not the title page parsed: a
 *   byline ("written by …"), "… and colleagues", "… et al.". A byline naming an
 *   institution passes — "written by Google Brain researchers" is the point.
 */
import { frontMatter, isInstitutionWord } from "../pdf/frontMatter";
import { paperToText } from "../pdf/extract";
import type { CheckContext, CheckResult } from "./types";

/** Surnames shorter than this are too likely to be something else ("Fu", "Ma", "Sun"). */
const MIN_SURNAME = 4;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name as a whole-word, whitespace-tolerant pattern. */
function namePattern(name: string, flags = "u"): RegExp {
  const words = name.split(/\s+/).map(escape).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, flags);
}

const PERSON = "(\\p{Lu}[\\p{L}'’-]+(?:\\s+(?:\\p{Lu}\\.|\\p{Lu}[\\p{L}'’-]+)){0,2})";

/** Phrases that introduce whoever follows, or precedes, as an author. */
const BYLINES: RegExp[] = [
  new RegExp(`\\b(?:written|authored|co-?authored|penned)\\s+by\\s+${PERSON}`, "gu"),
  new RegExp(
    `${PERSON}\\s+(?:and|&)\\s+(?:his|her|their)?\\s*(?:colleagues|co-?authors|collaborators|coworkers)\\b`,
    "gu",
  ),
  new RegExp(`${PERSON}\\s+et\\s+al\\b`, "gu"),
];

export function checkNoAuthorNames(ctx: CheckContext): CheckResult {
  const id = "author-names";
  const label = "The episode does not name the paper's authors";
  const { authors, affiliations } = frontMatter(ctx.paper);
  const body = paperToText(ctx.paper);
  const where = affiliations.join(" ");

  const named: string[] = [];
  const note = (who: string, turn: number) => {
    const entry = `"${who}" (turn ${turn})`;
    if (!named.some((n) => n.startsWith(`"${who}"`))) named.push(entry);
  };

  ctx.episode.turns.forEach(({ text }, turn) => {
    for (const author of authors) {
      if (namePattern(author, "iu").test(text)) {
        note(author, turn);
        continue;
      }
      const surname = author.split(/\s+/).at(-1)!;
      if (
        surname.length >= MIN_SURNAME &&
        !surname.endsWith(".") &&
        namePattern(surname).test(text) &&
        !namePattern(surname.toLowerCase()).test(body)
      ) {
        note(surname, turn);
      }
    }

    for (const byline of BYLINES) {
      for (const m of text.matchAll(byline)) {
        const who = m[1]!;
        const words = who.split(/\s+/);
        // An institution, or a place the title page lists, is what should be said.
        if (words.some(isInstitutionWord) || (where && where.includes(who))) continue;
        // A sentence-initial word before "and colleagues" is not a name.
        if (words.length === 1 && /^(?:The|This|These|Their|Our|Its)$/.test(who))
          continue;
        note(who, turn);
      }
    }
  });

  return named.length === 0
    ? { id, label, passed: true, severity: "error" }
    : {
        id,
        label,
        passed: false,
        severity: "error",
        detail: `Names the paper's authors: ${named.slice(0, 5).join(", ")}. Say "the authors", or where they work.`,
      };
}
