// Shared OpenSCAD WASM runner for the example pages: creates an instance,
// prepares the virtual FS and renders a model. Returns the export bytes.
import OpenSCAD from "../openscad.js";

// manifold is the default engine in this build; no flag needed.
export async function runOpenSCAD(code, {
    files = {}, prepare, log = () => {}, format = "binstl",
} = {}) {
    // A fresh instance per run (as in the project's own tests): once abort()
    // fires in the browser, the instance cannot be recovered.
    const instance = await OpenSCAD({
        noInitialRun: true,
        print: (t) => log("[out] " + t),
        // openscad writes render statistics to stderr — these are not errors
        printErr: (t) => log("[log] " + t),
    });

    // Empty locale directory so openscad doesn't complain about its absence
    // (translations are not packaged into the build).
    try { instance.FS.mkdir("/locale"); } catch { /* already exists */ }

    // Page hook: load fonts/libraries into the instance before the run.
    if (prepare) await prepare(instance);

    for (const [path, data] of Object.entries(files)) {
        instance.FS.writeFile(path, data);
    }

    instance.FS.writeFile("/input.scad", code);
    const t0 = performance.now();
    // Binary STL: ~5x more compact than ASCII (50 bytes per triangle instead
    // of ~260). 3MF (a zip) is smaller still and, unlike STL, carries the
    // colors of color() subtrees — use it whenever colors must survive.
    const out = `/output.${format.endsWith("stl") ? "stl" : format}`;
    const exit = instance.callMain(
        ["/input.scad", "--export-format", format, "-o", out]);
    if (exit !== 0) throw new Error(`openscad exited with code ${exit}`);

    const bytes = instance.FS.readFile(out);
    if (!bytes.length) throw new Error("empty output — check the input data");

    return { bytes, ms: Math.round(performance.now() - t0) };
}
