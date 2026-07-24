export async function readJsonSseStream(
  response: Response,
  onMessage: (value: unknown) => void
): Promise<void> {
  if (!response.body) {
    throw new Error('Runtime event stream has no response body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const next = await reader.read();
    buffer += decoder.decode(next.value, { stream: !next.done });
    buffer = consumeSseEvents(buffer, onMessage, next.done);
    if (next.done) {
      return;
    }
  }
}

export function consumeSseEvents(
  source: string,
  onMessage: (value: unknown) => void,
  flush = false
): string {
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const pieces = normalized.split('\n\n');
  const pending = flush ? '' : pieces.pop() ?? '';
  for (const piece of pieces) {
    const data = piece
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) {
      onMessage(JSON.parse(data));
    }
  }
  return pending;
}
