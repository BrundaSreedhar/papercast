"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Deleting an episode, with the confirmation in the button rather than a modal.
 *
 * One click arms it, the second removes it, and anything else disarms it. A
 * dialog would be the conventional answer, but this is a single irreversible
 * action on a page the reader is already looking at — the second click is the
 * confirmation, and it costs no interruption to get it.
 */
export function DeleteEpisode({
  episodeId,
  title,
}: {
  episodeId: string;
  title: string;
}) {
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/library/${episodeId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Could not delete this episode.");
        setDeleting(false);
        setArmed(false);
        return;
      }
      router.push("/library");
      // The shelf is rendered on the server, so it has to be told the file it
      // read is gone; without this the deleted episode is still listed.
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setDeleting(false);
      setArmed(false);
    }
  }

  return (
    <span className="delete">
      {armed ? (
        <>
          <button
            type="button"
            className="delete-btn confirm"
            onClick={remove}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete for good"}
          </button>
          <button type="button" className="delete-btn" onClick={() => setArmed(false)}>
            Keep
          </button>
        </>
      ) : (
        <button
          type="button"
          className="delete-btn"
          onClick={() => setArmed(true)}
          aria-label={`Delete the episode about ${title}`}
        >
          Delete
        </button>
      )}
      {error && <span className="delete-error">{error}</span>}
    </span>
  );
}
