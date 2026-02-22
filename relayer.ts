import dotenv from "dotenv";
import { resolve } from "path";
dotenv.config({ path: resolve(process.cwd(), ".env") });
import { bootstrapRelayer } from "./relayer/bootstrap";

bootstrapRelayer().catch((err) => {
  console.error("Fatal relayer error:", err);
  process.exit(1);
});
