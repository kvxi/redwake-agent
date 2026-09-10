import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { PlainReplIO } from "../source/ui/plain-repl-io.ts";

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  const io = new PlainReplIO(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  return { input, output, io };
}

test("EOF settles a pending provider retry and future input requests", async () => {
  const { input, output, io } = terminal();
  try {
    const first = io.readLine({ kind: "choice", label: "Provider:" });
    input.write("invalid\n");
    expect(await first).toBe("invalid");
    const retry = io.readLine({ kind: "choice", label: "Provider:" });
    input.end();
    expect(await retry).toBeNull();
    expect(await io.readLine({ kind: "choice", label: "Provider:" })).toBeNull();
  } finally { io.close(); input.destroy(); output.destroy(); }
});

test("EOF before a question remains a clean cancellation", async () => {
  const { input, output, io } = terminal();
  try {
    input.end();
    await Bun.sleep(0);
    expect(await io.readLine({ kind: "choice", label: "Provider:" })).toBeNull();
    io.close();
  } finally { io.close(); input.destroy(); output.destroy(); }
});
