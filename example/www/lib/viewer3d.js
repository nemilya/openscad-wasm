// Shared STL 3D viewer for the example pages (viewer.html, heightmap.html).
// Creates a canvas, a hint and a stats line in the container; on repeated
// showSTL() calls it keeps the camera orientation, rescaling the distance
// to fit the new model size.
import * as THREE from "three";
import { STLLoader } from "../vendor/STLLoader.js";
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
        this.mesh = null;
        this.grid = null;
        this.material = null;

        new ResizeObserver(() => this.resize()).observe(container);
        this.resize();

        this.renderer.setAnimationLoop(() => {
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        });
    }

    set wireframe(on) {
        this.wireframeOn = on;
        if (this.material) this.material.wireframe = on;
    }

    // Height tint (toggle without regenerating geometry).
    set tint(on) {
        this.tintOn = on;
        if (this.material) {
            this.material.vertexColors = on;
            this.material.color.set(on ? 0xffffff : 0x8fa8bf);
            this.material.needsUpdate = true;
        }
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

        if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
        if (this.grid) this.scene.remove(this.grid);

        // Height tint: dark at the bottom, light (warm) at the top — the relief
        // stays readable on the base plate even with a single material. The tone
        // boundary is the median of the vertex height distribution: for a stamp
        // it lands exactly between the bulk of the base plate and the bulk of
        // the relief, however thin the relief is (1 mm above the plate still
        // separates with full contrast).
        const pos = geometry.attributes.position;
        const zmin = geometry.boundingBox.min.z;
        const zRange = Math.max(1e-9, geometry.boundingBox.max.z - zmin);
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

        this.material = new THREE.MeshStandardMaterial({
            vertexColors: this.tintOn, metalness: 0.15, roughness: 0.55,
            wireframe: this.wireframeOn,
        });
        if (!this.tintOn) this.material.color.set(0x8fa8bf);
        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.rotation.x = -Math.PI / 2; // in OpenSCAD the Z axis points up
        this.scene.add(this.mesh);

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
        const triangles = geometry.attributes.position.count / 3;
        this.stats.textContent =
            `${triangles.toLocaleString("en-US")} triangles · ` +
            `size ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)} mm · ` +
            `grid ${cell} mm`;
        return { triangles, size };
    }

    resize() {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }
}
