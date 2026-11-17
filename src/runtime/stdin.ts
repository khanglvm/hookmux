// Reads the hook payload from stdin with a size cap and a time limit, so a
// client that never closes stdin or sends a huge payload cannot hang the hook.

export class StdinError extends Error {}

export function readStdin(maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => done(new StdinError("stdin did not close in time")), timeoutMs);
    timer.unref();
    const done = (error?: Error) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return done(new StdinError(`stdin larger than ${maxBytes} bytes`));
      chunks.push(chunk);
    });
    process.stdin.on("end", () => done());
    process.stdin.on("error", (error) => done(error));
  });
}
