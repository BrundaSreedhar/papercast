/**
 * What an episode covers: its summary and key points.
 *
 * A plain <details> rather than a component with state: it needs no
 * JavaScript, it is keyboard operable for free, and it renders on the server
 * as well as in the page that makes an episode. Closed by default, so the
 * episode itself comes first; the label says what is behind it.
 */
export function EpisodeSummary({
  summary,
  keyPoints = [],
}: {
  summary: string;
  keyPoints?: string[];
}) {
  if (!summary) return null;
  return (
    <details className="card summary">
      <summary>
        <span className="summary-label">What this episode covers</span>
      </summary>
      <p>{summary}</p>
      {keyPoints.length > 0 && (
        <ul className="key-points">
          {keyPoints.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
