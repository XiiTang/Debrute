import { renderCanvasFeedbackAnnotatedImage } from './CanvasFeedbackRenderedImageService.js';
import type {
  CanvasFeedbackRenderJobInput,
  CanvasFeedbackRenderJobResult
} from './CanvasFeedbackRenderedImageWorkerProtocol.js';

void main();

async function main(): Promise<void> {
  const inputText = await readStdin();
  let jobId = 'unknown';
  try {
    const input = JSON.parse(inputText) as CanvasFeedbackRenderJobInput;
    jobId = input.jobId;
    const result = await renderCanvasFeedbackAnnotatedImage(input);
    writeResult(result);
  } catch (error) {
    writeResult({
      ok: false,
      jobId,
      message: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
}

function writeResult(result: CanvasFeedbackRenderJobResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function readStdin(): Promise<string> {
  let content = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    content += chunk;
  }
  return content;
}
