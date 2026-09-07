import { runWrangler } from './run-wrangler.mjs';

process.exit(runWrangler(['deploy', '--env=', '--config', 'wrangler.coordinator.toml']));
