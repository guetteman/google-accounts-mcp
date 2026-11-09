import { hydrateRoot } from "react-dom/client";
import type { FramePage } from "./page";
import { frameElement } from "./registry";

const root = document.getElementById("root");
const blob = document.getElementById("page-props");
if (root && blob?.textContent) {
  const page = JSON.parse(blob.textContent) as FramePage;
  hydrateRoot(root, frameElement(page));
}
