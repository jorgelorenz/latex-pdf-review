import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../ui/index.html", import.meta.url));
const to = fileURLToPath(new URL("../dist/ui/index.html", import.meta.url));

await copyFile(from, to);
