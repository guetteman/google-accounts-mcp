import type { ServerEventBus } from "@modelcontextprotocol/server";
import { Effect, Result } from "effect";
import type { CallContext } from "./call";
import { listedTools } from "./tools";

export const POLL_MS = 5000;
export const TICKS = 40;

export function watchToolList(ctx: CallContext, end: () => void): ServerEventBus {
  return {
    publish() {},
    subscribe(listener) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let previous: string | undefined;
      let tick = 0;
      const read = async () => {
        const result = await Effect.runPromise(Effect.result(listedTools(ctx)));
        if (stopped) return;
        if (Result.isSuccess(result)) {
          if (!result.success.active) {
            stopped = true;
            end();
            return;
          }
          const names = result.success.tools.map((tool) => tool.name).join();
          if (previous !== undefined && previous !== names)
            listener({ kind: "tools_list_changed" });
          previous = names;
        }
        if (tick === TICKS) {
          stopped = true;
          end();
          return;
        }
        timer = setTimeout(() => {
          tick++;
          void read();
        }, POLL_MS);
      };
      void read();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}
