// Vercel compiles this file itself (outside tsconfig's `src` include), so we
// declare `require` locally instead of pulling in the full node typings.
declare const require: (id: string) => { default: (req: unknown, res: unknown) => void };

// Vercel Node.js function entry. The project's build step (`npm run build`)
// compiles src/ to dist/ first; this file only forwards every request to the
// compiled Express app (src/serverless.ts).
const handler = require("../dist/serverless").default;

export default handler;
