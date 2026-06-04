import { registerTool } from "../registry.js";

registerTool({
  name: "get_current_time",
  description: "Returns the current system time.",
  params: {},
  async run() {
    return new Date().toLocaleString();
  }
});