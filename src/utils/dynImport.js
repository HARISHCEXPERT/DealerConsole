// import() — release build (bundle) me start.cjs global helper deta hai (asli module context se import, node_modules wahi se)
export const dynImport = (spec) => (globalThis.__dcImport ? globalThis.__dcImport(spec) : import(spec));
