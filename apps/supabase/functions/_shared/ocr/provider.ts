// OCR behind an interface so the provider can be swapped. Jobs are asynchronous: submit()
// returns a job id, poll() returns the page text when done. One job = one page (a single-page
// PDF or one image), so every OCR'd text keeps its page number.

export interface OcrJobStatus {
  state: 'pending' | 'running' | 'done' | 'failed';
  /** done: the page's text (markdown from the provider, kept as plain text). */
  text?: string;
  /** done: mean recognition confidence 0-1, if the provider reports one. */
  confidence?: number | null;
  error?: string;
}

export interface OcrProvider {
  id: string;
  submit(file: { bytes: Uint8Array; filename: string }): Promise<string>;
  poll(jobId: string): Promise<OcrJobStatus>;
}

export class OcrError extends Error {
  constructor(message: string, public retryable: boolean, public status?: number) {
    super(message);
    this.name = 'OcrError';
  }
}
