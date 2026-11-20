type PriorRound = {
  title: string;
  request: string;
  summary?: string;
  previewEntry?: string;
  paths?: string[];
  lastVersion: number;
  messages: Array<{ role: string; text: string }>;
};

/** Trim values before serializing; never pass a fragment of JSON as context. */
export function serializePriorContext(rounds: PriorRound[], limit = 60000): string {
  if (!Number.isSafeInteger(limit) || limit < 2000)
    throw new Error('Context limit must be at least 2000 characters.');
  if (!rounds.length) return '{}';
  const latest = rounds.at(-1)!;
  const messages = rounds.flatMap((r) => r.messages.filter((m) => m.role !== 'event'));
  let width = 30000;
  let clipped = false;
  const clip = (value: string | undefined, max: number) => {
    if (!value || value.length <= max) return value;
    clipped = true;
    return (
      value.slice(0, Math.floor(max / 2)) +
      '\n[content truncated]\n' +
      value.slice(-Math.floor(max / 2))
    );
  };
  for (;;) {
    clipped = false;
    const count = Math.min(20, Math.floor(width / 100));
    const kept = (count ? messages.slice(-count) : []).map((m) => ({
      role: m.role,
      text: clip(m.text, Math.min(4000, width)),
    }));
    const context = {
      earliest_retained_request: clip(rounds[0].request, width),
      latest_request: clip(latest.request, width),
      latest_user_message: clip(messages.filter((m) => m.role === 'user').at(-1)?.text, width),
      latest_delivery: {
        version: latest.lastVersion,
        title: clip(latest.title, Math.min(1000, width)),
        summary: clip(latest.summary, Math.min(6000, width)),
        preview_entry: clip(latest.previewEntry, Math.min(2000, width)),
        paths: latest.paths?.slice(0, count).map((p) => clip(p, Math.min(1000, width))),
      },
      recent_messages: kept,
      truncated:
        rounds.length > 1 ||
        messages.length > kept.length ||
        clipped ||
        (latest.paths?.length ?? 0) > count,
      source_round_count: rounds.length,
    };
    const encoded = JSON.stringify(context);
    if (encoded.length <= limit) return encoded;
    width = Math.max(8, Math.floor(width / 2));
  }
}
