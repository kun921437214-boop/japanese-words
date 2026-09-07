import { runWrangler } from './run-wrangler.mjs';

process.exit(runWrangler(['pages', 'deploy', 'dist', '--project-name', 'jiyimianbao', '--branch', 'main']));
