import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Page } from "./page";
import { StandalonePage } from "./standalone";

export function SetupIncompletePage({ names }: Extract<Page, { _tag: "SetupIncomplete" }>) {
  const one = names.length === 1;
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>This server isn't set up yet</h1>
          </CardTitle>
          <CardDescription>
            {one ? "This setting is missing or invalid:" : "These settings are missing or invalid:"}{" "}
            {names.map((name, i) => (
              <span key={name}>
                <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs whitespace-nowrap text-foreground">
                  {name}
                </code>
                {i < names.length - 1 ? (i === names.length - 2 ? " and " : ", ") : "."}
              </span>
            ))}{" "}
            Set {one ? "it" : "them"} in the deploy's configuration, as the setup guide describes,
            and deploy again. Nobody can sign in until then.
          </CardDescription>
        </CardHeader>
      </Card>
    </StandalonePage>
  );
}
