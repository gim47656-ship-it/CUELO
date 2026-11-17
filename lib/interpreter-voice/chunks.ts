export const MIN_CHUNK_CHARS = 40;
/** Real endpoints and voice changes may be short; artificial monologue cuts need a substantial clause. */
export function shouldChunkMonologue(text: string, milliseconds: number): boolean {
  return milliseconds >= 8000 && text.trim().length >= MIN_CHUNK_CHARS && (/[.!?。！？]\s*$/u.test(text) || milliseconds >= 15000);
}
