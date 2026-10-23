import type { PluginServerContext } from "@getpaseo/plugin/server";
import { copyWorktreeIncludes } from "./server/copy";

export default function contribute(server: PluginServerContext) {
  server.on("workspace.created", async ({ workspace }) => {
    const result = await copyWorktreeIncludes(workspace.cwd);
    if (result.kind === "copied") {
      console.log(
        `[paseo-worktreeinclude] ${workspace.cwd}: copied ${result.copied.length}, linked ${result.linked.length}, skipped ${result.skipped.length}`,
      );
    }
  });
  return () => {};
}
