/**
 * A simulated LLM API on localhost.
 *
 * This is the one piece of the loop that is not real, and deliberately so: a real
 * model makes tests slow, credentialed, and non-deterministic. Everything else the
 * e2e suite touches — the Pi binary, extension loading, config discovery, process
 * boundaries — is the genuine article.
 *
 * The server speaks the OpenAI Chat Completions streaming wire protocol, which Pi
 * reaches through its documented `models.json` custom-provider seam. It replays a
 * scripted list of turns, so a test can make the "model" call a tool and thereby
 * reach hook paths that only trigger on tool use.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted assistant turn. */
export type ScriptedTurn =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; args: Record<string, unknown> };

export interface RecordedRequest {
  url: string;
  body: unknown;
}

export interface FakeLlm {
  url: string;
  port: number;
  /** Every request Pi made, so tests can assert on what the agent actually sent. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function chunk(id: string, delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: "pi-e2e-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/**
 * Start the simulated API.
 *
 * `script` is consumed one entry per assistant turn. Once exhausted, the server
 * keeps returning the final entry, which stops a mis-scripted test from hanging.
 */
export async function startFakeLlm(script: ScriptedTurn[]): Promise<FakeLlm> {
  if (script.length === 0) throw new Error("fake LLM needs at least one scripted turn");
  const requests: RecordedRequest[] = [];
  let turn = 0;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => {
      raw += String(part);
    });
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        parsed = raw;
      }
      requests.push({ url: req.url ?? "", body: parsed });

      if ((req.url ?? "").includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ object: "list", data: [{ id: "pi-e2e-model", object: "model" }] }),
        );
        return;
      }

      const step = script[Math.min(turn, script.length - 1)] as ScriptedTurn;
      turn++;
      const id = `chatcmpl-e2e-${turn}`;

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(chunk(id, { role: "assistant", content: "" }, null));

      if (step.type === "tool") {
        res.write(
          chunk(
            id,
            {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${turn}`,
                  type: "function",
                  function: { name: step.tool, arguments: JSON.stringify(step.args) },
                },
              ],
            },
            null,
          ),
        );
        res.write(chunk(id, {}, "tool_calls"));
      } else {
        res.write(chunk(id, { content: step.text }, null));
        res.write(chunk(id, {}, "stop"));
      }

      // Well-formed providers report usage in a final choice-less chunk.
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 0,
          model: "pi-e2e-model",
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}
