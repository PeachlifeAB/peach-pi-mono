import { pathToFileURL } from "node:url";

const [modulePath, event] = process.argv.slice(2);
const { main } = await import(pathToFileURL(modulePath).href);
await main(event);
