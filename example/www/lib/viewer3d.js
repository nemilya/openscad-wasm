// Shared STL/3MF 3D viewer for the example pages (viewer.html, heightmap.html).
// Creates a canvas, a hint and a stats line in the container; on repeated
// show() calls it keeps the camera orientation, rescaling the distance
// to fit the new model size.
import * as THREE from "three";
import { STLLoader } from "../vendor/STLLoader.js";
import { ThreeMFLoader } from "../vendor/3MFLoader.js";
import { OrbitControls } from "../vendor/OrbitControls.js";

const STYLE = `
.v3d-hint {
    position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: #8a92a0; pointer-events: none;
    text-align: center; padding: 0 30px;
}
.v3d-stats {
    position: absolute; left: 12px; bottom: 10px; color: #8a92a0;
    font: 12px "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    background: rgba(20, 22, 26, .65); border: 1px solid #2e333d;
    border-radius: 6px; padding: 4px 8px; pointer-events: none;
}
.v3d-busy {
    position: absolute; inset: 0; display: none;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; background: rgba(20, 22, 26, .45);
    color: #8a92a0; font-size: .85rem;
}
.v3d-busy.on { display: flex; }
.v3d-busy .v3d-spin {
    width: 42px; height: 42px; border-radius: 50%;
    border: 4px solid rgba(255, 255, 255, .15); border-top-color: #4f9cf9;
    animation: v3d-rot .8s linear infinite;
}
@keyframes v3d-rot { to { transform: rotate(360deg); } }
.v3d-host { position: relative; min-width: 0; }
.v3d-host canvas { display: block; }
`;

let styleInstalled = false;

export class Viewer3D {
    constructor(container, { hintHtml = "" } = {}) {
        if (!styleInstalled) {
            const style = document.createElement("style");
            style.textContent = STYLE;
            document.head.append(style);
            styleInstalled = true;
        }

        this.container = container;
        container.classList.add("v3d-host");
        this.wireframeOn = false;
        this.tintOn = true;
        this.lastMaxDim = 0;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        container.append(this.renderer.domElement);

        this.hint = document.createElement("div");
        this.hint.className = "v3d-hint";
        this.hint.innerHTML = hintHtml;
        container.append(this.hint);

        this.stats = document.createElement("div");
        this.stats.className = "v3d-stats";
        container.append(this.stats);

        // "Working" overlay — shown via setBusy(true)
        this.busy = document.createElement("div");
        this.busy.className = "v3d-busy";
        const spin = document.createElement("div");
        spin.className = "v3d-spin";
        const label = document.createElement("span");
        label.textContent = "working…";
        this.busy.append(spin, label);
        container.append(this.busy);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x14161a);

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
        this.camera.position.set(50, 40, 60);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;

        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30353d, 1.5));
        const key = new THREE.DirectionalLight(0xffffff, 2.6);
        key.position.set(1, 1.7, 1.2);
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.7);
        fill.position.set(-1, 0.5, -1);
        this.scene.add(fill);

        this.stlLoader = new STLLoader();
        this.objects = [];      // top-level objects of the current model
        this.materials = [];    // flat list of visible materials, for wireframe
        this.material = null;   // single-material (plain) look, for the tint
        this.hasColors = false; // model carries color() data
        this.colored = false;   // the colored look is currently shown
        this.coloredObj = null; // colored variant (3MF materials)
        this.plainObj = null;   // plain variant (single material, height tint)
        this.grid = null;

        new ResizeObserver(() => this.resize()).observe(container);
        this.resize();

        this.renderer.setAnimationLoop(() => {
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        });
    }

    set wireframe(on) {
        this.wireframeOn = on;
        for (const m of this.materials) m.wireframe = on;
    }

    // Height tint (toggle without regenerating geometry). Only applies to the
    // plain look — colored models keep their authored colors.
    set tint(on) {
        this.tintOn = on;
        if (this.colored || !this.material) return;
        this.material.vertexColors = on;
        this.material.color.set(on ? 0xffffff : 0x8fa8bf);
        this.material.needsUpdate = true;
    }

    // Show/hide the "working" spinner over the scene.
    setBusy(on, text = "working…") {
        this.busy.classList.toggle("on", on);
        this.busy.lastElementChild.textContent = text;
    }

    // data — a Uint8Array of binary or ASCII STL from the emscripten virtual FS
    showSTL(data) {
        const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const geometry = this.stlLoader.parse(buffer);
        if (!geometry.attributes.normal) geometry.computeVertexNormals();
        geometry.center();
        geometry.computeBoundingBox();

        const size = new THREE.Vector3();
        geometry.boundingBox.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;

        this.hasColors = false;
        this.colored = false;
        this.coloredObj = null;
        this.plainObj = this._plainMesh(geometry);
        this.material = this.plainObj.material;
        this.materials = [this.material];
        this._show([this.plainObj], size, maxDim, geometry.attributes.position.count / 3);
    }

    // data — a Uint8Array of a 3MF from the emscripten virtual FS. OpenSCAD
    // writes one material per color() subtree and references it per triangle,
    // alpha included; each part keeps its authored color. The same geometry is
    // also kept as a plain single-material variant ("view as STL"), and the
    // `colors` setter switches between the two without a re-render.
    show3MF(data) {
        const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const group = new ThreeMFLoader().parse(buffer);
        group.updateMatrixWorld(true);

        const box = new THREE.Box3();
        const parts = [];
        const materials = [];
        group.traverse((o) => {
            if (!o.isMesh) return;
            const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
            geometry.computeBoundingBox();
            box.union(geometry.boundingBox);
            parts.push(geometry);
            // 3MF gives flat facets with no normals; flat shading keeps the
            // CSG look consistent with the STL path. Loader materials may be
            // a single material or an array (per-group), keep that structure.
            const convert = (src) => new THREE.MeshStandardMaterial({
                color: src?.color?.clone() ?? new THREE.Color(0x8fa8bf),
                transparent: (src?.opacity ?? 1) < 1,
                opacity: src?.opacity ?? 1,
                flatShading: true,
                metalness: 0.15, roughness: 0.55,
                wireframe: this.wireframeOn,
            });
            materials.push(Array.isArray(o.material) ? o.material.map(convert) : convert(o.material));
        });
        if (!parts.length) throw new Error("3MF contains no meshes");

        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;

        let triangles = 0;
        const coloredGroup = new THREE.Group();
        const merged = [];
        for (let i = 0; i < parts.length; i++) {
            parts[i].translate(-center.x, -center.y, -center.z);
            triangles += parts[i].attributes.position.count / 3;
            coloredGroup.add(new THREE.Mesh(parts[i], materials[i]));
            merged.push(parts[i].attributes.position.array);
        }
        coloredGroup.rotation.x = -Math.PI / 2; // in OpenSCAD the Z axis points up

        // merged (non-indexed) copy for the plain look — same geometry,
        // presented exactly like a downloaded STL would be
        const flat = new Float32Array(merged.reduce((n, a) => n + a.length, 0));
        let offset = 0;
        for (const a of merged) { flat.set(a, offset); offset += a.length; }
        const plainGeometry = new THREE.BufferGeometry();
        plainGeometry.setAttribute("position", new THREE.BufferAttribute(flat, 3));

        this.hasColors = true;
        this.colored = true;
        this.coloredObj = coloredGroup;
        this.coloredMaterials = materials.flat();
        this.plainObj = this._plainMesh(plainGeometry);
        this.coloredObj.visible = true;
        this.plainObj.visible = false;
        this.material = null;
        this.materials = this.coloredMaterials;
        this._show([this.coloredObj, this.plainObj], size, maxDim, triangles);
    }

    // Switch between the authored-colors look and the plain "as STL" look.
    // No-op for models without color() data.
    set colors(on) {
        if (!this.hasColors) return;
        this.colored = on;
        if (this.coloredObj) this.coloredObj.visible = on;
        if (this.plainObj) this.plainObj.visible = !on;
        if (on) {
            this.material = null;
            this.materials = this.coloredMaterials;
        } else {
            this.material = this.plainObj.material;
            this.material.wireframe = this.wireframeOn;
            this.materials = [this.material];
            this.tint = this.tintOn; // reapply the current tint state
        }
    }

    // Plain single-material presentation of a centered geometry: the height
    // tint below, or flat steel-blue when the tint is off.
    _plainMesh(geometry) {
        geometry.computeBoundingBox();
        const pos = geometry.attributes.position;
        const zmin = geometry.boundingBox.min.z;
        const zRange = Math.max(1e-9, geometry.boundingBox.max.z - zmin);

        // Height tint: dark at the bottom, light (warm) at the top — the relief
        // stays readable on the base plate even with a single material. The tone
        // boundary is the median of the vertex height distribution: for a stamp
        // it lands exactly between the bulk of the base plate and the bulk of
        // the relief, however thin the relief is (1 mm above the plate still
        // separates with full contrast).
        const BINS = 256;
        const hist = new Uint32Array(BINS);
        for (let i = 0; i < pos.count; i++) {
            hist[Math.min(BINS - 1, Math.floor((pos.getZ(i) - zmin) / zRange * BINS))]++;
        }
        let acc = 0, medianBin = 0;
        const half = pos.count / 2;
        for (let b = 0; b < BINS; b++) {
            acc += hist[b];
            if (acc >= half) { medianBin = b; break; }
        }
        const mid = (medianBin + 0.5) / BINS;
        const band = 0.05; // half-width of the soft transition (fraction of the range)

        const low = new THREE.Color(0x4d5a70);   // base plate
        const high = new THREE.Color(0xd9b380);  // relief
        const colors = new Float32Array(pos.count * 3);
        const c = new THREE.Color();
        for (let i = 0; i < pos.count; i++) {
            const t = (pos.getZ(i) - zmin) / zRange;
            const s = t <= mid - band ? 0 : t >= mid + band ? 1 : (t - (mid - band)) / (2 * band);
            const k = s * s * (3 - 2 * s);
            c.copy(low).lerp(high, k);
            colors[i * 3] = c.r;
            colors[i * 3 + 1] = c.g;
            colors[i * 3 + 2] = c.b;
        }
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

        const material = new THREE.MeshStandardMaterial({
            vertexColors: this.tintOn, metalness: 0.15, roughness: 0.55,
            wireframe: this.wireframeOn,
        });
        if (!this.tintOn) material.color.set(0x8fa8bf);
        // 3MF-sourced geometry has no normals; on non-indexed geometry
        // (both paths) this yields per-face normals — the faceted CSG look.
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2; // in OpenSCAD the Z axis points up
        return mesh;
    }

    // Common tail of both paths: swap the scene contents, fit the grid and
    // the camera, update the stats line.
    _show(objects, size, maxDim, triangles) {
        for (const o of this.objects) {
            this.scene.remove(o);
            o.traverse((n) => n.geometry?.dispose?.());
        }
        if (this.grid) this.scene.remove(this.grid);
        this.objects = objects;
        for (const o of objects) this.scene.add(o);

        // Grid with a fixed 10 mm step (5 mm for small models),
        // so the cells can be used as a ruler.
        const cell = maxDim >= 50 ? 10 : 5;
        const span = Math.ceil((maxDim * 2.2) / cell) * cell;
        this.grid = new THREE.GridHelper(span, span / cell, 0x3a4050, 0x262b33);
        this.grid.position.y = -size.z / 2;
        this.scene.add(this.grid);

        this.camera.near = maxDim / 100;
        this.camera.far = maxDim * 100;
        this.camera.updateProjectionMatrix();
        if (this.lastMaxDim) {
            // Re-render: keep the camera orientation and relative zoom,
            // rescaling the distance to fit the new model size.
            const scale = maxDim / this.lastMaxDim;
            this.camera.position.copy(
                this.camera.position.clone().sub(this.controls.target)
                    .multiplyScalar(scale));
        } else {
            this.camera.position.set(maxDim * 1.1, maxDim * 0.85, maxDim * 1.35);
        }
        this.lastMaxDim = maxDim;
        this.controls.target.set(0, 0, 0);
        this.controls.update();

        this.hint.style.display = "none";
        this.stats.textContent =
            `${triangles.toLocaleString("en-US")} triangles · ` +
            `size ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)} mm · ` +
            `grid ${cell} mm`;
    }

    resize() {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }
}
