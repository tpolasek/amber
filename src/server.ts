import { parseCliCommand, usageText } from "./cli.js";
import { buildVersion, startAmberServer } from "./server-app.js";
import { logServerError } from "./server-log.js";

const cliCommand = parseCliCommand(process.argv.slice(2));
if (cliCommand.kind === "help") {
  console.log(usageText());
  process.exit(0);
}
if (cliCommand.kind === "version") {
  console.log(buildVersion);
  process.exit(0);
}
if (cliCommand.kind === "unknown") {
  logServerError(`amber: unrecognised argument '${cliCommand.argument}'\n`);
  logServerError(usageText());
  process.exit(2);
}

await startAmberServer();
