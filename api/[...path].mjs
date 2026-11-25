import { createApp } from '../server/app.mjs';
import { deploymentOptions } from '../server/deployment.mjs';

const app = createApp(deploymentOptions(process.env));

// Native Node requests stay untouched, including the raw upload stream.
export default function handler(req, res) {
  return app.handle(req, res);
}
