// Imported first by main.tsx, before any zod schema exists. zod probes `new Function` to decide whether to compile
// its parsers; this page's CSP has no 'unsafe-eval', so the browser reports that probe as a violation even though zod
// catches it. jitless skips the probe; parsing is exactly as strict, just not compiled.
import { z } from "zod";

z.config({ jitless: true });
