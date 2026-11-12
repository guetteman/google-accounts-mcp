import { Fragment, useRef, useState, type ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { PRODUCT } from "../pages/page";
import type { ApprovalPageProps, ApprovalRequest, ApprovalState } from "../approvals/model";

// Characters that draw nothing or change the reading direction. Line breaks and tabs stay.
const isHidden = (character: string) =>
  character !== "\n" &&
  character !== "\t" &&
  character !== " " &&
  /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cc}\p{Zs}\p{Cf}\u2800\u2028\u2029]/u.test(
    character,
  );
const hasHidden = (text: string) => Array.from(text).some(isHidden);

/** Plain text, with every hidden character replaced by a marked token such as `U+202E`. */
function Visible({ text }: { readonly text: string }) {
  const parts: Array<{ readonly hidden: boolean; readonly text: string }> = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const last = parts.at(-1);
    if (isHidden(character))
      parts.push({ hidden: true, text: `U+${code.toString(16).toUpperCase().padStart(4, "0")}` });
    else if (last && !last.hidden)
      parts[parts.length - 1] = { hidden: false, text: last.text + character };
    else parts.push({ hidden: false, text: character });
  }
  return (
    <>
      {parts.map((part, i) =>
        part.hidden ? (
          // The inline text token of the registry, so no hand-made chip stands in for it.
          <Badge
            key={i}
            variant="destructive"
            className="mx-0.5 rounded-sm px-1 align-baseline font-mono"
          >
            <span className="sr-only">hidden character </span>
            {part.text}
          </Badge>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * A value inside one of the page's sentences. It is a plain inline element, not a Badge, because
 * a Badge cannot wrap and a long name has to.
 */
function Value({
  children,
  className,
}: {
  readonly children: string;
  readonly className?: string;
}) {
  return (
    <bdi
      className={cn(
        "rounded-md bg-muted box-decoration-clone px-1 py-0.5 wrap-anywhere text-foreground",
        className,
      )}
    >
      <Visible text={children} />
    </bdi>
  );
}

/** A value of the call, or a message of the tool, quoted as written. */
function Quoted({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="text-sm text-muted-foreground">{label}</figcaption>
      <blockquote
        dir="auto"
        className="rounded-lg bg-muted px-3 py-2.5 font-mono text-sm/6 wrap-anywhere whitespace-pre-wrap"
      >
        <Visible text={text} />
      </blockquote>
    </figure>
  );
}

const OWN_WORDS = "This page's own words are never shaded.";
const SOURCES = { agent: "written by the agent", gmail: "read from Gmail" } as const;
type Values = ApprovalRequest["values"];
const mixed = (values: Values) => new Set(values.map((value) => value.from)).size > 1;
/** Whose text the shaded values are. Text read from Gmail was never written by the agent. */
const whose = (values: Values) =>
  mixed(values)
    ? "The agent wrote part of the shaded text below, and the server read the rest from Gmail. Each label says which."
    : values[0]?.from === "gmail"
      ? "The server read the shaded text below from Gmail. The agent did not write it."
      : "The agent wrote the shaded text below.";

const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);

function Facts({
  request,
  children,
}: {
  readonly request: ApprovalRequest;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm/6 text-muted-foreground">
      <p>
        The app is <Value>{request.connection.app}</Value>. The address is{" "}
        <Value>{request.account.email}</Value>
        {request.account.workspace && ", a Workspace account"}.
      </p>
      <p>{children}</p>
    </div>
  );
}

type Waiting = Extract<ApprovalState, { kind: "waiting" }>;
type Busy = "approving" | "rejecting" | null;

export function ApprovalPage(props: ApprovalPageProps) {
  const [page, setPage] = useState(props);
  const [unconfirmed, setUnconfirmed] = useState(props.unconfirmed ?? false);
  const [busy, setBusy] = useState<Busy>(null);
  const locked = useRef(false);
  const decide = async (action: "approve" | "reject") => {
    if (locked.current) return;
    locked.current = true;
    setBusy(action === "approve" ? "approving" : "rejecting");
    try {
      const response = await fetch(`/approvals/${page.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(
          action === "approve" && page.state.kind === "waiting"
            ? { digest: page.state.digest ?? "" }
            : {},
        ),
      });
      if (!response.ok) throw new Error("Decision unconfirmed");
      const body = (await response.json()) as { approval?: ApprovalPageProps };
      if (!body.approval || body.approval._tag !== "Approval" || body.approval.id !== page.id)
        throw new Error("Decision unconfirmed");
      setPage(body.approval);
    } catch {
      setUnconfirmed(true);
    } finally {
      locked.current = false;
      setBusy(null);
    }
  };
  const state = unconfirmed ? { kind: "unconfirmed" as const } : page.state;
  return (
    <main className="flex min-h-svh flex-col items-center bg-background px-4 py-8 sm:py-12 md:py-16">
      <div className="flex w-full max-w-xl flex-col gap-10">
        <p className="text-sm font-semibold tracking-tight">{PRODUCT}</p>
        {state.kind === "waiting" ? (
          <WaitingView
            request={page.request}
            state={state}
            busy={busy}
            times={page.times}
            approve={() => void decide("approve")}
            reject={() => void decide("reject")}
          />
        ) : (
          <DecidedView
            request={page.request}
            state={state}
            times={page.times}
            reloadHref={`/approvals/${page.id}`}
          />
        )}
      </div>
    </main>
  );
}

function WaitingView({
  request,
  state,
  busy,
  times,
  approve,
  reject,
}: {
  readonly request: ApprovalRequest;
  readonly state: Waiting;
  readonly busy: Busy;
  readonly times: ApprovalPageProps["times"];
  readonly approve: () => void;
  readonly reject: () => void;
}) {
  const { connection, account, tool, values } = request;
  const notes = {
    idle: state.shown
      ? "Approve runs this call once, right now. Reject runs nothing."
      : "Reject runs nothing.",
    approving: "If the call runs, it can take up to 25 seconds.",
    rejecting: "Rejecting. Nothing runs.",
  };
  const note = busy ?? "idle";
  return (
    <>
      {state.changed && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Nothing ran. The request changed.</AlertTitle>
          <AlertDescription>
            What this call would do changed after you opened this page. Below is the request as it
            is now. Read it again before you decide.
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium text-muted-foreground">
          {busy === "approving"
            ? "Sending your approval"
            : state.shown
              ? "Waiting for your approval"
              : "Waiting, but it cannot be approved"}
        </p>
        {/* The page's joining words recede. The connection, the tool, and the account carry the ink. */}
        <h1 className="text-2xl/10 tracking-tight text-pretty text-muted-foreground">
          <Value className="px-1.5 font-semibold">{connection.name}</Value> wants to{" "}
          {state.shown ? (
            <>
              <strong className="font-semibold text-foreground">{tool.action}</strong> {tool.joiner}
            </>
          ) : (
            <>
              use <strong className="font-semibold text-foreground">{tool.label}</strong> on
            </>
          )}{" "}
          <Value className="px-1.5 font-semibold">{account.name}</Value>.
        </h1>
        <Facts request={request}>
          Asked {minutes(times.minutesSinceAsked)} ago, at {times.asked}. Expires in{" "}
          {minutes(times.minutesLeft)}, at {times.expires}.
        </Facts>
      </div>
      {state.shown ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">{tool.label}</h2>
            <p className="text-sm text-muted-foreground">
              {values.length === 0
                ? tool.empty
                : `${whose(values)} ${OWN_WORDS}${
                    values.some((value) => hasHidden(value.text))
                      ? " Characters you cannot see are shown as codes."
                      : ""
                  }`}
            </p>
          </div>
          {request.notes
            .filter((note) => !note.warning)
            .map((note, index) => (
              <p key={index} className="text-base/7">
                {note.text}
              </p>
            ))}
          {values.map((value) => (
            <Quoted
              key={value.name}
              label={mixed(values) ? `${value.name}, ${SOURCES[value.from]}` : value.name}
              text={value.text}
            />
          ))}
          {values.length > 0 && (
            <p className="text-sm text-muted-foreground">That is the whole call.</p>
          )}
          {request.notes
            .filter((note) => note.warning)
            .map((note, index) => (
              <Alert key={index} variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>{note.text}</AlertTitle>
              </Alert>
            ))}
        </section>
      ) : (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>The server could not show this call.</AlertTitle>
          <AlertDescription>
            You cannot read what it would do, so this page has no Approve. Reject it, or leave it:
            it expires at {times.expires} and nothing runs.
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-4">
        {/* Fixed heights and widths, so a busy label moves nothing. */}
        <div className="flex flex-col gap-3 sm:flex-row">
          {state.shown && (
            <Button
              size="lg"
              className="h-11 text-base sm:w-52"
              disabled={busy !== null}
              aria-busy={busy === "approving"}
              onClick={approve}
            >
              {busy === "approving" ? (
                <>
                  <Spinner aria-hidden /> Approving…
                </>
              ) : (
                "Approve"
              )}
            </Button>
          )}
          <Button
            variant="outline"
            size="lg"
            className="h-11 text-base sm:w-52"
            disabled={busy !== null}
            aria-busy={busy === "rejecting"}
            onClick={reject}
          >
            Reject
          </Button>
        </div>
        {/* Every note is laid out in the same cell, so the longest one reserves the space. */}
        <div className="grid text-sm text-muted-foreground" aria-live="polite">
          {(["idle", "approving", "rejecting"] as const).map((key) => (
            <p
              key={key}
              className={cn("col-start-1 row-start-1", key !== note && "invisible")}
              aria-hidden={key !== note}
            >
              {notes[key]}
            </p>
          ))}
        </div>
      </div>
    </>
  );
}

function DecidedView({
  request,
  state,
  reloadHref,
  times,
}: {
  readonly request: ApprovalRequest;
  readonly state: Exclude<ApprovalState, { kind: "waiting" }> | { kind: "unconfirmed" };
  readonly times: ApprovalPageProps["times"];
  readonly reloadHref: string;
}) {
  const { connection, account, tool } = request;
  const link = "text-foreground underline underline-offset-4";
  const tell = (what: string) => (
    <>
      Tell the agent in your conversation that you {what}. It does not learn the outcome by itself.
    </>
  );
  const outcome: {
    readonly headline: ReactNode;
    readonly detail: ReactNode;
    readonly next: ReactNode;
  } = (() => {
    const kind = state.kind === "ended" ? (`ended-${state.by}` as const) : state.kind;
    switch (kind) {
      case "running":
        return {
          headline: "Approved. The call is running.",
          detail: `You approved this on ${times.decidedOn}. A call can take up to 25 seconds.`,
          next: "Reload this page to see how it ended.",
        };
      case "succeeded":
        return {
          headline: "Approved. The call succeeded.",
          detail: `You approved this on ${times.decidedOn}, and the call ran once.`,
          next: <>{tell("approved")} This page does not show the result.</>,
        };
      case "failed":
        return {
          headline: (
            <>
              Approved. <span className="text-destructive">The call failed.</span>
            </>
          ),
          detail: `You approved this on ${times.decidedOn}. The call failed.`,
          next: tell("approved"),
        };
      case "unknown":
        return {
          headline: "Approved. The outcome is unknown.",
          detail: `You approved this on ${times.decidedOn}. The server does not know whether Google completed the call.`,
          next: tell("approved"),
        };
      case "rejected":
        return {
          headline: "Rejected. Nothing ran.",
          detail: `You rejected this on ${times.decidedOn}.`,
          next: tell("rejected"),
        };
      case "expired":
        return {
          headline: "Expired. Nothing ran.",
          detail: `Nobody decided before ${times.expiresOn}, one hour after the agent asked.`,
          next: "If you still want this, the agent has to make the call again.",
        };
      case "ended-tool":
        return {
          headline: "No longer allowed. Nothing ran.",
          detail: (
            <>
              While this request waited, you set {tool.label} to Not allowed for{" "}
              <Value>{connection.name}</Value> on <Value>{account.name}</Value>.
            </>
          ),
          next: (
            <>
              To let it run, change the setting on{" "}
              <a href={`/connections/${connection.id}`} className={link}>
                the connection's page
              </a>
              . Then the agent has to make the call again.
            </>
          ),
        };
      case "ended-connection":
        return {
          headline: "Connection ended. Nothing ran.",
          detail: (
            <>
              While this request waited, the connection <Value>{connection.name}</Value> ended. It
              was revoked.
            </>
          ),
          next: (
            <>
              An ended connection cannot be used again. To use <Value>{connection.app}</Value>{" "}
              again, add this server to it. It signs in as a new connection with no access.
            </>
          ),
        };
      case "ended-account":
        return {
          headline: "Account removed. Nothing ran.",
          detail: (
            <>
              While this request waited, you removed the account <Value>{account.name}</Value> from
              this server.
            </>
          ),
          next: (
            <>
              To use it again, connect it on{" "}
              <a href="/accounts" className={link}>
                Accounts
              </a>
              . Then the agent has to make the call again.
            </>
          ),
        };
      case "unconfirmed":
        return {
          headline: "Couldn't confirm your decision. Reload this page.",
          detail:
            "This page could not confirm whether your decision counted. Check what the server recorded before deciding again.",
          next: "Reload to see what the server recorded.",
        };
    }
  })();
  return (
    <>
      <div className="flex flex-col gap-4" aria-live="polite">
        <h1 className="text-2xl/9 font-semibold tracking-tight text-balance">{outcome.headline}</h1>
        <p className="text-base/7 text-muted-foreground">{outcome.detail}</p>
        {state.kind === "failed" && state.message !== null && (
          <Quoted label="The tool's message" text={state.message} />
        )}
        <p className="text-base/7">{outcome.next}</p>
        {state.kind === "unconfirmed" && (
          <Button asChild size="lg" className="mt-2 h-11 text-base sm:w-52">
            <a href={reloadHref}>Reload</a>
          </Button>
        )}
      </div>
      {/* The request recedes: smaller, muted, and in the past tense. */}
      <section className="flex flex-col gap-2 text-sm/6 text-muted-foreground">
        <h2 className="font-medium">The request</h2>
        <p>
          <Value>{connection.name}</Value> asked to {tool.action} {tool.joiner}{" "}
          <Value>{account.name}</Value>.
        </p>
        <Facts request={request}>The agent asked on {times.askedOn}.</Facts>
      </section>
    </>
  );
}
