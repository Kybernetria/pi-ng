import { createPiNgDaemon } from "../daemon.ts";

const daemon = createPiNgDaemon({ autoStart: true });
console.log("pi-ng daemon started");

const shutdown = (): void => {
  daemon.dispose();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
