import { parseCliCommand, usageText } from "./cli.js";
import { buildVersion, startAmberServer } from "./server-app.js";

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
  console.error(`amber: unrecognised argument '${cliCommand.argument}'\n`);
  console.error(usageText());
  process.exit(2);
}

await startAmberServer();
