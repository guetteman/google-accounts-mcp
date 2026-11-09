import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Page } from "./page";
import { StandalonePage } from "./standalone";

export function NotOwnerPage({ address, next }: Extract<Page, { _tag: "NotOwner" }>) {
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>This server belongs to someone else</h1>
          </CardTitle>
          <CardDescription>
            {address ? (
              <>
                You signed in to Google as{" "}
                <span className="font-medium text-foreground">{address}</span>, which doesn't own
                this server. Nothing changed.
              </>
            ) : (
              <>
                You signed in to Google with an account that doesn't own this server. Nothing
                changed.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" action="/signin">
            <input type="hidden" name="next" value={next} />
            <Button type="submit" variant="outline" className="w-full">
              Use a different Google account
            </Button>
          </form>
        </CardContent>
      </Card>
    </StandalonePage>
  );
}
