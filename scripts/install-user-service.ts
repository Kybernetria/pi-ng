import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const servicePath = join(homedir(), ".config/systemd/user/pi-ng-daemon.service");
const envPath = join(homedir(), ".config/pi-ng/daemon.env");
const cwd = process.cwd();
const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

const service = `[Unit]
Description=pi-ng Signal Note-to-Self daemon
Documentation=${cwd}/README.md
After=network-online.target signal-cli-rest-api.service
Wants=network-online.target signal-cli-rest-api.service

[Service]
Type=simple
WorkingDirectory=${cwd}
Environment=PATH=${path}
EnvironmentFile=-%h/.config/pi-ng/daemon.env
ExecStart=/usr/bin/env npm run daemon
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`;

await mkdir(dirname(servicePath), { recursive: true });
await mkdir(dirname(envPath), { recursive: true });
await writeFile(servicePath, service);

try {
  await writeFile(envPath, "# SIGNAL_ACCOUNT=+15555550123\n# SIGNAL_REST_URL=http://127.0.0.1:8080\n", { flag: "wx" });
} catch (error) {
  if (!(error instanceof Error) || !Object.hasOwn(error, "code") || (error as NodeJS.ErrnoException).code !== "EEXIST") {
    throw error;
  }
}

console.log(`Wrote ${servicePath}`);
console.log(`Wrote ${envPath} if it did not already exist`);
console.log("");
console.log("Next steps:");
console.log(`  $EDITOR ${envPath}   # set SIGNAL_ACCOUNT if it is not already exported elsewhere`);
console.log("  systemctl --user daemon-reload");
console.log("  systemctl --user enable --now pi-ng-daemon.service");
console.log("");
console.log("Optional, to allow the user service to start at boot before login:");
console.log(`  loginctl enable-linger ${process.env.USER ?? "$USER"}`);
