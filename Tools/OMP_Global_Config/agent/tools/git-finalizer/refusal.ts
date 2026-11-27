export class PublicationRefusal extends Error {
  constructor(readonly by: string, message: string, readonly stage = by) {
    super(message);
  }
}

export function publicationRefusalResult(error: unknown) {
  if (!(error instanceof PublicationRefusal)) throw error;
  return {
    isError: false as const,
    content: [{ type: "text" as const, text: `[refused by ${error.by}] Not executed.\n${error.message}` }],
    details: { ok: false as const, stage: error.stage, refused: { by: error.by } },
  };
}
