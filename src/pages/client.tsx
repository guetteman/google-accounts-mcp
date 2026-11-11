import { hydrateRoot } from "react-dom/client";
import type { HydratedPage } from "./page";
import { hydratedElement } from "./registry";

const root = document.getElementById("root");
const blob = document.getElementById("page-props");
if (root && blob?.textContent) {
  const page = JSON.parse(blob.textContent) as HydratedPage;
  hydrateRoot(root, hydratedElement(page));
}
