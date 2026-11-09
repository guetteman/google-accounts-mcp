import { OwnerFrame, PageHeader } from "./frame";
import type { Frame } from "./page";

export function AccountsPage({ frame }: { readonly frame: Frame }) {
  return (
    <OwnerFrame frame={frame}>
      <PageHeader
        title="Accounts"
        description="Google accounts your agents can use. Each connection sees only the ones you grant."
      />
    </OwnerFrame>
  );
}
