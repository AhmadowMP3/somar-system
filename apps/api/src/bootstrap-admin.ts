import { runBootstrapAdmin } from './bootstrap.js';

runBootstrapAdmin().then(
  (message) => {
    console.log(message);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
