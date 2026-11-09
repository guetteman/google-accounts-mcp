import { setupNetwork } from "@msw/cloudflare";

// Every outbound fetch from the Worker goes through here. A request with no handler fails the
// test, so no test ever reaches the real Google.
export const network = setupNetwork();
export const unhandledFrames: Array<string> = [];
network.configure({
  onUnhandledFrame: () => {
    unhandledFrames.push("Unexpected outbound request");
    throw new Error("Unexpected outbound request");
  },
});
