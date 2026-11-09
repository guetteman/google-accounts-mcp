import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StandalonePage } from "./standalone";

export function AccessRefusedPage() {
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>Open this server through Cloudflare Access</h1>
          </CardTitle>
          <CardDescription>
            This address isn't protected by the server's Cloudflare Access application, so it can't
            tell who you are. Nothing changed. Open the server from the address its Access
            application covers.
          </CardDescription>
        </CardHeader>
      </Card>
    </StandalonePage>
  );
}
