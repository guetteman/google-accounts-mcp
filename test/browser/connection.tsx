import { createRoot } from "react-dom/client";
import { ConnectionPage } from "../../src/pages/connection";
import {
  connectionPage,
  groupedConnectionPage,
  irreversibleConnectionPage,
} from "../support/connection-page";
import "../../src/styles.css";

const query = new URLSearchParams(location.search);
const props = query.has("irreversible")
  ? irreversibleConnectionPage
  : query.has("groups")
    ? groupedConnectionPage
    : connectionPage;
createRoot(document.getElementById("root")!).render(<ConnectionPage {...props} />);
