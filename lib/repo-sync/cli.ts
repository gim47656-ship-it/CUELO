import { runSync, SyncError } from "./service";

try {
  const state = await runSync();
  console.log(JSON.stringify(state));
} catch (error) {
  if (error instanceof SyncError && error.status === 409) console.log("Repository sync skipped: already running");
  else { console.error("Repository sync failed:", String(error)); process.exitCode = 1; }
}
