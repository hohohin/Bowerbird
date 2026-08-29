import { runDsh } from "./runtime.mjs";

const result = await runDsh(["--dump-config"]);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
