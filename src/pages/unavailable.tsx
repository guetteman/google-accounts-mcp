import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StandalonePage } from "./standalone";

export function UnavailablePage() {
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>The server can't reach its database</h1>
          </CardTitle>
          <CardDescription>Nothing changed. Reload this page in a minute.</CardDescription>
        </CardHeader>
      </Card>
    </StandalonePage>
  );
}
