import { setupNetwork } from "@msw/cloudflare";

// Every outbound fetch from the Worker goes through here. A request with no handler fails the
// test, so no test ever reaches a real service.
export const network = setupNetwork();
export const unhandledFrames: Array<string> = [];
network.configure({
  onUnhandledFrame: () => {
    unhandledFrames.push("Unexpected outbound request");
    throw new Error("Unexpected outbound request");
  },
});

// Observe every outbound HTTP request, including Access, CIMD, JWKS and unexpected hosts.
export const requests: string[] = [];
network.events.on("request:start", ({ request }) => requests.push(request.url));
