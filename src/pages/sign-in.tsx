import { CircleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Page } from "./page";
import { StandalonePage } from "./standalone";

const problems = {
  failed: {
    title: "Sign-in didn't finish",
    detail:
      "It expired, was cancelled, or started in another browser. Nothing changed. Sign in again.",
  },
  "google-down": {
    title: "Google didn't answer",
    detail: "Nothing changed. Try again in a minute.",
  },
};

export function SignInPage({ host, next, problem }: Extract<Page, { _tag: "SignIn" }>) {
  const alert = problem && problems[problem];
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>
              Sign in to manage <span className="whitespace-nowrap">{host}</span>
            </h1>
          </CardTitle>
          <CardDescription>Only this server's owner can sign in.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {alert && (
            <Alert variant="warning">
              <CircleAlertIcon />
              <AlertTitle>{alert.title}</AlertTitle>
              <AlertDescription>{alert.detail}</AlertDescription>
            </Alert>
          )}
          <form method="post" action="/signin">
            <input type="hidden" name="next" value={next} />
            <Button type="submit" className="w-full">
              Sign in with Google
            </Button>
          </form>
        </CardContent>
      </Card>
    </StandalonePage>
  );
}
