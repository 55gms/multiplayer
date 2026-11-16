// One JSON line per event on stdout, so journald or pm2 can keep it.
export function log(event, fields = {}) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + "\n");
}
