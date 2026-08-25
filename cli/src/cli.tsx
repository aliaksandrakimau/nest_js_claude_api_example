import { render } from 'ink';
import { App } from './App.js';

const baseUrl = process.argv[2] || 'http://localhost:3000';

render(<App baseUrl={baseUrl} />, {
  exitOnCtrlC: true,
});
