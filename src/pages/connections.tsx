import { OwnerFrame, PageHeader } from "./frame";
import type { Frame } from "./page";

export function ConnectionsPage({ frame }: { readonly frame: Frame }) {
  return (
    <OwnerFrame frame={frame}>
      <PageHeader
        title="Connections"
        description="Apps that signed in to this server. Each starts with no access to your accounts."
      />
    </OwnerFrame>
  );
}
