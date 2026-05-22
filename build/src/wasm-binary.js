// esbuild's `base64` loader replaces this `.wasm` import with the file's
// contents as a base64 string at build time. The runtime decode happens once
// at boot in main.js.
import wasmB64 from "../node_modules/sql.js/dist/sql-wasm.wasm";
export default wasmB64;
